import { ProviderError } from '../lib/errors.js';
import { FetchHttpTransport } from '../lib/transport.js';
import type { HttpTransport } from '../lib/transport.js';
import { compactPricing, normalizeContextWindow, normalizeModalities, perMillionPrice } from '../lib/pricing.js';
import { AnthropicAdapter } from '../lib/anthropic.js';
import { OpenAICompatibleAdapter } from '../lib/openai-compatible.js';
import { zenConversationSeed, zenContractSatisfied, isZenFreeTierRefusalError, zenFreeTierRefusal, zenSessionId, zenGatedToolChoice, zenUserAgent } from '../lib/zen-free-tier.js';
import { gatedTools } from '../lib/zen-adapter.js';
import { parseSseStream } from '../lib/streaming.js';
import type { ChatChunk, ChatRequest, ChatResponse, CredentialValidation, Model, ProviderAdapter, ProviderCredential, ProviderHealth, ProviderRequestContext, ToolCall } from '../lib/types.js';

/**
 * OpenCode Console is the credential that reaches OpenCode's free Zen models. An API
 * key is refused by every lane with `OpenCode's free tier can only be used from within
 * OpenCode`, so this provider signs in through the same device flow the OpenCode client
 * runs for itself.
 *
 * A signed-in session also changes the endpoints. `GET /api/config` returns the live
 * provider config, and its base URL is not the public `/zen/v1` one: the catalog is
 * served from `/inference/openai/v1`, `/inference/anthropic/v1` and
 * `/inference/google/v1beta`, with a different subset of models on each. Which lane a
 * model uses is therefore a property of the model, read from the server rather than
 * hardcoded here.
 */
export const OPENCODE_CONSOLE = {
  server: 'https://console.opencode.ai',
  /**
   * The Console serves its API from `server` but its web pages from `opencode.ai`.
   * `verification_uri` comes back relative, and joining it to the API host produces
   * `/console/console/device`, which renders a blank page.
   */
  webOrigin: 'https://opencode.ai',
  clientId: 'opencode-cli',
  deviceCodePath: '/auth/device/code',
  deviceTokenPath: '/auth/device/token',
  userPath: '/api/user',
  orgsPath: '/api/orgs',
  configPath: '/api/config',
  /**
   * The entitlement view. `/api/v2/config` is what the installed client reads
   * (`packages/core/src/plugin/provider/opencode.ts` → `GET ${server}/api/v2/config`), and unlike v1
   * it marks each model the account **cannot** use with `disabled: true` — which is why a signed-in
   * account sees `402 Insufficient balance` on a model the catalog still advertises. v1 stays the
   * source of the lane URL; v2 is the source of the entitlement.
   */
  configV2Path: '/api/v2/config',
  /**
   * The OpenCode provider id inside the local service. The gateway strips the gateway-side prefix
   * before an adapter sees a model (`opc/deepseek-v4.1-flash-free` → `deepseek-v4.1-flash-free`), and
   * the service wants the reference back: `opencode/deepseek-v4.1-flash-free`.
   */
  serviceProviderId: 'opencode',
  grantType: 'urn:ietf:params:oauth:grant-type:device_code',
} as const;

export const opencodeConsoleProviderId = 'opencode-console';

/**
 * Where free models are actually served.
 *
 * The Console's resolved lane is `https://opencode.ai/inference/<vendor>/v1` — the **paid,
 * session-authenticated** path. Posting a `*-free` model there is what earns:
 *
 * > OpenCode's free tier can only be used from within OpenCode
 *
 * and no amount of header or token work fixes it, because the request is on the wrong endpoint.
 * Free models live on `https://opencode.ai/zen/v1`, which is the path the Zen adapter already uses
 * and the one the reference posts to (`open-sse/executors/opencode.js:454`).
 */
const FREE_LANE = 'https://opencode.ai/zen/v1/chat/completions';

/** One entry of the Console's model config, which carries name, limits and prices. */
type ConsoleModelConfig = {
  name?: string;
  provider?: { api?: string };
  modalities?: { input?: unknown; output?: unknown };
  limit?: { context?: unknown; output?: unknown };
  /** Quoted per 1M tokens, unlike OpenRouter's per-token strings. */
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown };
  /** v2 only: the account cannot use this model (no credit, or the plan excludes it). */
  disabled?: unknown;
};

