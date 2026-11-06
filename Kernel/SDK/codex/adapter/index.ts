import { ProviderError } from '../lib/errors.js';
import { parseSseJson, parseSseStream } from '../lib/streaming.js';
import { FetchHttpTransport, type HttpTransport } from '../lib/transport.js';
import { assertSafeProviderHeaderValue } from '../lib/url.js';
import { boundedMap } from '../lib/bounded-map.js';
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, FinishReason, Model, ProviderAdapter, ProviderCredential, ProviderHealth, ProviderQuota, ProviderRequestContext, ProviderResourceQuota, TokenUsage } from '../lib/types.js';

/**
 * The Codex CLI version this adapter presents.
 *
 * It is a constant rather than something discovered, because it has to be *a* version: the catalog
 * endpoint gates each entry by `minimal_client_version` against whatever is sent. A value too low
 * therefore hides models the account really has, and it hides them **silently**, in a 200 with the
 * entries simply absent — which reads as an account with nothing on it. Overridable so that a
 * deployment can move it without a rebuild, and so the value in use is a setting rather than a
 * claim buried in code.
 */
const CODEX_CLI_VERSION = '0.154.0';

/** The catalog URL for a client version. Built per call so an override actually reaches it. */
export function codexModelsUrl(clientVersion: string = CODEX_CLI_VERSION) {
  return `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}`;
}

export const CODEX = {
  authorizationUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: 'https://auth.openai.com/oauth/token',
  refreshGrantType: 'refresh_token',
  apiUrl: 'https://chatgpt.com/backend-api/codex/responses',
  /**
   * The account's own usage report — the same one the Codex CLI shows as its 5-hour and weekly
   * meters. Account metadata, not an inference request: reading it spends no tokens.
   */
  usageUrl: 'https://chatgpt.com/backend-api/wham/usage',
  /**
   * The catalog the account can actually use, asked rather than written down.
   *
   * `client_version` is not decorative: the endpoint gates each entry by `minimal_client_version`
   * against it, so a stale value answers 200 with entries *quietly missing* rather than erroring. A
   * version that old therefore looks like an account with no models, which is why a short list is
   * treated as a failure worth reporting rather than as an answer.
   */
  modelsUrl: codexModelsUrl(),
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  originator: 'codex_cli_rs',
  /** The identity the Codex CLI presents. A public identifier, not a secret: it authenticates nobody. */
  publicClientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  /** The only redirect URI registered for that client, so a caller overriding it must match too. */
  publicRedirectUri: 'http://localhost:1455/auth/callback',
  publicRedirectPort: 1455,
  publicRedirectPath: '/auth/callback',
  cliVersion: CODEX_CLI_VERSION,
} as const;
export const codexProviderId = 'codex';
const maxRenewalMemoEntries = 64;
const renewalWindowMs = 60_000;

/**
 * The reset time, in the shapes the endpoint has been seen to use: Unix seconds (the live response),
 * Unix milliseconds, or an ISO string. A number read as milliseconds lands in 1970, so the epoch is
 * decided by magnitude, the same rule the Kimi adapter states.
 */
