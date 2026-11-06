import { ProviderError } from '../lib/errors.js';
import { boundedMap } from '../lib/bounded-map.js';
import { parseSseJson, parseSseStream } from '../lib/streaming.js';
import { FetchHttpTransport, type HttpTransport } from '../lib/transport.js';
import { normalizeProviderBaseUrl, resolveProviderUrl, sanitizeProviderHeaders } from '../lib/url.js';

import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  FinishReason,
  Model,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCredential,
  ProviderHealth,
  ProviderRequestContext,
  TokenUsage,
  ToolDefinition,
} from '../lib/types.js';

/** Renewed credentials kept per adapter, enough for every token a live gateway has recently renewed. */
const maxRenewalMemoEntries = 64;

/**
 * CodeBuddy — Tencent's coding subscription, reached by a browser OAuth handshake.
 *
 * ## Two regions, one protocol
 *
 * `copilot.tencent.com` (China) and `www.codebuddy.ai` (international) are separate accounts on
 * separate domains, so they get separate provider ids and separate cards. Everything else is the same
 * wire format; the only differences are the domain, the `platform` query value (`CLI` vs `ide`) and the
 * `User-Agent` prefix — which is why this is one adapter with a `region` parameter, not two adapters.
 *
 * ## The sign-in is not a device code, despite the name
 *
 * Upstream calls it a device flow and names the field `state`, but the user never types a code. The
 * start call returns an `authUrl`; the user approves in a browser; the poll asks for the token. So
 * `beginSignIn` returns an **empty** `userCode` and a `verificationUrl`, and the dashboard opens the
 * URL rather than showing a code to type.
 *
 * ## The chat gateway is stream-only
 *
 * A non-stream request is refused with HTTP 400 and code `11101` ("Non-stream chat request is currently
 * not supported"). So this adapter always sends `stream: true` and aggregates the SSE back into one
 * response when `streamChat` was not asked for — the caller's contract is unchanged.
 *
 * ## The conversation headers are load-bearing
 *
 * Every chat request must carry four **fresh** conversation ids. Without them the gateway answers HTTP
 * 400 with code `11128` — "this call failed channel verification" — which is a refusal to answer a
 * request that does not look like it came from the official client. The message id is reused as the
 * request id, exactly as the CLI does.
 *
 * ## There is no model list to read
 *
 * `/models` answers 404 on both regions, so the catalog is a fixed seed (see `CODEBUDDY_*_MODELS`) and
 * `listModels` never makes a request. That is a published list, not a guess: the regions publish
 * different model sets and the published list is the contract.
 */
export const CODEBUDDY_CN = {
  id: 'codebuddy-cn',
  name: 'CodeBuddy',
  server: 'https://copilot.tencent.com',
  platform: 'CLI',
  domain: 'copilot.tencent.com',
  userAgent: 'CLI/2.63.2 CodeBuddy/2.63.2',
  chatUserAgent: 'CLI/2.177.0 CodeBuddy/2.177.0',
} as const;

export const CODEBUDDY_INTL = {
  id: 'codebuddy-intl',
  name: 'CodeBuddy (Global)',
  server: 'https://www.codebuddy.ai',
  platform: 'ide',
  domain: 'www.codebuddy.ai',
  userAgent: 'IDE/2.63.2 CodeBuddy/2.63.2',
  chatUserAgent: 'CLI/2.177.0 CodeBuddy/2.177.0',
} as const;

export type CodeBuddyRegion = 'cn' | 'intl';

export const codebuddyCnProviderId = 'codebuddy-cn';
export const codebuddyIntlProviderId = 'codebuddy-intl';

type CodeBuddySite = typeof CODEBUDDY_CN | typeof CODEBUDDY_INTL;

export const CODEBUDDY_SITES: Record<CodeBuddyRegion, CodeBuddySite> = {
  cn: CODEBUDDY_CN,
  intl: CODEBUDDY_INTL,
};