type ConsoleConfig = {
  config?: {
    provider?: {
      opencode?: {
        api?: string;
        options?: { headers?: Record<string, string> };
        models?: Record<string, ConsoleModelConfig>;
      };
    };
  };
};

/** `/api/v2/config`: the entitlement view, the same document the installed client reads. */
type ConsoleConfigV2 = {
  providers?: {
    opencode?: {
      headers?: Record<string, string>;
      models?: Record<string, ConsoleModelConfig>;
    };
  };
};

/** The lane layout, as the server describes it. */
type ConsoleLanes = {
  /** Default base for models the server does not override. */
  base: string;
  /** Per-model overrides, keyed by model id. */
  byModel: Map<string, string>;
  /** The catalog entries, keyed by model id, for names, limits and prices. */
  entries: Map<string, ConsoleModelConfig>;
  orgId?: string;
};

const configTtlMs = 10 * 60_000;

/** True when the lane speaks the Anthropic Messages shape. */
function isAnthropicLane(lane: string) {
  return lane.includes('/inference/anthropic/');
}

/** True when the lane speaks the Google GenAI shape. */
function isGoogleLane(lane: string) {
  return lane.includes('/inference/google/');
}

/**
 * Turns a Console catalog entry into a model record.
 *
 * The Console is the only catalog we read that states prices, limits and modalities
 * together, and it quotes per 1M tokens where OpenRouter quotes per token.
 */
export function describeConsoleModel(id: string, entry: ConsoleModelConfig | undefined, providerId: string): Model {
  const displayName = typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 200) : undefined;
  const contextWindow = normalizeContextWindow(entry?.limit?.context);
  const inputModalities = normalizeModalities(entry?.modalities?.input);
  const outputModalities = normalizeModalities(entry?.modalities?.output);
  const cost = entry?.cost;
  const inputPer1M = perMillionPrice(cost?.input);
  const outputPer1M = perMillionPrice(cost?.output);
  const cacheReadPer1M = perMillionPrice(cost?.cache_read);
  const cacheWritePer1M = perMillionPrice(cost?.cache_write);
  const pricing = compactPricing({
    ...(inputPer1M === undefined ? {} : { inputPer1M }),
    ...(outputPer1M === undefined ? {} : { outputPer1M }),
    ...(cacheReadPer1M === undefined ? {} : { cacheReadPer1M }),
    ...(cacheWritePer1M === undefined ? {} : { cacheWritePer1M }),
  });
  return {
    id,
    providerId,
    ...(displayName ? { displayName } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
    ...(pricing ? { pricing } : {}),
  };
}

/**
 * The finish reason as the SDK names it. A tool-call finish must stay `tool_calls`: collapsing it to `stop`
 * tells the caller the answer is complete when the model is waiting for a tool result.
 */
function normalizeFinish(reason: string): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  if (reason === 'length' || reason === 'tool_calls' || reason === 'content_filter') return reason;
  if (reason === 'function_call') return 'tool_calls';
  return 'stop';
}

function orgHeaderValue(credential: ProviderCredential | undefined): string | undefined {
  return credential?.type === 'oauth' ? credential.orgId : undefined;
}

function bearer(credential: ProviderCredential | undefined): string {
  if (!credential || credential.type === 'none') return '';
  return credential.value ?? '';
}

/**
 * Exchanges a refresh token for a new access token.
 *
 * The Console refresh grant takes the same path as the device grant, distinguished only
 * by `grant_type`, and answers 200 with the token pair.
 */
