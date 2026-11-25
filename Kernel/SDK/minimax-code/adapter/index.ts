import { ProviderError } from '@omnihilbras/sdk-shared/errors';
import { parseSseJson, parseSseStream } from '@omnihilbras/sdk-shared/streaming';
import { FetchHttpTransport, type HttpTransport } from '../lib/transport.js';
import { boundedMap } from '@omnihilbras/sdk-shared/bounded-map';

import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  FinishReason,
  Model,
  CredentialValidation,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCredential,
  ProviderHealth,
  ProviderRequestContext,
  TokenUsage,
  ToolDefinition,
} from '../lib/types.js';

const maxRenewalMemoEntries = 64;

export const MINIMAX_CODE_SITES = {
  cn: { account: 'https://account.minimax.cn', agent: 'https://agent.minimax.cn' },
  global: { account: 'https://account.minimax.io', agent: 'https://agent.minimax.io' },
} as const;

export type MinimaxCodeSiteName = keyof typeof MINIMAX_CODE_SITES;

export const minimaxCodeProviderId = 'minimax-code';
export const minimaxCodeGlobalProviderId = 'minimax-code-global';

export type MinimaxCodeAdapterOptions = {
  transport?: HttpTransport;
  timeoutMs?: number;
  onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  now?: () => number;
  clientId?: string;
  scope?: string;
  audience?: string;
};

type DeviceCodeResponse = {
  user_code?: string;
  device_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expired_in?: number;
  expires_in?: number;
  interval?: number;
  status?: string;
  error?: string;
  error_description?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  status?: string;
  error?: string;
  error_description?: string;
};

type ModelItem = { id?: string; name?: string };

/**
 * The catalog MiniMax actually answers with, measured on 2026-11-19:
 *
 * ```json
 * { "version": "...", "ttlSeconds": 3600, "providers": [
 *   { "providerId": "minimax", "config": {
 *     "name": "MiniMax",
 *     "models": { "MiniMax-M3": { "name": "M3", "limit": { "context": 512000, "output": 128000 }, ... } },
 *     "model_order": ["MiniMax-M3", "MiniMax-M3.1-Flash"],
 *     "whitelist": ["MiniMax-M3", "MiniMax-M3.1-Flash"]
 *   } }
 * ] }
 * ```
 *
 * The adapter used to require `{ data: [{ id, name }] }`, so a live account read as "unreadable" and a
 * successful sign-in saved a connection with zero models. The legacy `data` array is still accepted,
 * because some lanes and older captures use it.
 */
type CatalogModelMeta = { name?: unknown; limit?: { context?: unknown; output?: unknown } };
type CatalogProvider = {
  providerId?: string;
  config?: {
    models?: Record<string, CatalogModelMeta>;
    model_order?: unknown;
    whitelist?: unknown;
  };
};
type CatalogBody = {
  data?: ModelItem[];
  models?: Record<string, CatalogModelMeta>;
  providers?: CatalogProvider[];
};

/**
 * Every model the body names, from any of the shapes MiniMax has used.
 *
 * `model_order` is the order its own client shows, so it is read first; ids present in `models` but
 * absent from the order still count. A non-empty `whitelist` is the account's entitlement, so it gates
 * the other two — a model the endpoint lists but the account may not run is not advertised.
 */