function codexResetTime(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

/**
 * The window's own name, from the duration the endpoint states about it.
 *
 * `limit_window_seconds` is on every window, and the plans differ: a paid plan rolls a 5-hour session
 * beside a weekly allowance, while the free plan's primary window is **monthly** and has no secondary
 * at all. Labeling the primary "5-hour" — what the reference client hardcoded — told a free-plan user
 * their monthly cap was a 5-hour one. The duration is the truth the card shows; a duration the
 * gateway has never seen is humanized rather than dropped.
 */
function codexWindowName(seconds: unknown): string {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return 'Usage window';
  if (s === 2_592_000) return 'Monthly window';
  if (s === 604_800) return 'Weekly window';
  if (s % 86_400 === 0) return `${s / 86_400}-day window`;
  if (s % 3_600 === 0) return `${s / 3_600}-hour window`;
  return `${Math.round(s / 60)} min window`;
}

/**
 * One rate-limit window, as the usage report states it: a percentage used, never an absolute count,
 * beside the duration the window covers.
 *
 * Expressed against 100 — the panel's "N of M left" then reads as the percentage the provider stated.
 * A ratio outside 0–100 is clamped, not trusted, so a strange upstream figure cannot produce a
 * strange bar.
 */
function codexWindow(window: unknown): { name: string; quota: ProviderResourceQuota } | undefined {
  if (!window || typeof window !== 'object') return undefined;
  const record = window as { used_percent?: unknown; percent_used?: unknown; reset_at?: unknown; limit_window_seconds?: unknown };
  const stated = Number(record.used_percent ?? record.percent_used ?? 0);
  const usedPct = Math.round(Math.min(100, Math.max(0, Number.isFinite(stated) ? stated : 0)));
  const resetsAt = codexResetTime(record.reset_at);
  return {
    name: codexWindowName(record.limit_window_seconds),
    quota: { used: usedPct, limit: 100, remaining: 100 - usedPct, ...(resetsAt ? { resetsAt } : {}) },
  };
}

type CodexUsageResponse = {
  plan_type?: unknown;
  rate_limit?: { primary_window?: unknown; secondary_window?: unknown } | null;
};

/**
 * The windows the account is bound by, named from each window's own stated duration.
 *
 * The endpoint reports more meters than that — a code-review window, a Spark window, and rate-limit
 * reset credits — and the card deliberately renders none of them, the same rule Kimi's card states:
 * the operator reads the numbers the subscription is bound by. A window the response omits is simply
 * absent from the card, never rendered as zero.
 */
function parseCodexUsage(data: CodexUsageResponse): ProviderQuota {
  const resources: Record<string, ProviderResourceQuota> = {};
  const rateLimit = data.rate_limit ?? {};
  for (const window of [codexWindow((rateLimit as { primary_window?: unknown }).primary_window), codexWindow((rateLimit as { secondary_window?: unknown }).secondary_window)]) {
    if (window) resources[window.name] = window.quota;
  }
  return { plan: typeof data.plan_type === 'string' && data.plan_type ? data.plan_type : 'Codex', resources };
}

export type CodexAdapterOptions = {
  /** Overrides the public Codex CLI client. An operator's own client needs its own redirect URI too. */
  clientId?: string;
  /**
   * The CLI version sent to the catalog endpoint, which decides how many entries come back.
   *
   * Exists because that number silently hides models when it is behind: see `codexModelsUrl`.
   */
  clientVersion?: string;
  transport?: HttpTransport;
  timeoutMs?: number;
  onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  now?: () => number;
};

/**
 * OpenAI answers a refusal with a **nested** object — `{"error":{"message":…,"code":…}}` — not the
 * flat `error`/`error_description` strings RFC 6749 suggests. Typing `error` as a string meant the
 * real reason ("token_expired", "invalid_grant") was silently dropped and every refusal read as the
 * same generic sentence, which is how a wrong-client or reused-code failure looked identical to a
 * dropped browser session.
 */
type TokenRefusal = { error?: string | { message?: string; code?: string; type?: string }; error_description?: string };
type TokenPayload = { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string } & TokenRefusal;

/** The provider's own words, in whichever of the two shapes it sent them. */
function refusalReason(data: TokenRefusal | undefined): string | undefined {
  const nested = typeof data?.error === 'object' ? data.error : undefined;
  const reason = nested?.message ?? data?.error_description ?? (typeof data?.error === 'string' ? data.error : undefined);
  if (!reason) return undefined;
  const code = nested?.code ? ` (${nested.code})` : '';
  return `${reason}${code}`;
}

type CodexEvent = { type?: string; response?: { id?: string; model?: string; status?: string; incomplete_details?: { reason?: string }; usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }; error?: { message?: string } }; item_id?: string; delta?: string; text?: string; error?: { message?: string }; };