export async function refreshOpencodeConsoleCredential(
  credential: ProviderCredential,
  transport: HttpTransport = new FetchHttpTransport(),
): Promise<ProviderCredential> {
  if (credential.type !== 'oauth' || !credential.refreshToken) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'This OpenCode Console session cannot be renewed. Sign in again.', {
      providerId: opencodeConsoleProviderId,
      publicMessage: 'This OpenCode Console session cannot be renewed. Sign in again.',
    });
  }
  const response = await transport.request<Record<string, unknown>>({
    method: 'POST',
    providerId: opencodeConsoleProviderId,
    url: `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.deviceTokenPath}`,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: OPENCODE_CONSOLE.clientId,
    }),
  });
  const access = response.data?.access_token;
  if (typeof access !== 'string' || !access) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'OpenCode Console did not return a renewed session. Sign in again.', {
      providerId: opencodeConsoleProviderId,
      publicMessage: 'OpenCode Console did not return a renewed session. Sign in again.',
    });
  }
  const expiresIn = typeof response.data?.expires_in === 'number' ? response.data.expires_in : undefined;
  const rotated = typeof response.data?.refresh_token === 'string' ? response.data.refresh_token : undefined;
  return {
    type: 'oauth',
    value: access,
    ...(rotated ? { refreshToken: rotated } : credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
    ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }),
    ...(credential.email ? { email: credential.email } : {}),
    ...(credential.orgId ? { orgId: credential.orgId } : {}),
    ...(credential.orgName ? { orgName: credential.orgName } : {}),
    ...(credential.accountId ? { accountId: credential.accountId } : {}),
  };
}

/** True when the access token is at or past expiry, with a minute of slack. */
export function opencodeConsoleCredentialExpired(credential: ProviderCredential | undefined, now = Date.now()): boolean {
  if (credential?.type !== 'oauth' || !credential.expiresAt) return false;
  const expiry = Date.parse(credential.expiresAt);
  return Number.isFinite(expiry) && expiry - 60_000 <= now;
}

export type OpencodeConsoleAdapterOptions = {
  transport?: HttpTransport;
  /** Called with a renewed credential so the caller can persist it. */
  onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  now?: () => number;
  /**
   * Runs a turn through the OpenCode app's own local service.
   *
   * The Console's free tier answers `429 FreeUsageLimitError` to a direct request from this machine,
   * from Node **and** from Bun, with the account's credential and the client's own headers — while the
   * app serves the same model seconds later. The service is the transport that qualifies, so when it is
   * present the turn goes through it. Supplied by the gateway (which can read the filesystem); the SDK
   * stays browser-safe. A service that is not running throws with `name: 'OpencodeServiceUnavailable'`,
   * and the turn falls back to the direct lane so the Console's own refusal is still reported.
   */
  localService?: {
    turn(input: { model: string; text: string; signal?: AbortSignal }): Promise<{ text: string; reasoning?: string; finish?: string; model?: string }>;
  };
};

export class OpencodeConsoleAdapter implements ProviderAdapter {
  readonly id = opencodeConsoleProviderId;
  readonly name = 'OpenCode Console';
  readonly capabilities = { chat: true, streaming: true, models: true } as const;

  private readonly transport: HttpTransport;
  private readonly onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  private readonly now: () => number;
  private readonly localService?: OpencodeConsoleAdapterOptions['localService'];
  /** Lanes keyed by the access token they were read with, so a renewal invalidates them. */
  private lanes = new Map<string, { at: number; lanes: ConsoleLanes }>();
  /** Renewed credentials, keyed by the token they replaced. */
  private renewed = new Map<string, ProviderCredential>();
  /** The account's org id, keyed by access token. It does not change. */
  private orgIds = new Map<string, string>();

  constructor(options: OpencodeConsoleAdapterOptions = {}) {
    this.transport = options.transport ?? new FetchHttpTransport();
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.now = options.now ?? (() => Date.now());
    this.localService = options.localService;
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const credential = await this.credential(context);
    const lanes = await this.resolveLanes(credential, context.signal);
    return [...lanes.byModel.keys()]
      // A model the Console marks `disabled` for this account is not an option: the client hides it and
      // every request to it answers `402 Insufficient balance`. Offering it is what made the card look
      // like a working catalog whose turns fail.
      .filter((id) => id.length > 0 && lanes.entries.get(id)?.disabled !== true)
      .map((id) => describeConsoleModel(id, lanes.entries.get(id), this.id));
  }