function catalogModels(providerId: string, body: CatalogBody): Model[] {
  const models: Model[] = [];
  const seen = new Set<string>();
  const add = (rawId: unknown, meta?: CatalogModelMeta) => {
    if (typeof rawId !== 'string' || !rawId || seen.has(rawId)) return;
    seen.add(rawId);
    const context = meta && typeof meta.limit === 'object' && meta.limit && typeof meta.limit.context === 'number'
      ? meta.limit.context
      : undefined;
    const maxOutput = meta && typeof meta.limit === 'object' && meta.limit && typeof meta.limit.output === 'number'
      ? meta.limit.output
      : undefined;
    const displayName = meta && typeof meta.name === 'string' && meta.name ? meta.name : undefined;
    models.push({
      id: rawId,
      providerId,
      ...(displayName ? { displayName } : {}),
      ...(context ? { contextWindow: context } : {}),
      ...(maxOutput ? { maxOutputTokens: maxOutput } : {}),
      source: 'provider' as const,
    });
  };

  if (Array.isArray(body.data)) for (const row of body.data) add(row?.id, row);

  for (const provider of Array.isArray(body.providers) ? body.providers : []) {
    const config = provider?.config;
    if (!config) continue;
    const table = config.models && typeof config.models === 'object' ? config.models : {};
    const whitelist = Array.isArray(config.whitelist)
      ? new Set(config.whitelist.filter((id): id is string => typeof id === 'string'))
      : undefined;
    const allowed = (id: string) => !whitelist || whitelist.size === 0 || whitelist.has(id);
    for (const id of Array.isArray(config.model_order) ? config.model_order : []) {
      if (typeof id === 'string' && allowed(id)) add(id, table[id]);
    }
    for (const [id, meta] of Object.entries(table)) if (allowed(id)) add(id, meta);
  }

  if (body.models && typeof body.models === 'object') {
    for (const [id, meta] of Object.entries(body.models)) add(id, meta);
  }
  return models;
}