const CODEBUDDY_CN_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5.1', name: 'GLM-5.1' },
  { id: 'minimax-m3', name: 'MiniMax-M3' },
  { id: 'hy3', name: 'Hy3' },
  { id: 'hy4-preview', name: 'Hy4-Preview' },
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
  { id: 'kimi-k3-1', name: 'Kimi-K3' },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
];

const CODEBUDDY_INTL_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5.1', name: 'GLM-5.1' },
  { id: 'glm-5.0', name: 'GLM-5.0' },
  { id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo' },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo' },
  { id: 'glm-4.7', name: 'GLM-4.7' },
  { id: 'minimax-m3', name: 'MiniMax-M3' },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7' },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code' },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6' },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5' },
  { id: 'hy3-preview', name: 'Hy3 Preview' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2' },
];

const CODEBUDDY_MODELS: Record<CodeBuddyRegion, ReadonlyArray<{ id: string; name: string }>> = {
  cn: CODEBUDDY_CN_MODELS,
  intl: CODEBUDDY_INTL_MODELS,
};

export type CodeBuddyAdapterOptions = {
  transport?: HttpTransport;
  timeoutMs?: number;
  /** Called with a renewed credential so a caller can persist it. */
  onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  now?: () => number;
};

type CodeBuddyAuthEnvelope = {
  code?: number;
  msg?: string;
  data?: {
    state?: string;
    authUrl?: string;
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    expiresIn?: number;
  };
};