export function codexAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string }) {
  const url = new URL(CODEX.authorizationUrl);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', CODEX.scopes.join(' '));
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  url.searchParams.set('originator', CODEX.originator);
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('id_token_add_organizations', 'true');
  return url.toString();
}

export async function exchangeCodexCode(input: { code: string; codeVerifier: string; clientId: string; redirectUri: string; transport?: HttpTransport; signal?: AbortSignal }): Promise<ProviderCredential> {
  const transport = input.transport ?? new FetchHttpTransport();
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, code_verifier: input.codeVerifier, client_id: input.clientId, redirect_uri: input.redirectUri });
  const { data } = await transport.request<TokenPayload>({ method: 'POST', providerId: codexProviderId, url: CODEX.tokenUrl, headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), tolerateRefusalBody: true, ...(input.signal ? { signal: input.signal } : {}) });
  return tokenCredential(data);
}

export async function refreshCodexCredential(input: { credential: Extract<ProviderCredential, { type: 'oauth' }>; clientId: string; transport: HttpTransport; signal?: AbortSignal; now?: () => number }): Promise<ProviderCredential> {
  if (!input.credential.refreshToken) throw new ProviderError('AUTHENTICATION_FAILED', 'The Codex session has expired. Sign in again.', { providerId: codexProviderId });
  const { data } = await input.transport.request<TokenPayload>({
    method: 'POST', providerId: codexProviderId, url: CODEX.tokenUrl,
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: CODEX.refreshGrantType, refresh_token: input.credential.refreshToken, client_id: input.clientId, scope: CODEX.scopes.join(' ') }).toString(),
    tolerateRefusalBody: true, ...(input.signal ? { signal: input.signal } : {}),
  });
  return tokenCredential(data, (input.now ?? Date.now)(), input.credential.refreshToken);
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = codexProviderId;
  readonly name = 'Codex';
  readonly capabilities = { chat: true, streaming: true, models: true } as const;
  private readonly transport: HttpTransport;
  private readonly now: () => number;
  private readonly onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  private readonly renewed = boundedMap<string, ProviderCredential>(maxRenewalMemoEntries);
  private readonly refreshing = new Map<string, Promise<Extract<ProviderCredential, { type: 'oauth' }>>>();
  private readonly clientId: string;
  private readonly clientVersion: string;

  constructor(options: CodexAdapterOptions = {}) {
    this.clientId = options.clientId?.trim() || CODEX.publicClientId;
    this.clientVersion = options.clientVersion?.trim() || CODEX.cliVersion;
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
    this.now = options.now ?? (() => Date.now());
    this.onTokensRefreshed = options.onTokensRefreshed;
  }

  /**
   * The models this account can actually use, asked of the provider rather than written down here.
   *
   * This used to return one placeholder called "codex", which is why a connected Codex provider
   * advertised exactly one model: nothing was ever asked, and a hard-coded name is not a catalog.
   * A hand-maintained list is not the alternative either — it goes stale silently, and an id the
   * backend does not serve fails only at the moment someone tries to use it.
   *
   * A discovery that fails is reported as a failure. Returning an empty list, or a made-up entry,
   * would both read as an account with nothing on it.
   */
  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const credential = await this.credential(context);
    const { data } = await this.transport.request<CodexModelCatalog>({
      method: 'GET',
      providerId: this.id,
      url: codexModelsUrl(this.clientVersion),
      headers: { accept: 'application/json', authorization: `Bearer ${credential.value}`, originator: CODEX.originator },
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const entries = catalogEntries(data);
    if (entries.length === 0) {
      throw new ProviderError('NOT_SUPPORTED', 'Codex returned no models for this account. The catalog is filtered by client version, so an out-of-date OmniHilbras can be told the account has none.', { providerId: this.id });
    }
    return entries.map(toModel(this.id, credential.email));
  }

  /**
   * Codex's allowance for the signed-in account, read from `/backend-api/wham/usage` — the same
   * meters the Codex CLI shows. The read is account metadata, not an inference request: it spends no
   * tokens. Authenticated exactly as chat is, including the `ChatGPT-Account-ID` header when the
   * credential carries one, because a multi-seat plan reads the account's windows, not the key's.
   */
  async quota(context: ProviderRequestContext = {}): Promise<ProviderQuota> {
    const credential = await this.credential(context);
    const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${credential.value}`, originator: CODEX.originator };
    if (credential.accountId) {
      assertSafeProviderHeaderValue('ChatGPT-Account-ID', credential.accountId, this.id);
      headers['ChatGPT-Account-ID'] = credential.accountId;
    }
    const { data } = await this.transport.request<CodexUsageResponse>({
      method: 'GET',
      providerId: this.id,
      url: CODEX.usageUrl,
      headers,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return parseCodexUsage(data ?? {});
  }

  async validateCredential(credential: ProviderCredential | undefined) {
    if (!credential || credential.type !== 'oauth' || !credential.value) throw new ProviderError('AUTHENTICATION_FAILED', 'A Codex OAuth connection is required.', { providerId: this.id });
    return { status: 'valid' as const, checkedAt: new Date(this.now()).toISOString() };
  }

  /**
   * A real, free, authenticated read: the catalog endpoint is served to every account and bills
   * nothing, so "healthy" means the token was accepted just now rather than a guess.
   *
   * This method spent its life named `health` — a member the adapter contract does not know — so the
   * gateway saw no health check at all and every sweep reported "Health checks are not supported",
   * while the one check that existed answered healthy without asking anyone anything. Both halves
   * were wrong; the name is what made the check invisible and the guess what made it cheap.
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const startedAt = this.now();
    try {
      await this.listModels(context);
      return { status: 'healthy', verified: 'credential', checkedAt: new Date(this.now()).toISOString(), latencyMs: Math.max(0, this.now() - startedAt) };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'credential',
        checkedAt: new Date(this.now()).toISOString(),
        latencyMs: Math.max(0, this.now() - startedAt),
        message: error instanceof Error ? error.message : 'The Codex session could not be checked.',
      };
    }
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const chunks: ChatChunk[] = [];
    for await (const chunk of this.streamChat(request, context)) chunks.push(chunk);
    const text = chunks.map((chunk) => chunk.delta.content ?? '').join('');
    const final = chunks.at(-1);
    return { id: final?.id ?? `codex-${request.model}`, providerId: this.id, model: final?.model ?? request.model, createdAt: new Date(this.now()).toISOString(), message: { role: 'assistant', content: text }, finishReason: final?.finishReason ?? 'stop', ...(final?.usage ? { usage: final.usage } : {}) };
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const credential = await this.credential(context);
    const sessionId = context.requestId ?? createSessionId();
    const headers: Record<string, string> = { authorization: `Bearer ${credential.value}`, accept: 'text/event-stream', 'content-type': 'application/json', originator: CODEX.originator, 'User-Agent': `${CODEX.originator}/${this.clientVersion}`, session_id: sessionId };
    if (credential.accountId) {
      assertSafeProviderHeaderValue('ChatGPT-Account-ID', credential.accountId, this.id);
      headers['ChatGPT-Account-ID'] = credential.accountId;
    }
    const responseId = `codex-${sessionId}`;
    assertSupportedRequest(request);
    const body = { model: request.model, input: request.messages.map(toInput), stream: true, store: false, ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }), ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...(request.topP === undefined ? {} : { top_p: request.topP }), ...(request.stop === undefined ? {} : { stop: [...request.stop] }) };
    let received = false;
    let completed = false;
    for await (const event of parseSseStream(this.transport.stream({ method: 'POST', providerId: this.id, url: CODEX.apiUrl, headers, body: JSON.stringify(body), ...(context.signal ? { signal: context.signal } : {}) }))) {
      const data = parseSseJson<CodexEvent>(event, this.id);
      if (!data) continue;
      if (data.type === 'response.output_text.delta' && typeof data.delta === 'string') {
        received = true;
        yield { id: data.response?.id ?? responseId, providerId: this.id, model: data.response?.model ?? request.model, delta: { content: data.delta } };
      } else if (data.type === 'response.refusal.delta' && typeof data.delta === 'string') {
        received = true;
        yield { id: data.response?.id ?? responseId, providerId: this.id, model: data.response?.model ?? request.model, delta: { content: data.delta } };
      } else if (data.type === 'response.completed') {
        if (data.response?.status !== 'completed' && data.response?.status !== 'incomplete') throw new ProviderError('PROVIDER_REQUEST_FAILED', `Codex completed with unexpected status: ${data.response?.status ?? 'unknown'}.`, { providerId: this.id });
        const usage = usageFrom(data.response?.usage);
        completed = true;
        yield { id: data.response?.id ?? responseId, providerId: this.id, model: data.response?.model ?? request.model, delta: {}, finishReason: codexFinishReason(data.response.status), ...(usage ? { usage } : {}) };
      } else if (data.type === 'response.failed' || data.type === 'error') {
        throw new ProviderError('PROVIDER_REQUEST_FAILED', data.error?.message ?? data.response?.error?.message ?? data.response?.incomplete_details?.reason ?? 'Codex failed to complete the response.', { providerId: this.id });
      }
    }
    if (!completed) throw new ProviderError('INVALID_RESPONSE', 'Codex stream ended without response.completed.', { providerId: this.id });
    if (!received) throw new ProviderError('INVALID_RESPONSE', 'Codex returned no streamed response text.', { providerId: this.id });
  }

  private async credential(context: ProviderRequestContext): Promise<Extract<ProviderCredential, { type: 'oauth' }>> {
    const current = context.credential;
    if (!current || current.type !== 'oauth' || !current.value) throw new ProviderError('AUTHENTICATION_FAILED', 'A Codex OAuth connection is required.', { providerId: this.id });
    const expiresAt = current.expiresAt ? Date.parse(current.expiresAt) : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt > this.now() + renewalWindowMs) return current;
    const refresh = current.refreshToken;
    if (!refresh) throw new ProviderError('AUTHENTICATION_FAILED', 'The Codex session has expired. Sign in again.', { providerId: this.id });
    const memo = this.renewed.get(current.value);
    if (memo) return memo as Extract<ProviderCredential, { type: 'oauth' }>;
    const pending = this.refreshing.get(current.value);
    if (pending) return pending;
    const promise = (async () => {
      const renewed = await refreshCodexCredential({ credential: current, clientId: this.clientId, transport: this.transport, now: this.now, ...(context.signal ? { signal: context.signal } : {}) });
      const oauth = renewed as Extract<ProviderCredential, { type: 'oauth' }>;
      const enriched = { ...oauth, ...(oauth.accountId || !current.accountId ? {} : { accountId: current.accountId }), ...(oauth.email || !current.email ? {} : { email: current.email }) };
      this.renewed.set(current.value, enriched);
      await this.onTokensRefreshed?.(enriched);
      return enriched as Extract<ProviderCredential, { type: 'oauth' }>;
    })();
    this.refreshing.set(current.value, promise);
    try { return await promise; } finally { this.refreshing.delete(current.value); }
  }
}

/**
 * One catalog entry, in the shapes this endpoint has been seen to use. `context_window` is read
 * because the Codex backend reports a window lower than the public API's, and publishing the API's
 * number would overstate what the account can actually send.
 */
type CodexModelEntry = { id?: string; slug?: string; name?: string; display_name?: string; context_window?: number; contextWindow?: number; supported_input_modalities?: string[] };
type CodexModelCatalog = CodexModelEntry[] | { data?: CodexModelEntry[]; models?: CodexModelEntry[]; results?: CodexModelEntry[] };

function catalogEntries(data: CodexModelCatalog | undefined): CodexModelEntry[] {
  if (Array.isArray(data)) return data;
  return data?.data ?? data?.models ?? data?.results ?? [];
}

function toModel(providerId: string, email: string | undefined) {
  return (entry: CodexModelEntry): Model => {
    const id = entry.id ?? entry.slug ?? '';
    const contextWindow = entry.context_window ?? entry.contextWindow;
    return {
      id,
      providerId,
      displayName: entry.display_name ?? entry.name ?? id,
      ...(email ? { ownedBy: email } : {}),
      ...(typeof contextWindow === 'number' && contextWindow > 0 ? { contextWindow } : {}),
      ...(entry.supported_input_modalities?.length ? { inputModalities: entry.supported_input_modalities } : {}),
    };
  };
}

function decodeBase64Url(value: string) {
  if (typeof atob !== 'function') throw new ProviderError('INVALID_RESPONSE', 'Codex returned identity metadata the runtime cannot decode.', { providerId: codexProviderId });
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return decodeURIComponent([...binary].map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
}

function createSessionId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertSupportedRequest(request: ChatRequest): void {
  if (request.tools?.length || request.toolChoice !== undefined) throw new ProviderError('INVALID_REQUEST', 'Codex adapter does not support tool definitions or tool choice.', { providerId: codexProviderId });
  for (const message of request.messages) {
    if (message.toolCalls?.length || message.toolCallId !== undefined || message.name !== undefined || message.reasoning !== undefined || message.thinking !== undefined || message.isError !== undefined) throw new ProviderError('INVALID_REQUEST', 'Codex adapter does not support tool calls or auxiliary message metadata.', { providerId: codexProviderId });
    if (message.content !== null && typeof message.content !== 'string' && message.content.some((part) => part.type !== 'text')) throw new ProviderError('INVALID_REQUEST', 'Codex adapter supports text content only.', { providerId: codexProviderId });
  }
}

function toInput(message: ChatMessage) {
  const type = message.role === 'assistant' ? 'output_text' : 'input_text';
  const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((part) => part.text).join('') : '';
  const role = message.role === 'system' ? 'developer' : message.role;
  return { role, content: [{ type, text }] };
}

function tokenCredential(data: TokenPayload, now = Date.now(), fallbackRefreshToken?: string): ProviderCredential {
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new ProviderError('AUTHENTICATION_FAILED', refusalReason(data) ?? 'Codex did not complete the sign-in. Start again.', { providerId: codexProviderId });
  }
  let accountId: string | undefined;
  if (data.id_token) {
    try {
      const claims = JSON.parse(decodeBase64Url(data.id_token.split('.')[1] ?? '')) as { 'https://api.openai.com/auth'?: { chatgpt_account_id?: string }; email?: string };
      accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
      return { type: 'oauth', value: data.access_token, ...((data.refresh_token ?? fallbackRefreshToken) ? { refreshToken: data.refresh_token ?? fallbackRefreshToken } : {}), ...(typeof data.expires_in === 'number' ? { expiresAt: new Date(now + data.expires_in * 1000).toISOString() } : {}), ...(accountId ? { accountId } : {}), ...(claims.email ? { email: claims.email } : {}) };
    } catch { /* ID token metadata is optional; the access token remains usable. */ }
  }
  return { type: 'oauth', value: data.access_token, ...((data.refresh_token ?? fallbackRefreshToken) ? { refreshToken: data.refresh_token ?? fallbackRefreshToken } : {}), ...(typeof data.expires_in === 'number' ? { expiresAt: new Date(now + data.expires_in * 1000).toISOString() } : {}), ...(accountId ? { accountId } : {}) };
}

function usageFrom(usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return { ...(usage.input_tokens === undefined ? {} : { inputTokens: usage.input_tokens }), ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }), ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }) };
}

export function codexFinishReason(status: string | undefined): FinishReason { return status === 'incomplete' ? 'length' : status === 'completed' ? 'stop' : 'other'; }

export function codexCredentialFromTokenResponse(data: TokenPayload): ProviderCredential { return tokenCredential(data); }

export function codexRedirectUriIsLocal(value: string): boolean {
  try { const url = new URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'); } catch { return false; }
}