type ClaudeOrOpenAiResponse = {
  id?: string;
  model?: string;
  created?: number;
  /** Claude Messages content blocks. */
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }> | string;
  stop_reason?: string | null;
  choices?: Array<{
    message?: { role?: string; content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
};

type StreamChunkShape = {
  id?: string;
  model?: string;
  type?: string;
  error?: { message?: string };
  /** Claude streaming events. */
  index?: number;
  delta?: { type?: string; text?: string; stop_reason?: string | null; partial_json?: string };
  content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
  choices?: Array<{
    delta?: { role?: string; content?: string | null; tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
};

const QUOTA_RE = /insufficient|balance|credit|quota|exhaust|limit|余额|积分|额度|不足|用完|上限/i;

class MinimaxCodeAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities = { chat: true, streaming: true, models: true };
  readonly modelFamily = 'claude';

  private readonly site: (typeof MINIMAX_CODE_SITES)[MinimaxCodeSiteName];
  private readonly transport: HttpTransport;
  private readonly onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  private readonly now: () => number;
  private readonly refreshLeadMs = 10 * 60 * 1000;
  private readonly clientId: string;
  private readonly scope: string;
  private readonly audience: string;
  private readonly renewed = boundedMap<string, ProviderCredential>(maxRenewalMemoEntries);
  /** One renewal per refresh token. MiniMax rotates single-use refresh tokens, so two posts lose one. */
  private readonly refreshing = new Map<string, Promise<ProviderCredential>>();

  constructor(providerId: string, siteName: MinimaxCodeSiteName, options: MinimaxCodeAdapterOptions = {}) {
    this.id = providerId;
    this.name = siteName === 'cn' ? 'MiniMax Code' : 'MiniMax Code (Global)';
    this.site = MINIMAX_CODE_SITES[siteName];
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.now = options.now ?? (() => Date.now());
    this.clientId = options.clientId ?? 'mcode-public';
    this.scope = options.scope ?? 'agent.default';
    this.audience = options.audience ?? 'agent-backend';
  }

  /**
   * MiniMax signs in with RFC 8628 device code plus a PKCE S256 challenge.
   *
   * **`device_code` is what the token endpoint polls with, and it must be sent when present.** The
   * live API always returns it (measured), and a poll carrying `user_code` instead is refused outright:
   *
   * ```
   * POST /oauth2/token  device_code=…  -> 400 {"error":"authorization_pending"}       (correct)
   * POST /oauth2/token  user_code=…    -> 400 {"error":"invalid_request","error_description":"device_code and code_verifier are required"}
   * ```
   *
   * A variant of the protocol omits `device_code` entirely and polls with the `user_code`; `pollByUserCode`
   * records that so the poll sends the right one, rather than preferring `user_code` and breaking every
   * real sign-in.
   */
  async beginSignIn(): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresIn?: number;
    codeVerifier: string;
    pollByUserCode: boolean;
  }> {
    const { verifier, challenge } = await generatePkcePair();
    const response = await this.postForm<DeviceCodeResponse>(`${this.site.account}/oauth2/device/code`, {
      client_id: this.clientId,
      scope: this.scope,
      audience: this.audience,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const data = response.data ?? {};
    const userCode = typeof data.user_code === 'string' ? data.user_code : '';
    const hasDeviceCode = typeof data.device_code === 'string' && data.device_code.length > 0;
    const deviceCode = hasDeviceCode ? (data.device_code as string) : userCode;
    const verificationUrl = data.verification_uri_complete ?? data.verification_uri ?? `${this.site.account}/user/code`;
    if (!userCode || !deviceCode) {
      throw new ProviderError('PROVIDER_REQUEST_FAILED', 'MiniMax did not return a device code.', { providerId: this.id });
    }
    const expiresIn = normalizeDeadline(data);
    return { deviceCode, userCode, verificationUrl, codeVerifier: verifier, pollByUserCode: !hasDeviceCode, ...(expiresIn ? { expiresIn } : {}) };
  }

  async pollSignIn(
    deviceCode: string,
    signal?: AbortSignal,
    codeVerifier?: string,
    userCode?: string,
    pollByUserCode = false,
  ): Promise<
    | { status: 'pending' }
    | { status: 'slow_down' }
    | { status: 'denied'; error: string }
    | { status: 'expired'; error: string }
    | { status: 'connected'; credential: ProviderCredential }
  > {
    const fields: Record<string, string> = {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: this.clientId,
      code_verifier: codeVerifier ?? '',
    };
    // `device_code` by default; `user_code` only for the variant that never issued one.
    if (pollByUserCode && userCode) fields.user_code = userCode;
    else fields.device_code = deviceCode;

    const response = await this.postForm<TokenResponse>(`${this.site.account}/oauth2/token`, fields, signal, true);
    const data = response.data ?? {};
    const statusField = typeof data.status === 'string' ? data.status.toLowerCase() : '';

    if (statusField === 'pending') return { status: 'pending' };
    if (statusField === 'slow_down') return { status: 'slow_down' };
    if (statusField === 'denied' || statusField === 'access_denied' || data.error === 'access_denied') {
      return { status: 'denied', error: data.error_description ?? 'Authorization denied by MiniMax.' };
    }
    if (statusField === 'expired' || statusField === 'expired_token' || data.error === 'expired_token') {
      return { status: 'expired', error: 'The device-auth code expired.' };
    }
    if (data.error === 'authorization_pending' || data.error === 'slow_down') return { status: 'pending' };
    if (data.error) return { status: 'denied', error: data.error_description ?? data.error };

    const access = typeof data.access_token === 'string' ? data.access_token : '';
    if (!access) {
      return { status: 'denied', error: data.error_description ?? 'MiniMax did not return a session. Try again.' };
    }
    return {
      status: 'connected',
      credential: {
        type: 'oauth',
        value: access,
        ...(typeof data.refresh_token === 'string' && data.refresh_token ? { refreshToken: data.refresh_token } : {}),
        ...(expiresAtFrom(data.expires_in) ? { expiresAt: expiresAtFrom(data.expires_in)! } : {}),
      },
    };
  }

  async validateCredential(credential: ProviderCredential | undefined, context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    if (!credential || credential.type !== 'oauth' || !credential.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'MiniMax Code needs an OAuth sign-in.', { providerId: this.id });
    }
    const startedAt = performance.now();
    await this.listModels({ ...context, credential });
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - startedAt) };
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const credential = await this.credential(context);
    const response = await this.transport.request<CatalogBody>({
      method: 'GET',
      providerId: this.id,
      url: `${this.site.agent}/mavis/api/v1/models?region=en&buildEnv=prod`,
      headers: this.requestHeaders(credential),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const body = response.data ?? {};
    const recognized = Array.isArray(body.data)
      || Array.isArray(body.providers)
      || Boolean(body.models && typeof body.models === 'object');
    // Inventing a catalog from a malformed response made a changed shape look like a healthy account.
    // A recognised shape with no models is different: it is an account with nothing entitled, and it is
    // returned as an empty list rather than as a failure to read.
    if (!recognized) throw invalidResponse(this.id, 'MiniMax returned an unreadable model catalog.');
    return catalogModels(this.id, body);
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const credential = await this.credential(context);
    const response = await this.transport.request<ClaudeOrOpenAiResponse>({
      method: 'POST',
      providerId: this.id,
      url: `${this.site.agent}/mavis/api/v1/llm/v1/messages`,
      headers: this.requestHeaders(credential),
      body: JSON.stringify(this.toRequestBody(request, false)),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return this.toChatResponse(response.data, request.model);
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const credential = await this.credential(context);
    const events = this.transport.stream({
      method: 'POST',
      providerId: this.id,
      url: `${this.site.agent}/mavis/api/v1/llm/v1/messages`,
      headers: this.requestHeaders(credential),
      body: JSON.stringify(this.toRequestBody(request, true)),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    let sawPayload = false;
    let sawDone = false;
    /** Claude sends input-token usage once in `message_start`, not with the stop event. */
    let inputUsage: TokenUsage | undefined;
    for await (const event of parseSseStream(events)) {
      if (event.data.trim() === '[DONE]') {
        sawDone = true;
        break;
      }
      const parsed = parseSseJson<StreamChunkShape>(event, this.id);
      if (!parsed) continue;
      sawPayload = true;
      if (parsed.error) {
        throw minimaxQuotaError(new ProviderError('PROVIDER_REQUEST_FAILED', parsed.error.message ?? 'MiniMax reported an error while streaming.', {
          providerId: this.id,
        }));
      }

      // Claude Messages streaming: `content_block_delta` carries text, `message_delta` carries the
      // stop reason and output token count, `message_stop` ends the turn.
      if (parsed.type === 'message_stop') {
        sawDone = true;
        break;
      }
      if (parsed.type === 'message_start' && parsed.message?.usage) {
        inputUsage = normalizeUsage(parsed.message.usage);
        continue;
      }
      if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use' && parsed.content_block.name) {
        yield {
          id: parsed.id ?? `stream-${request.model}`,
          providerId: this.id,
          model: parsed.model ?? request.model,
          delta: {
            toolCalls: [{
              index: parsed.index ?? 0,
              ...(parsed.content_block.id ? { id: parsed.content_block.id } : {}),
              type: 'function' as const,
              function: { name: parsed.content_block.name, arguments: '' },
            }],
          },
        };
        continue;
      }
      if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
        yield {
          id: parsed.id ?? `stream-${request.model}`,
          providerId: this.id,
          model: parsed.model ?? request.model,
          delta: { content: parsed.delta.text },
        };
        continue;
      }
      if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta' && parsed.delta.partial_json) {
        yield {
          id: parsed.id ?? `stream-${request.model}`,
          providerId: this.id,
          model: parsed.model ?? request.model,
          delta: { toolCalls: [{ index: parsed.index ?? 0, function: { arguments: parsed.delta.partial_json } }] },
        };
        continue;
      }
      if (parsed.type === 'message_delta') {
        const usage = { ...inputUsage, ...(parsed.usage ? normalizeUsage(parsed.usage) : {}) };
        yield {
          id: parsed.id ?? `stream-${request.model}`,
          providerId: this.id,
          model: parsed.model ?? request.model,
          delta: {},
          ...(parsed.delta?.stop_reason ? { finishReason: normalizeClaudeStopReason(parsed.delta.stop_reason) } : {}),
          ...(Object.keys(usage).length ? { usage } : {}),
        };
        continue;
      }

      // OpenAI-shaped chunk fallback.
      const choice = parsed.choices?.[0];
      const delta = choice?.delta;
      yield {
        id: parsed.id ?? `stream-${request.model}`,
        providerId: this.id,
        model: parsed.model ?? request.model,
        delta: {
          ...(delta?.role ? { role: normalizeRole(delta.role) } : {}),
          ...(delta?.content ? { content: delta.content } : {}),
          ...(delta?.tool_calls?.length ? { toolCalls: delta.tool_calls.map(normalizeToolCallDelta) } : {}),
        },
        ...(choice?.finish_reason ? { finishReason: normalizeFinishReason(choice.finish_reason) } : {}),
        ...(parsed.usage ? { usage: normalizeUsage(parsed.usage) } : {}),
      };
    }
    if (!sawPayload || !sawDone) {
      throw new ProviderError('INVALID_RESPONSE', 'The MiniMax stream ended before completion.', { providerId: this.id });
    }
  }

  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const startedAt = performance.now();
    try {
      await this.listModels(context);
      return { status: 'healthy', verified: 'credential', latencyMs: Math.round(performance.now() - startedAt), checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'credential',
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt: new Date().toISOString(),
        ...(error instanceof Error ? { message: error.message } : {}),
      };
    }
  }

  isCredentialExpired(credential: ProviderCredential | undefined, now?: number): boolean | undefined {
    if (!credential || credential.type !== 'oauth') return undefined;
    if (typeof credential.expiresAt !== 'string') return undefined;
    const at = Date.parse(credential.expiresAt);
    if (!Number.isFinite(at)) return undefined;
    return at - this.refreshLeadMs <= (now ?? this.now());
  }

  /**
   * The scheduler's entry point: **force** a renewal now.
   *
   * It used to delegate to `credential()`, which returned the same credential unless the adapter's own
   * ten-minute window said it was due. The renewal pass works on a thirty-minute window, so it could
   * report a successful renewal while nothing was renewed.
   */
  async renewCredential(credential: ProviderCredential): Promise<ProviderCredential> {
    if (credential.type !== 'oauth' || !credential.refreshToken) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'The MiniMax Code session has expired. Sign in again.', { providerId: this.id });
    }
    return this.refreshWith(credential.refreshToken);
  }

  private async credential(context: ProviderRequestContext): Promise<ProviderCredential> {
    const current = context.credential;
    if (!current || current.type !== 'oauth' || !current.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'MiniMax Code needs an OAuth sign-in.', { providerId: this.id });
    }
    if (!this.isCredentialExpired(current, this.now())) return current;
    const refresh = current.refreshToken;
    if (!refresh) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'The MiniMax Code session has expired. Sign in again.', { providerId: this.id });
    }
    const memo = this.renewed.get(current.value);
    if (memo) return memo;
    return this.refreshWith(refresh);
  }

  private async refreshWith(refresh: string): Promise<ProviderCredential> {
    const pending = this.refreshing.get(refresh);
    if (pending) return pending;
    const work = (async () => {
      const response = await this.postForm<TokenResponse>(
        `${this.site.account}/oauth2/token`,
        { grant_type: 'refresh_token', refresh_token: refresh, client_id: this.clientId },
        undefined,
        true,
      );
      const data = response.data ?? {};
      const access = typeof data.access_token === 'string' ? data.access_token : '';
      if (!access) {
        throw new ProviderError('AUTHENTICATION_FAILED', data.error_description ?? 'MiniMax refused to renew the session. Sign in again.', {
          providerId: this.id,
        });
      }
      const renewed: ProviderCredential = {
        type: 'oauth',
        value: access,
        ...(typeof data.refresh_token === 'string' && data.refresh_token ? { refreshToken: data.refresh_token } : { refreshToken: refresh }),
        ...(expiresAtFrom(data.expires_in) ? { expiresAt: expiresAtFrom(data.expires_in)! } : {}),
      };
      this.renewed.set(access, renewed);
      await this.onTokensRefreshed?.(renewed);
      return renewed;
    })().finally(() => { this.refreshing.delete(refresh); });
    this.refreshing.set(refresh, work);
    return work;
  }

  private requestHeaders(credential: ProviderCredential): Record<string, string> {
    if (credential.type !== 'oauth' || !credential.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'MiniMax Code needs an OAuth access token.', { providerId: this.id });
    }
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      Authorization: `Bearer ${credential.value}`,
      'anthropic-version': '2023-06-01',
      'User-Agent': 'MiniMaxAgent',
      'X-Mavis-Agent-Id': 'main',
    };
  }

  private toRequestBody(request: ChatRequest, stream: boolean) {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toClaudeMessage),
      // Omitted when the caller did not ask for a cap; inventing 4096 made a request cost more than
      // the caller specified.
      ...(request.maxOutputTokens === undefined ? {} : { max_tokens: request.maxOutputTokens }),
      stream,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.tools !== undefined) body.tools = request.tools.map(toClaudeTool);
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
    if (request.reasoningEffort !== undefined) body.reasoning_effort = request.reasoningEffort;
    return body;
  }

  private toChatResponse(response: ClaudeOrOpenAiResponse, requestedModel: string): ChatResponse {
    // MiniMax serves Claude Messages format: `{ id, content: [{type:'text', text}], stop_reason,
    // usage: { input_tokens, output_tokens } }`. An OpenAI-shaped `choices[0].message` is still
    // tolerated because some lanes proxy it, but the Claude shape is the one this endpoint sends.
    if (typeof response.content === 'string') {
      return {
        id: response.id ?? `chat-${requestedModel}`,
        providerId: this.id,
        model: response.model ?? requestedModel,
        createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: response.content },
        finishReason: normalizeClaudeStopReason(response.stop_reason),
        ...(response.usage ? { usage: normalizeUsage(response.usage) } : {}),
      };
    }
    if (Array.isArray(response.content)) {
      const text = response.content
        .map((block) => (block && typeof block === 'object' && block.type === 'text' ? block.text ?? '' : ''))
        .join('');
      // `tool_use` blocks are the answer for a coding turn. Dropping them left a `tool_calls` finish
      // reason with no calls, which a client cannot act on.
      const toolCalls = response.content.flatMap((block) => {
        if (!block || typeof block !== 'object' || block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') return [];
        return [{ id: block.id, type: 'function' as const, function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }];
      });
      return {
        id: response.id ?? `chat-${requestedModel}`,
        providerId: this.id,
        model: response.model ?? requestedModel,
        createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: text, ...(toolCalls.length ? { toolCalls } : {}) },
        finishReason: normalizeClaudeStopReason(response.stop_reason),
        ...(response.usage ? { usage: normalizeUsage(response.usage) } : {}),
      };
    }
    const choice = response.choices?.[0];
    if (!choice?.message) throw invalidResponse(this.id, 'MiniMax returned no message.');
    return {
      id: response.id ?? `chat-${requestedModel}`,
      providerId: this.id,
      model: response.model ?? requestedModel,
      createdAt: new Date((typeof response.created === 'number' ? response.created : Date.now() / 1000) * 1000).toISOString(),
      message: { role: 'assistant', content: choice.message.content ?? '' },
      finishReason: normalizeFinishReason(choice.finish_reason),
      ...(response.usage ? { usage: normalizeUsage(response.usage) } : {}),
    };
  }

  /**
   * Posts a form body, optionally reading a 4xx body as data.
   *
   * MiniMax answers a pending poll with its own envelope on HTTP 200 and a dead refresh token with a
   * 4xx whose `error_description` is the only place it says why, so the token endpoints use
   * `tolerateRefusalBody`; the inference paths do not.
   */
  private async postForm<T>(url: string, fields: Record<string, string>, signal?: AbortSignal, tolerate = false) {
    return this.transport.request<T>({
      method: 'POST',
      providerId: this.id,
      url,
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      ...(tolerate ? { tolerateRefusalBody: true } : {}),
      ...(signal ? { signal } : {}),
    });
  }
}