type OpenAIChatResponse = {
  id?: string;
  model?: string;
  created?: number;
  choices?: Array<{
    message?: { role?: string; content?: string | null };
    delta?: { role?: string; content?: string | null; tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: number | string };
};

const CODEBUDDY_API_PATHS = {
  state: '/v2/plugin/auth/state',
  token: '/v2/plugin/auth/token',
  refresh: '/v2/plugin/auth/token/refresh',
  chat: '/v2/chat/completions',
} as const;

/** The system prompt the official CLI opens every request with. The gateway refuses a request without one. */
const CODEBUDDY_SYSTEM_PROMPT = 'You are CodeBuddy Code.';

/** Renew this long before the stated expiry, so a request never sets off with a token about to die. */
const refreshLeadMs = 10 * 60 * 1000;

function regionFromProviderId(providerId: string): CodeBuddyRegion {
  return providerId === CODEBUDDY_INTL.id || providerId.endsWith('-intl') ? 'intl' : 'cn';
}

class CodeBuddyAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities = { chat: true, streaming: true, models: false };

  private readonly region: CodeBuddyRegion;
  private readonly site: CodeBuddySite;
  private readonly baseUrl: string;
  private readonly transport: HttpTransport;
  private readonly onTokensRefreshed: ((credential: ProviderCredential) => void | Promise<void>) | undefined;
  private readonly now: () => number;
  private readonly renewed = boundedMap<string, ProviderCredential>(maxRenewalMemoEntries);

  constructor(region: CodeBuddyRegion, options: CodeBuddyAdapterOptions = {}) {
    this.region = region;
    this.site = CODEBUDDY_SITES[region];
    this.id = this.site.id;
    this.name = this.site.name;
    this.baseUrl = normalizeProviderBaseUrl(this.site.server, this.id);
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Ask the gateway for a state key and the URL the user approves at.
   *
   * The body is the literal `{}` the plugin sends — not `JSON.stringify({})`, which is the same bytes,
   * but stated so nobody "improves" it into a body with fields the endpoint does not expect.
   */
  async beginSignIn(): Promise<{ deviceCode: string; userCode: string; verificationUrl: string; expiresIn?: number }> {
    const response = await this.transport.request<CodeBuddyAuthEnvelope>({
      method: 'POST',
      providerId: this.id,
      url: `${this.baseUrl}${CODEBUDDY_API_PATHS.state}?platform=${encodeURIComponent(this.site.platform)}`,
      headers: this.authHeaders(),
      body: '{}',
      tolerateRefusalBody: true,
    });

    if (response.status === 429) {
      throw new ProviderError('PROVIDER_REQUEST_FAILED', 'Too many pending CodeBuddy sign-in requests. Try again in a minute.', { providerId: this.id });
    }
    if (response.status >= 400 && response.status < 500) {
      throw new ProviderError('PROVIDER_REQUEST_FAILED', `CodeBuddy refused the sign-in start (HTTP ${response.status}).`, { providerId: this.id });
    }

    const data = response.data?.data;
    const state = typeof data?.state === 'string' ? data.state : '';
    const authUrl = typeof data?.authUrl === 'string' ? data.authUrl : '';
    if (response.data?.code !== 0 || !state || !authUrl) {
      throw new ProviderError('PROVIDER_REQUEST_FAILED', `CodeBuddy sign-in start failed: ${response.data?.msg ?? 'missing state/authUrl'}`, { providerId: this.id });
    }

    // `userCode` is deliberately empty: there is no code to type, only a URL to open.
    return { deviceCode: state, userCode: '', verificationUrl: authUrl };
  }

  /**
   * Poll the token endpoint.
   *
   * The gateway reports "not yet" *inside* a 200 envelope: `code: 11217` is `authorization_pending`,
   * everything else non-zero is a refusal. A non-2xx is `request_failed`, which this treats as expired
   * because the state key is the thing being asked about and a failed ask leaves nothing to poll.
   */
  async pollSignIn(deviceCode: string, signal?: AbortSignal): Promise<
    | { status: 'pending' }
    | { status: 'denied'; error: string }
    | { status: 'expired'; error: string }
    | { status: 'connected'; credential: ProviderCredential; account: string }
  > {
    const response = await this.transport.request<CodeBuddyAuthEnvelope>({
      method: 'GET',
      providerId: this.id,
      url: `${this.baseUrl}${CODEBUDDY_API_PATHS.token}?state=${encodeURIComponent(deviceCode)}`,
      headers: { ...this.authHeaders(), 'X-No-Enterprise-Id': 'true', 'X-No-Department-Info': 'true' },
      tolerateRefusalBody: true,
      ...(signal ? { signal } : {}),
    });

    if (response.status >= 400) return { status: 'expired', error: `CodeBuddy returned HTTP ${response.status} while polling.` };
    const envelope = response.data;
    if (!envelope) return { status: 'expired', error: 'CodeBuddy returned an unreadable poll response.' };

    const token = typeof envelope.data?.accessToken === 'string' ? envelope.data.accessToken : '';
    if (envelope.code === 0 && token) {
      const expiresIn = typeof envelope.data?.expiresIn === 'number' && envelope.data.expiresIn > 0 ? envelope.data.expiresIn : 86_400;
      const refreshToken = typeof envelope.data?.refreshToken === 'string' ? envelope.data.refreshToken : '';
      return {
        status: 'connected',
        credential: {
          type: 'oauth',
          value: token,
          ...(refreshToken ? { refreshToken } : {}),
          expiresAt: new Date(this.now() + expiresIn * 1000).toISOString(),
        },
        account: this.site.name,
      };
    }
    if (envelope.code === 11217) return { status: 'pending' };
    return { status: 'denied', error: envelope.msg || 'CodeBuddy refused the sign-in.' };
  }

  /**
   * The fixed catalog. No request is made: both regions answer `/models` with 404.
   *
   * `capabilities.models` is **false** on purpose — that flag means "this connection can refresh
   * its catalog from the provider", and CodeBuddy cannot. `discoverModels` is present anyway
   * because saving a connection asks for a starting catalog, and refusing would fail the sign-in
   * after the token had already been issued.
   */
  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const credential = context.credential;
    if (credential && credential.type !== 'none' && credential.type !== 'oauth') {
      throw new ProviderError('AUTHENTICATION_FAILED', 'CodeBuddy needs an OAuth sign-in.', { providerId: this.id });
    }
    return CODEBUDDY_MODELS[this.region].map((row) => ({ id: row.id, providerId: this.id, displayName: row.name }));
  }

  /** The same fixed catalog, for the connection-import path. The policy cannot narrow it. */
  async discoverModels(context: ProviderRequestContext = {}): Promise<readonly Model[]> {
    return this.listModels(context);
  }

  /**
   * A non-streaming chat, built out of the stream the gateway insists on.
   *
   * Aggregating here rather than rejecting the call is what lets a plain OpenAI-compatible client use
   * a CodeBuddy connection: the caller sent `stream: false`, and the provider's own constraint is not
   * the caller's problem.
   */
  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    let id = `chat-${request.model}`;
    let model = request.model;
    let content = '';
    let finishReason: FinishReason = 'stop';
    let usage: TokenUsage | undefined;

    for await (const chunk of this.streamChat({ ...request, stream: false }, context)) {
      id = chunk.id || id;
      model = chunk.model || model;
      if (chunk.delta.content) content += chunk.delta.content;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = chunk.usage;
    }

    return {
      id,
      providerId: this.id,
      model,
      createdAt: new Date().toISOString(),
      message: { role: 'assistant', content },
      finishReason,
      ...(usage ? { usage } : {}),
    };
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const credential = await this.credential(context);
    const events = this.transport.stream({
      method: 'POST',
      providerId: this.id,
      url: resolveProviderUrl(this.baseUrl, CODEBUDDY_API_PATHS.chat, this.id),
      headers: this.chatHeaders(credential),
      body: JSON.stringify(this.toRequestBody(request)),
      ...(context.signal ? { signal: context.signal } : {}),
    });

    let sawPayload = false;
    for await (const event of parseSseStream(events)) {
      if (event.data.trim() === '[DONE]') return;
      const payload = parseSseJson<OpenAIChatResponse>(event, this.id);
      if (!payload) continue;
      sawPayload = true;
      if (payload.error) {
        throw new ProviderError('PROVIDER_REQUEST_FAILED', payload.error.message ?? 'CodeBuddy reported an error while streaming.', { providerId: this.id });
      }
      const choice = payload.choices?.[0];
      const delta = choice?.delta;
      yield {
        id: payload.id ?? `stream-${request.model}`,
        providerId: this.id,
        model: payload.model ?? request.model,
        delta: {
          ...(delta?.role ? { role: normalizeRole(delta.role) } : {}),
          ...(delta?.content ? { content: delta.content } : {}),
          ...(delta?.tool_calls?.length ? { toolCalls: delta.tool_calls.map(normalizeToolCallDelta) } : {}),
        },
        ...(choice?.finish_reason ? { finishReason: normalizeFinishReason(choice.finish_reason) } : {}),
        ...(payload.usage ? { usage: normalizeUsage(payload.usage) } : {}),
      };
    }
    if (!sawPayload) {
      throw new ProviderError('INVALID_RESPONSE', 'CodeBuddy returned an empty stream.', { providerId: this.id });
    }
  }

  /**
   * Presence and shape only — a signed-in probe would spend a billable request on every health poll,
   * and CodeBuddy has no free endpoint to read instead.
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    const credential = context.credential;
    if (!credential || credential.type !== 'oauth' || !credential.value) {
      return { status: 'unavailable', verified: 'credential', checkedAt, message: 'CodeBuddy needs an OAuth sign-in.' };
    }
    if (this.isCredentialExpired(credential) === true && !credential.refreshToken) {
      return { status: 'unavailable', verified: 'credential', checkedAt, message: 'The CodeBuddy session has expired. Sign in again.' };
    }
    return { status: 'healthy', verified: 'credential', checkedAt };
  }

  isCredentialExpired(credential: ProviderCredential | undefined, now?: number): boolean | undefined {
    if (!credential || credential.type !== 'oauth') return undefined;
    if (typeof credential.expiresAt !== 'string') return undefined;
    const at = Date.parse(credential.expiresAt);
    if (!Number.isFinite(at)) return undefined;
    return at - refreshLeadMs <= (now ?? this.now());
  }

  /** The credential to send, renewed first if it is near or past its expiry. */
  private async credential(context: ProviderRequestContext): Promise<ProviderCredential> {
    const current = context.credential;
    if (!current || current.type !== 'oauth' || !current.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'CodeBuddy needs an OAuth sign-in.', { providerId: this.id });
    }
    if (this.isCredentialExpired(current, this.now()) !== true) return current;
    if (!current.refreshToken) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'The CodeBuddy session has expired. Sign in again.', { providerId: this.id });
    }
    const memo = this.renewed.get(current.value);
    if (memo) return memo;

    const response = await this.transport.request<CodeBuddyAuthEnvelope>({
      method: 'POST',
      providerId: this.id,
      url: `${this.baseUrl}${CODEBUDDY_API_PATHS.refresh}`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': this.site.userAgent,
        'X-Requested-With': 'XMLHttpRequest',
        'X-Domain': this.site.domain,
        // Unlike everything else here, the refresh token travels in its own header rather than a body.
        'X-Refresh-Token': current.refreshToken,
        'X-Auth-Refresh-Source': 'plugin',
        'X-Product': 'SaaS',
      },
      body: '{}',
      tolerateRefusalBody: true,
    });

    const access = typeof response.data?.data?.accessToken === 'string' ? response.data.data.accessToken : '';
    if (response.status >= 400 || response.data?.code !== 0 || !access) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'CodeBuddy refused to renew the session. Sign in again.', { providerId: this.id });
    }
    const nextRefresh = typeof response.data.data?.refreshToken === 'string' && response.data.data.refreshToken
      ? response.data.data.refreshToken
      : current.refreshToken;
    const expiresIn = typeof response.data.data?.expiresIn === 'number' && response.data.data.expiresIn > 0 ? response.data.data.expiresIn : 86_400;
    const renewed: ProviderCredential = {
      type: 'oauth',
      value: access,
      refreshToken: nextRefresh,
      expiresAt: new Date(this.now() + expiresIn * 1000).toISOString(),
    };
    this.renewed.set(current.value, renewed);
    await this.onTokensRefreshed?.(renewed);
    return renewed;
  }

  /** The header set the plugin sends on the auth endpoints. */
  private authHeaders(): Record<string, string> {
    return sanitizeProviderHeaders(
      {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': this.site.userAgent,
        'X-Requested-With': 'XMLHttpRequest',
        'X-Domain': this.site.domain,
        'X-No-Authorization': 'true',
        'X-No-User-Id': 'true',
        'X-Product': 'SaaS',
      },
      this.id,
    );
  }

  /** The header set the CLI sends on chat, plus a fresh conversation id set on every request. */
  private chatHeaders(credential: ProviderCredential): Record<string, string> {
    if (credential.type !== 'oauth' || !credential.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'CodeBuddy needs an OAuth access token.', { providerId: this.id });
    }
    // The CLI reuses the message id as the request id; matching that is what the channel check expects.
    const messageId = crypto.randomUUID().replace(/-/g, '');
    return sanitizeProviderHeaders(
      {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential.value}`,
        'User-Agent': this.site.chatUserAgent,
        'X-Product': 'SaaS',
        'X-IDE-Type': 'CLI',
        'X-IDE-Name': 'CLI',
        'X-IDE-Version': '2.177.0',
        Origin: this.site.server,
        Referer: `${this.site.server}/`,
        'Accept-Language': 'en-US,en;q=0.9',
        'x-requested-with': 'XMLHttpRequest',
        'x-codebuddy-request': '1',
        'x-agent-purpose': 'conversation',
        'x-agent-intent': 'craft',
        'x-agent-runtime': 'other',
        'x-private-data': 'false',
        'x-agent-type': 'main',
        'X-Conversation-ID': crypto.randomUUID(),
        'X-Conversation-Request-ID': crypto.randomUUID(),
        'X-Conversation-Message-ID': messageId,
        'X-Request-ID': messageId,
      },
      this.id,
      { allowCredential: true },
    );
  }

  private toRequestBody(request: ChatRequest) {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toCodeBuddyMessages(request.messages),
      // Never negotiable: the gateway refuses a non-stream request with HTTP 400 / code 11101.
      stream: true,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
    if (request.stop !== undefined) body.stop = request.stop;
    if (request.tools !== undefined) body.tools = request.tools.map(toOpenAITool);
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
    // CodeBuddy is a unified gateway: every model takes OpenAI-style reasoning params, and there is no
    // "none" value, so an absent effort is omitted rather than written as one.
    if (request.reasoningEffort !== undefined) {
      body.reasoning_effort = request.reasoningEffort;
      body.reasoning_summary = 'auto';
    }
    return body;
  }
}

export function createCodeBuddyAdapter(region: CodeBuddyRegion, options: CodeBuddyAdapterOptions = {}): ProviderAdapter {
  return new CodeBuddyAdapter(region, options);
}

/** Region for a provider id (`codebuddy-cn` / `codebuddy-intl`), so callers can dispatch by id. */
export function codeBuddyRegionFor(providerId: string): CodeBuddyRegion {
  return regionFromProviderId(providerId);
}

/**
 * CodeBuddy's message shape, which is **not** plain OpenAI.
 *
 * Measured against the live gateway: a request whose first message is `user` is refused with HTTP 400
 * and `first message is not system prompt`. The official CLI therefore always opens with a system
 * message, and the reference implementation hard-codes one (`"You are CodeBuddy Code."`) rather than
 * forwarding the caller's. That is what this does, because the gateway rejects any other shape — a
 * caller's own system message is *replaced*, not moved, which is the same choice the CLI makes.
 *
 * The second half is the content encoding: `user` turns are refused as a bare string and must be typed
 * text blocks (`[{ type: 'text', text }]`). Assistant and tool turns are passed through untouched, since
 * those are the shapes a tool round actually replays.
 */
function toCodeBuddyMessages(messages: readonly ChatMessage[]) {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: CODEBUDDY_SYSTEM_PROMPT }];
  for (const message of messages) {
    // The gateway wants exactly one system message, in first position. A caller's is dropped rather
    // than forwarded as a second one, which the gateway also refuses.
    if (message.role === 'system') continue;
    const mapped = toOpenAIMessage(message);
    if (message.role === 'user' && typeof message.content === 'string') {
      out.push({ ...mapped, content: [{ type: 'text', text: message.content }] });
    } else {
      out.push(mapped as Record<string, unknown>);
    }
  }
  return out;
}

function normalizeRole(role: string): ChatMessage['role'] {
  return role === 'assistant' || role === 'system' || role === 'tool' ? role : 'user';
}

function normalizeFinishReason(reason: string | null | undefined): FinishReason {
  return reason === 'length' || reason === 'tool_calls' || reason === 'content_filter' ? reason : 'stop';
}

function normalizeUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): TokenUsage {
  return {
    ...(typeof usage.prompt_tokens === 'number' ? { inputTokens: usage.prompt_tokens } : {}),
    ...(typeof usage.completion_tokens === 'number' ? { outputTokens: usage.completion_tokens } : {}),
    ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
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

function toOpenAIMessage(message: ChatMessage) {
  const toolCallId = message.toolCallId ? { tool_call_id: message.toolCallId } : {};
  if (typeof message.content === 'string' || message.content === null) {
    return {
      role: message.role,
      content: message.content,
      ...toolCallId,
      ...(message.toolCalls?.length
        ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } })) }
        : {}),
    };
  }
  return {
    role: message.role,
    content: message.content.map((part) => (part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image_url', image_url: { url: part.imageUrl.url } })),
    ...toolCallId,
  };
}

function toOpenAITool(tool: ToolDefinition) {
  return { type: 'function' as const, function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: tool.parameters } };
}
