import { ProviderError } from '../../core/errors.js';
import { FetchHttpTransport } from '../../core/transport.js';
import type { HttpTransport } from '../../core/transport.js';
import { compactPricing, normalizeContextWindow, normalizeModalities, perMillionPrice } from '../../core/pricing.js';
import { AnthropicAdapter } from '../anthropic/index.js';
import { OpenAICompatibleAdapter } from '../openai-compatible/index.js';
import { zenConversationSeed, zenContractSatisfied, zenFreeTierHeaders, zenPlaceholderTool, zenSessionId } from '../zen/zen-free-tier.js';
import { parseSseStream } from '../../core/streaming.js';
import type { ChatChunk, ChatRequest, ChatResponse, CredentialValidation, Model, ProviderAdapter, ProviderCredential, ProviderHealth, ProviderRequestContext } from '../../core/types.js';

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
  grantType: 'urn:ietf:params:oauth:grant-type:device_code',
} as const;

export const opencodeConsoleProviderId = 'opencode-console';

/** One entry of the Console's model config, which carries name, limits and prices. */
type ConsoleModelConfig = {
  name?: string;
  provider?: { api?: string };
  modalities?: { input?: unknown; output?: unknown };
  limit?: { context?: unknown; output?: unknown };
  /** Quoted per 1M tokens, unlike OpenRouter's per-token strings. */
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown };
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
};

export class OpencodeConsoleAdapter implements ProviderAdapter {
  readonly id = opencodeConsoleProviderId;
  readonly name = 'OpenCode Console';
  readonly capabilities = { chat: true, streaming: true, models: true } as const;

  private readonly transport: HttpTransport;
  private readonly onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  private readonly now: () => number;
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
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const credential = await this.credential(context);
    const lanes = await this.resolveLanes(credential, context.signal);
    return [...lanes.byModel.keys()]
      .filter((id) => id.length > 0)
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
    if (this.isFreeModel(request.model)) {
      let text = '';
      let finishReason: ChatResponse['finishReason'] | undefined;
      let responseId = '';
      for await (const chunk of this.streamFree(request, context)) {
        responseId = chunk.id || responseId;
        if (chunk.delta?.content) text += chunk.delta.content;
        if (chunk.finishReason) finishReason = chunk.finishReason;
      }
      return {
        id: responseId || `opencode-${request.model}`,
        providerId: this.id,
        model: request.model,
        createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: text },
        finishReason: finishReason ?? 'stop',
      };
    }
    const { lane, orgId } = await this.laneFor(request.model, context);
    const adapter = this.laneAdapter(lane, orgId);
    if (!adapter.chat) throw this.laneUnsupported(lane);
    return adapter.chat(request, { ...context, credential: this.laneCredential(await this.credential(context)) });
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
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
   */
  private async *streamFree(request: ChatRequest, context: ProviderRequestContext): AsyncIterable<ChatChunk> {
    const id = request.model.includes('/') ? request.model.slice(request.model.lastIndexOf('/') + 1) : request.model;
    const credential = await this.credential(context);
    // The lane comes from the same config the lanes use, so a free model is posted to the URL the console
    // serves it on, and the org is resolved the same way. A hardcoded public route is not one the console answers.
    const lanes = await this.resolveLanes(credential, context.signal);
    const lane = lanes.byModel.get(id) ?? lanes.base;
    if (!lane) throw this.laneUnsupported(id);
    const seed = zenConversationSeed(request);
    const headers = { ...this.headers(credential), ...zenFreeTierHeaders(zenSessionId(seed)) };
    const body: Record<string, unknown> = {
      model: id,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
      stream: true,
      // The caller's tools when there are any; the placeholder otherwise, because an empty array is refused.
      tools: request.tools && request.tools.length > 0 ? request.tools : [zenPlaceholderTool()],
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    };
    if (!zenContractSatisfied(headers, body)) {
      throw new ProviderError('INVALID_REQUEST', 'The free-tier request contract is not satisfied.', { providerId: this.id });
    }
    const events = this.transport.stream({
      method: 'POST',
      providerId: this.id,
      url: `${lane.replace(/\/$/, '')}/chat/completions`,
      headers: { ...headers, accept: 'text/event-stream' },
      body: JSON.stringify(body),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    let opened = false;
    for await (const event of parseSseStream(events)) {
      if (event.data.trim() === '[DONE]') return;
      opened = true;
      let chunk: { id?: string; choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>; error?: { message?: string } };
      try {
        chunk = JSON.parse(event.data);
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError('PROVIDER_REQUEST_FAILED', chunk.error.message ?? 'OpenCode refused the free request.', { providerId: this.id });
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield { id: chunk.id ?? `opencode-${id}`, providerId: this.id, model: id, delta: { content: delta } };
      const finish = chunk.choices?.[0]?.finish_reason;
      if (finish) yield { id: chunk.id ?? `opencode-${id}`, providerId: this.id, model: id, delta: {}, finishReason: finish === 'length' ? 'length' : 'stop' };
    }
    if (!opened) throw new ProviderError('PROVIDER_REQUEST_FAILED', 'OpenCode answered the free request with no stream.', { providerId: this.id });
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

  private headers(credential: ProviderCredential | undefined): Record<string, string> {
    const org = orgHeaderValue(credential);
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      Authorization: `Bearer ${bearer(credential)}`,
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