export function createMinimaxCodeAdapter(siteName: MinimaxCodeSiteName, options: MinimaxCodeAdapterOptions = {}): ProviderAdapter {
  const providerId = siteName === 'cn' ? minimaxCodeProviderId : minimaxCodeGlobalProviderId;
  return new MinimaxCodeAdapter(providerId, siteName, options);
}

async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  // Web Crypto, not node:crypto: this module is reachable from the SDK barrel the dashboard imports.
  const random = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of random) binary += String.fromCharCode(byte);
  const verifier = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let hashBinary = '';
  for (const byte of new Uint8Array(digest)) hashBinary += String.fromCharCode(byte);
  const challenge = btoa(hashBinary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

function normalizeDeadline(data: DeviceCodeResponse): number | undefined {
  if (typeof data.expires_in === 'number' && data.expires_in > 0) return data.expires_in;
  if (typeof data.expired_in === 'number' && data.expired_in > 0) {
    return data.expired_in < 1e12 ? data.expired_in : Math.max(1, Math.ceil((data.expired_in - Date.now()) / 1000));
  }
  return undefined;
}

/** A token lifetime, whether the provider sent it as a number or a numeric string. */
function expiresAtFrom(value: unknown): string | undefined {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : undefined;
}

function normalizeRole(role: string): ChatMessage['role'] {
  return role === 'assistant' || role === 'system' || role === 'tool' ? role : 'user';
}

function normalizeFinishReason(reason: string | null | undefined): FinishReason {
  return reason === 'length' || reason === 'tool_calls' || reason === 'content_filter' ? reason : 'stop';
}

/** Claude Messages `stop_reason` → the SDK's finish reasons. */
function normalizeClaudeStopReason(reason: string | null | undefined): FinishReason {
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  return 'stop';
}

function normalizeUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } }): TokenUsage {
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : usage.input_tokens;
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : usage.output_tokens;
  const cacheRead = usage.cache_read_input_tokens === undefined ? usage.prompt_tokens_details?.cached_tokens : usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;
  return {
    ...(typeof input === 'number' ? { inputTokens: input } : {}),
    ...(typeof output === 'number' ? { outputTokens: output } : {}),
    ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(usage.cache_read_input_tokens === undefined && usage.cache_creation_input_tokens === undefined ? {} : { cacheTokensIncluded: false }),
    ...(usage.completion_tokens_details?.reasoning_tokens === undefined ? {} : { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }),
  };
}