  /**
   * Reads `/api/user`, which is free and never bills, so a health check costs nothing
   * and still proves the session is live.
   */
  async validateCredential(credential: ProviderCredential | undefined): Promise<CredentialValidation> {
    if (credential?.type === 'none' || !bearer(credential)) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Sign in to OpenCode Console to use this provider.', {
        providerId: this.id,
        publicMessage: 'Sign in to OpenCode Console to use this provider.',
      });
    }
    const response = await this.transport.request<{ id?: string; email?: string }>({
      method: 'GET',
      providerId: this.id,
      url: `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.userPath}`,
      headers: this.headers(credential),
    });
    return { status: 'valid', checkedAt: new Date().toISOString(), ...(response.data?.email ? { account: response.data.email } : {}) };
  }

  /**
   * OpenCode's free models answer `403 FreeTierError` unless the request carries the free-tier contract:
   * a streaming body, a declared tool, a session header and an `opencode/` client version. The lane
   * adapters send none of those, so a `-free` model is routed through the contract instead. Paid models
   * are not gated and keep their lane.
   */
  private isFreeModel(model: string): boolean {
    const id = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
    return /-free$/.test(id);
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const turn = await this.localTurn(request, context);
    if (turn) {
      return {
        id: `opencode-service-${this.now().toString(36)}`,
        providerId: this.id,
        model: turn.model ?? request.model,
        createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: turn.text },
        finishReason: turn.finish === 'tool_calls' ? 'tool_calls' : 'stop',
      };
    }
    if (this.isFreeModel(request.model)) {
      let text = '';
      let finishReason: ChatResponse['finishReason'] | undefined;
      let responseId = '';
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      for await (const chunk of this.streamFree(request, context)) {
        responseId = chunk.id || responseId;
        if (chunk.delta?.content) text += chunk.delta.content;
        for (const delta of chunk.delta?.toolCalls ?? []) {
          const call = toolCalls.get(delta.index) ?? { id: delta.id ?? `call_${delta.index}`, name: '', arguments: '' };
          if (delta.id) call.id = delta.id;
          if (delta.function?.name) call.name = delta.function.name;
          if (delta.function?.arguments) call.arguments += delta.function.arguments;
          toolCalls.set(delta.index, call);
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
      }
      const calls: ToolCall[] = [...toolCalls.values()].map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } }));
      return {
        id: responseId || `opencode-${request.model}`,
        providerId: this.id,
        model: request.model,
        createdAt: new Date().toISOString(),
        // The streaming path emitted tool calls and this aggregation only summed text, so a free model
        // asked for a tool returned `finishReason: 'tool_calls'` with `content: ''` and nothing to act on.
        message: { role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) },
        finishReason: finishReason ?? 'stop',
      };
    }
    const { lane, orgId } = await this.laneFor(request.model, context);
    const adapter = this.laneAdapter(lane, orgId);
    if (!adapter.chat) throw this.laneUnsupported(lane);
    return adapter.chat(request, { ...context, credential: this.laneCredential(await this.credential(context)) });
  }

  /**
   * One turn through the OpenCode app's local service, or `undefined` when it is not running.
   *
   * Only "not running" falls through to the direct lane. A turn that started and failed reports its own
   * failure: retrying it on the direct lane would replace a real error with the free-tier refusal this
   * network always gets.
   */
  private async localTurn(request: ChatRequest, context: ProviderRequestContext): Promise<{ text: string; reasoning?: string; finish?: string; model?: string } | undefined> {
    if (!this.localService) return undefined;
    try {
      // The gateway hands an adapter a bare model id, so the reference the service wants is rebuilt
      // here: `opc/deepseek-v4.1-flash-free` arrives as `deepseek-v4.1-flash-free` and leaves as
      // `opencode/deepseek-v4.1-flash-free`.
      const bare = request.model.includes('/') ? request.model.slice(request.model.lastIndexOf('/') + 1) : request.model;
      return await this.localService.turn({
        model: `${OPENCODE_CONSOLE.serviceProviderId}/${bare}`,
        text: flattenForService(request.messages),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      if ((error as { name?: string } | undefined)?.name === 'OpencodeServiceUnavailable') return undefined;
      throw error;
    }
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    // The service runs a whole turn and returns its text, so a stream through it is that answer
    // delivered as one delta. The free tier is what matters here; token-by-token is the direct lane's
    // property, and that lane refuses this network.
    const turn = await this.localTurn(request, context);
    if (turn) {
      const id = `opencode-service-${this.now().toString(36)}`;
      const model = turn.model ?? request.model;
      if (turn.reasoning) yield { id, providerId: this.id, model, delta: { reasoning: turn.reasoning } };
      yield { id, providerId: this.id, model, delta: { role: 'assistant', content: turn.text } };
      yield { id, providerId: this.id, model, delta: {}, finishReason: turn.finish === 'tool_calls' ? 'tool_calls' : 'stop' };
      return;
    }
    if (this.isFreeModel(request.model)) {
      yield* this.streamFree(request, context);
      return;
    }
    const { lane, orgId } = await this.laneFor(request.model, context);
    const adapter = this.laneAdapter(lane, orgId);
    if (!adapter.streamChat) throw this.laneUnsupported(lane);
    yield* adapter.streamChat(request, { ...context, credential: this.laneCredential(await this.credential(context)) });
  }

  /**
   * One gated request for a free model: the free-tier contract applied, stream requested, the answer read
   * back as chunks. The client identity and session come from the shared Zen contract helpers, so the two
   * adapters cannot drift on what OpenCode accepts.
  /**
   * A gated request for a free model, on the lane that actually serves free models.
   *
   * ## What was wrong
   *
   * This posted to the Console's resolved lane — `https://opencode.ai/inference/<vendor>/v1`, the
   * paid, session-authenticated path — carrying the account's own token. Every free model came back
   * "OpenCode's free tier can only be used from within OpenCode", which reads like a missing client and
   * is not one. Two things were wrong at once:
   *
   * - **The endpoint.** Free models are served on `https://opencode.ai/zen/v1`; the reference posts
   *   there (`open-sse/executors/opencode.js:454`), as does this repository's own Zen adapter.
   * - **The token.** That lane takes the literal `Bearer public` (`open-sse/executors/opencode.js:476`),
   *   the same value this adapter's health probe already sends successfully.
   *
   * A token fallback alone could not have fixed it, because the request was on the wrong URL.
   */
  private async *streamFree(request: ChatRequest, context: ProviderRequestContext): AsyncIterable<ChatChunk> {
    yield* this.streamFreeOnce(request, context);
  }

  /**
   * The gated request itself: the free-tier contract, the public token, and the lane that serves
   * free models. See streamFree for why those three together are the whole difference.
   */
  private async *streamFreeOnce(request: ChatRequest, context: ProviderRequestContext): AsyncIterable<ChatChunk> {
    const id = request.model.includes('/') ? request.model.slice(request.model.lastIndexOf('/') + 1) : request.model;
    const credential = await this.credential(context);
    const seed = zenConversationSeed(request);
    // Exactly the reference's header set, and nothing more.
    //
    // This previously also sent `x-opencode-project` and `x-opencode-request`, the latter shaped
    // `ses_…` where the reference derives a `msg_…`. Neither had been isolated: an earlier probe
    // that varied the headers used `Bearer public`, which this host is refused for **on every
    // model**, so it could not tell a bad header from a bad token. Dropping the difference leaves
    // one variable, and it is the one the reference actually sends.
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      Authorization: `Bearer ${bearer(credential)}`,
      'user-agent': zenUserAgent(),
      'x-opencode-client': 'desktop',
      'x-opencode-session': zenSessionId(seed),
    };
    const body: Record<string, unknown> = {
      model: id,
      // A tool result carries the id of the call it answers; without it the model cannot match them (as in Kimi).
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      })),
      stream: true,
      // The caller's tools with the free-tier quartet appended where missing; never removed to make room.
      tools: gatedTools(request.tools),
      // Free models accept only "auto" (opencode-free-tool-choice.test.js); stating it is part of the
      // fingerprint, not a preference — see zenGatedToolChoice.
      tool_choice: zenGatedToolChoice((request.tools ?? []).length > 0),
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    };
    // Computed once and kept: the refusal below quotes it, so "what we sent" is a fact this method
    // established rather than an assumption made while formatting an error.
    const satisfied = zenContractSatisfied(headers, body);
    if (!satisfied) {
      throw new ProviderError('INVALID_REQUEST', 'The free-tier request contract is not satisfied.', { providerId: this.id });
    }
    const events = this.transport.stream({
      method: 'POST',
      providerId: this.id,
      url: FREE_LANE,
      headers: { ...headers, accept: 'text/event-stream' },
      body: JSON.stringify(body),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    let opened = false;
    let sawDone = false;
    // A free-tier refusal usually arrives as an HTTP error, not as an SSE frame — the transport
    // raises before the loop starts, so the branch inside it never runs. Without this the operator
    // is shown OpenCode's marketing text and told the gateway failed unexpectedly: the two erasures
    // this adapter had once.
    try {
    for await (const event of parseSseStream(events)) {
      if (event.data.trim() === '[DONE]') {
        sawDone = true;
        break;
      }
      opened = true;
      let chunk: { id?: string; choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>; error?: { message?: string } };
      try {
        chunk = JSON.parse(event.data);
      } catch {
        continue;
      }
      // The contract was verified above, so the refusal names what was sent rather than repeating
      // OpenCode's marketing text as though it were a diagnosis.
      if (chunk.error) throw zenFreeTierRefusal({ providerId: this.id, model: id, label: 'OpenCode', contractSatisfied: satisfied, gated: /freetiererror|free tier/i.test(chunk.error.message ?? ''), providerReason: chunk.error.message });
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield { id: chunk.id ?? `opencode-${id}`, providerId: this.id, model: id, delta: { content: delta } };
      const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
      if (toolCalls?.length) {
        yield {
          id: chunk.id ?? `opencode-${id}`,
          providerId: this.id,
          model: id,
          delta: {
            toolCalls: toolCalls.map((toolCall) => ({
              index: toolCall.index ?? 0,
              ...(toolCall.id ? { id: toolCall.id } : {}),
              ...(toolCall.type ? { type: 'function' as const } : {}),
              ...(toolCall.function?.name || toolCall.function?.arguments ? { function: {
                ...(toolCall.function.name ? { name: toolCall.function.name } : {}),
                ...(toolCall.function.arguments ? { arguments: toolCall.function.arguments } : {}),
              } } : {}),
            })),
          },
        };
      }
      const finish = chunk.choices?.[0]?.finish_reason;
      if (finish) {
        sawDone = true;
        yield { id: chunk.id ?? `opencode-${id}`, providerId: this.id, model: id, delta: {}, finishReason: normalizeFinish(finish) };
      }
    }
    } catch (error) {
      // The transport's own refusal carries the provider's text but no public message, so it reaches
      // the operator as the generic sentence plus OpenCode's marketing line. Translate it here, where
      // the contract is known to have been satisfied.
      if (isZenFreeTierRefusalError(error)) {
        throw zenFreeTierRefusal({
          providerId: this.id,
          model: id,
          label: 'OpenCode',
          contractSatisfied: satisfied,
          gated: true,
          ...((error as { details?: { providerReason?: string } }).details?.providerReason
            ? { providerReason: (error as { details: { providerReason: string } }).details.providerReason }
            : {}),
        });
      }
      throw error;
    }
    if (!opened) throw new ProviderError('PROVIDER_REQUEST_FAILED', 'OpenCode answered the free request with no stream.', { providerId: this.id });
    if (!sawDone) throw new ProviderError('INVALID_RESPONSE', 'The provider stream ended before completion.', { providerId: this.id });
  }

  /**
   * The lane adapters accept a bare token and reject anything else, so an OAuth access
   * token is handed across in the shape they take. Their credential contract is left
   * alone rather than widened for one caller.
   */
  private laneCredential(credential: ProviderCredential): ProviderCredential {
    if (!credential || credential.type === 'none') return { type: 'none' };
    return { type: 'api-key', value: credential.value };
  }

  private laneUnsupported(lane: string) {
    return new ProviderError('NOT_SUPPORTED', `No adapter speaks the OpenCode Console lane ${lane}.`, {
      providerId: this.id,
      publicMessage: 'That OpenCode Console model is served from a lane this gateway does not implement yet.',
    });
  }

  /**
   * `credential`, not `inference`, and that word is the fix.
   *
   * Reading `/api/user` proves the session is live, which is a real and useful thing — but "the session
   * is live" is not "a model can answer". Measured on this connection: every free model is refused with
   * `FreeTierError` and `gpt-5-mini` with `Model is unavailable`, while `/api/user` answers happily and
   * the dashboard shows a green `healthy`.
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    try {
      await this.validateCredential(context.credential);
      return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'credential',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The OpenCode Console session could not be checked.',
      };
    }
  }

  /**
   * Renews the session when it is at or past expiry, then persists the result. A
   * failure here is a sign-in problem, not a provider problem, so it is raised as one.
   *
   * A request resolves the credential more than once — once to read the lanes and once
   * to send — so a renewal is memoised against the token it replaced. Without that, one
   * request would burn two refresh grants and the second would invalidate the first.
   */
  private async credential(context: ProviderRequestContext): Promise<ProviderCredential> {
    const current = context.credential;
    if (!opencodeConsoleCredentialExpired(current, this.now())) return current as ProviderCredential;
    const replaced = bearer(current);
    const memo = this.renewed.get(replaced);
    if (memo) return memo;
    const renewed = await refreshOpencodeConsoleCredential(current as ProviderCredential, this.transport);
    this.renewed.set(replaced, renewed);
    await this.onTokensRefreshed?.(renewed);
    return renewed;
  }

  private headers(credential: ProviderCredential | undefined, authorization?: string): Record<string, string> {
    const org = orgHeaderValue(credential);
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      // `authorization` overrides the account token with the literal public token. See `streamFree`.
      Authorization: `Bearer ${authorization ?? bearer(credential)}`,
      ...(org ? { 'x-opencode-org-id': org } : {}),
    };
  }

  private async resolveLanes(credential: ProviderCredential, signal?: AbortSignal): Promise<ConsoleLanes> {
    const key = bearer(credential);
    const cached = this.lanes.get(key);
    if (cached && this.now() - cached.at < configTtlMs) return cached.lanes;
    // `/api/config` refuses without an org: `400 {"code":"org_required"}`. A credential
    // saved before the org was captured would fail every read forever, so the org is
    // looked up from the account rather than assumed present.
    const orgId = orgHeaderValue(credential) ?? (await this.lookupOrgId(credential, signal));
    const response = await this.transport.request<ConsoleConfig>({
      method: 'GET',
      providerId: this.id,
      url: `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.configPath}`,
      headers: {
        ...this.headers(credential),
        ...(orgId ? { 'x-org-id': orgId } : {}),
      },
      ...(signal ? { signal } : {}),
    });
    const provider = response.data?.config?.provider?.opencode;
    const base = typeof provider?.api === 'string' ? provider.api : '';
    const byModel = new Map<string, string>();
    const entries = new Map<string, ConsoleModelConfig>();
    for (const [id, model] of Object.entries(provider?.models ?? {})) {
      if (!id) continue;
      const lane = model?.provider?.api;
      if (typeof lane === 'string' && lane) byModel.set(id, lane);
      else if (base) byModel.set(id, base);
      entries.set(id, model ?? {});
    }
    // The entitlement view (`/api/v2/config`), best effort. It is the document the installed client
    // reads, and the only one that marks a model `disabled` for this account; a Console that does not
    // serve it, or refuses it, must not take the lane catalog down with it.
    try {
      const version2 = await this.transport.request<ConsoleConfigV2>({
        method: 'GET',
        providerId: this.id,
        url: `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.configV2Path}`,
        headers: { ...this.headers(credential), ...(orgId ? { 'x-org-id': orgId } : {}) },
        ...(signal ? { signal } : {}),
      });
      for (const [id, model] of Object.entries(version2.data?.providers?.opencode?.models ?? {})) {
        if (!id || model?.disabled !== true) continue;
        const existing = entries.get(id);
        if (existing) existing.disabled = true;
        else entries.set(id, { disabled: true });
      }
    } catch {
      // No v2, or this credential cannot read it: the catalog is still usable from v1.
    }
    // The config names the header inference wants, which is spelled differently again.
    const inferenceOrgId = provider?.options?.headers?.['x-opencode-org-id'] ?? orgId;
    const lanes: ConsoleLanes = { base, byModel, entries, ...(inferenceOrgId ? { orgId: inferenceOrgId } : {}) };
    this.lanes.set(key, { at: this.now(), lanes });
    return lanes;
  }

  /**
   * The account's first org, which is the one the OpenCode client itself picks. Cached
   * per session because it does not change.
   */
  private async lookupOrgId(credential: ProviderCredential, signal?: AbortSignal): Promise<string | undefined> {
    const key = bearer(credential);
    const cached = this.orgIds.get(key);
    if (cached) return cached;
    const response = await this.transport.request<Array<{ id?: string; name?: string }>>({
      method: 'GET',
      providerId: this.id,
      url: `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.orgsPath}`,
      headers: this.headers(credential),
      ...(signal ? { signal } : {}),
    });
    const orgs = Array.isArray(response.data) ? response.data : [];
    const first = [...orgs]
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || (a.id ?? '').localeCompare(b.id ?? ''))[0];
    const id = typeof first?.id === 'string' ? first.id : undefined;
    if (id) this.orgIds.set(key, id);
    return id;
  }

  private async laneFor(model: string, context: ProviderRequestContext): Promise<{ lane: string; orgId?: string }> {
    const id = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
    const lanes = await this.resolveLanes(await this.credential(context), context.signal);
    const lane = lanes.byModel.get(id) ?? lanes.base;
    if (!lane) {
      throw new ProviderError('NOT_SUPPORTED', `OpenCode Console did not list a lane for ${model}.`, {
        providerId: this.id,
        publicMessage: `OpenCode Console did not list a lane for ${model}.`,
      });
    }
    if (isGoogleLane(lane)) {
      throw new ProviderError('NOT_SUPPORTED', `OpenCode Console serves ${model} from a Google GenAI lane, which this gateway does not implement.`, {
        providerId: this.id,
        publicMessage: `${model} is served from a Google GenAI lane, which this gateway does not implement yet.`,
      });
    }
    return { lane, ...(lanes.orgId ? { orgId: lanes.orgId } : {}) };
  }

  /**
   * Builds the adapter for a lane. The org header rides on the config rather than the
   * request, because that is the only place either adapter accepts extra headers.
   */
  private laneAdapter(lane: string, orgId: string | undefined): ProviderAdapter {
    const headers = orgId ? { 'x-opencode-org-id': orgId } : {} as Record<string, string>;
    if (isAnthropicLane(lane)) {
      return new AnthropicAdapter({
        // `AnthropicAdapter` appends `v1/messages` to the base it is given, and the
        // config's lane already ends in `/v1`. Passing it as-is asks for
        // `/inference/anthropic/v1/v1/messages`, which is a 404. The OpenAI lane does
        // not have this problem: the compatible adapter appends the whole chat path.
        baseUrl: lane.replace(/\/v1$/, ''),
        headers,
        transport: this.transport,
      });
    }
    return new OpenAICompatibleAdapter(
      {
        id: this.id,
        name: this.name,
        baseUrl: lane.replace(/\/chat\/completions$/, ''),
        auth: { header: 'Authorization', prefix: 'Bearer' },
        headers,
      },
      { transport: this.transport },
    );
  }
}

/**
 * Flattens a conversation into the single prompt the OpenCode local service takes.
 *
 * The service is an agent session, not a completion endpoint, so the roles have to survive as text —
 * the same limit the reference bridges ran into. A message whose content carries no text (an image
 * only, say) is dropped rather than sent as an empty turn.
 */
function flattenForService(messages: ChatRequest['messages']): string {
  const lines: string[] = [];
  for (const message of messages) {
    const content = message.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part as { text?: string })?.text ?? '').join('')
        : '';
    if (!text.trim()) continue;
    const label = message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : message.role === 'tool' ? 'Tool' : 'User';
    lines.push(`${label}: ${text}`);
  }
  return lines.join('\n\n');
}