function normalizeToolCallDelta(call: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }) {
  return {
    index: call.index ?? 0,
    ...(call.id ? { id: call.id } : {}),
    type: 'function' as const,
    function: { ...(call.function?.name ? { name: call.function.name } : {}), arguments: call.function?.arguments ?? '' },
  };
}

function toClaudeMessage(message: ChatMessage) {
  // Claude's tool round is `tool_result` inside a **user** message, not a `tool` role with a
  // `tool_call_id`; and an assistant's calls are `tool_use` blocks. Sending the OpenAI shape reached
  // the provider as an unknown role and the turn failed.
  if (message.role === 'tool') {
    const text = typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: text }] };
  }
  const blocks: Array<Record<string, unknown>> = [];
  if (typeof message.content === 'string') {
    if (message.content) blocks.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
      else blocks.push({ type: 'image', source: { type: 'url', url: part.imageUrl.url } });
    }
  }
  for (const call of message.toolCalls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      input = {};
    }
    blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }
  return {
    role: message.role,
    content: blocks.length === 0 ? (typeof message.content === 'string' ? message.content : '') : blocks,
  };
}

function toClaudeTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters,
  };
}

function invalidResponse(providerId: string, message: string) {
  return new ProviderError('INVALID_RESPONSE', message, { providerId });
}

/**
 * MiniMax reports credit/quota exhaustion as 402/403 (and 429) with a message matching this regex —
 * "insufficient balance", "credit", "额度不足" and their kin.
 *
 * Left as a plain provider failure, the request dies on that route and the operator reads a generic
 * refusal; the reference executor rewrote it as a rate-limit error so the gateway fails the request
 * over to a route that still has allowance, and the message names the exhaustion. Same rewrite here:
 * the regex now marks the failure instead of sitting voided at the foot of this file.
 */
function minimaxQuotaError(error: ProviderError): ProviderError {
  if (error.code === 'RATE_LIMITED') return error;
  const detail = typeof (error.details as { providerMessage?: unknown } | undefined)?.providerMessage === 'string'
    ? (error.details as { providerMessage: string }).providerMessage
    : '';
  const text = `${error.message} ${detail}`.trim();
  if (!QUOTA_RE.test(text)) return error;
  const message = `usage limit reached: ${text.slice(0, 200)}`;
  return new ProviderError('RATE_LIMITED', message, { providerId: error.providerId, retryable: true, publicMessage: message });
}
