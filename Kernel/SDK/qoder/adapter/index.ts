import { ProviderError } from '../lib/errors.js';
import { parseSseStream } from '../lib/streaming.js';
import { FetchHttpTransport, type HttpTransport } from '../lib/transport.js';
import { sanitizeProviderHeaders } from '../lib/url.js';

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
  ProviderQuota,
  ProviderRequestContext,
  ProviderResourceQuota,
  TokenUsage,
} from '../lib/types.js';

import {
  QODER_MODEL_MAP,
  qoderBuildChatUrl,
  qoderDeviceTokenUrl,
  qoderLoginUrl,
  qoderModelListUrl,
  qoderQuotaUsageUrl,
  qoderUserInfoUrl,
} from '../lib/constants.js';
import { qoderEncodedBytes, qoderEncodeBody } from '../lib/encoding.js';

export {
  QODER_RSA_PUBLIC_KEY,
  QODER_REGION_INTL,
  QODER_REGION_CN,
  QODER_MODEL_MAP,
  QODER_IDE_VERSION,
  QODER_CLIENT_TYPE,
  QODER_DATA_POLICY,
  QODER_LOGIN_VERSION,
  QODER_MACHINE_OS,
  QODER_MACHINE_TYPE,
} from '../lib/constants.js';
export { qoderEncodeBody, qoderEncodedBytes } from '../lib/encoding.js';

export const qoderProviderId = 'qoder';

/**
 * Signs a COSY request. **Injected, not implemented here.**
 *
 * Qoder's signing needs AES-128-CBC, RSA PKCS#1 v1.5 encryption, and MD5 — none of which the Web Crypto
 * API provides, and all of which need `node:crypto`. The SDK barrel is imported by the dashboard, so a
 * `node:crypto` import anywhere reachable from it renders a blank page (`tests/sdk-browser-safety.test.js`
 * is the guard). The gateway implements the signer and passes it in; this adapter is browser-safe.
 */
export type QoderRequestSigner = (input: {
  bodyBytes: Uint8Array;
  requestUrl: string;
  creds: { userId: string; authToken: string; name?: string; email?: string; machineId?: string };
}) => Record<string, string>;

export type QoderAdapterOptions = {
  transport?: HttpTransport;
  timeoutMs?: number;
  region?: 'intl' | 'cn';
  onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  now?: () => number;
  /** The COSY signer. Required for chat; sign-in alone works without it. */
  signRequest?: QoderRequestSigner;
};

type QoderDevicePollResponse = {
  status?: string;
  token?: string;
  access_token?: string;
  refresh_token?: string;
  user_id?: string;
  expires_at?: number | string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type QoderUserInfo = { name?: string; email?: string; organizationId?: string; organization_id?: string };

type QoderModelConfig = {
  key?: string;
  is_reasoning?: boolean;
  source?: string;
  max_output_tokens?: number;
  max_input_tokens?: number;
  context_config?: unknown;
};

type CosySignedResponse = { statusCodeValue?: number; body?: string };

type OpenAiChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: { role?: string; content?: string | null; tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
};

const BILLING_CODES = new Set(['110', '112', '10605']);
const PRICING_HINT = /pricingurl/i;

type QoderQuotaResponse = {
  userType?: unknown;
  usageType?: unknown;
  isQuotaExceeded?: unknown;
  userQuota?: { total?: unknown; used?: unknown; remaining?: unknown; unit?: unknown } | null;
};

function qoderFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

/**
 * The quota response, as the live endpoint answers it (dumped raw 2026-11): a credit pool with
 * absolute figures and the account's own type — `personal_standard`, zero credits remaining, and an
 * `isQuotaExceeded` flag that a pool with nothing remaining already states.
 */
function parseQoderQuota(data: QoderQuotaResponse): ProviderQuota {
  const pool = data.userQuota ?? {};
  const total = Math.max(0, Math.round(qoderFiniteNumber(pool.total, 0)));
  const used = Math.max(0, Math.round(qoderFiniteNumber(pool.used, 0)));
  // The provider's own remaining wins when it is present; falling back to `total - used` keeps a
  // response that omits the field from reading as an exhausted one.
  const remaining = pool.remaining == null ? Math.max(0, total - used) : Math.max(0, Math.round(qoderFiniteNumber(pool.remaining, 0)));
  const unit = typeof pool.unit === 'string' && pool.unit.trim() ? pool.unit : 'credits';
  const row = unit.charAt(0).toUpperCase() + unit.slice(1);
  return {
    plan: typeof data.userType === 'string' && data.userType ? data.userType : 'Qoder',
    resources: { [row]: { used, limit: total, remaining } satisfies ProviderResourceQuota },
  };
}

class QoderAdapter implements ProviderAdapter {
  readonly id = qoderProviderId;
  readonly name = 'Qoder';
  readonly capabilities: ProviderCapabilities = { chat: true, streaming: true, models: true };

  private readonly region: 'intl' | 'cn';
  private readonly transport: HttpTransport;
  private readonly now: () => number;
  private readonly signRequest?: QoderRequestSigner;
  private readonly headers: Record<string, string>;
  private modelConfigCache: { configs: Record<string, QoderModelConfig>; fetchedAt: number } | undefined;

  constructor(options: QoderAdapterOptions = {}) {
    this.region = options.region ?? 'intl';
    this.transport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
    this.now = options.now ?? (() => Date.now());
    this.signRequest = options.signRequest;
    this.headers = sanitizeProviderHeaders(
      { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity' },
      this.id,
    );
  }

  /** Qoder's custom device flow: a locally-minted PKCE pair, a nonce, and a machine id. */
  async beginSignIn(): Promise<{
    deviceCode: string;
    userCode: string;
    verificationUrl: string;
    expiresIn: number;
    codeVerifier: string;
    machineId: string;
  }> {
    const { verifier, challenge } = await generatePkcePair();
    const nonce = randomId();
    const machineId = randomId();
    const params = new URLSearchParams({ challenge, challenge_method: 'S256', machine_id: machineId, nonce });
    return {
      deviceCode: nonce,
      userCode: nonce.slice(0, 8).toUpperCase(),
      verificationUrl: `${qoderLoginUrl(this.region)}?${params.toString()}`,
      expiresIn: 300,
      codeVerifier: verifier,
      machineId,
    };
  }

  async pollSignIn(
    nonce: string,
    signal?: AbortSignal,
    codeVerifier?: string,
    machineId?: string,
  ): Promise<{ status: 'pending' } | { status: 'denied'; error: string } | { status: 'connected'; credential: ProviderCredential }> {
    if (!codeVerifier) return { status: 'denied', error: 'Qoder sign-in state is missing its verifier. Start again.' };
    const url = new URL(qoderDeviceTokenUrl(this.region));
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('verifier', codeVerifier);
    url.searchParams.set('challenge_method', 'S256');

    const response = await this.transport.request<QoderDevicePollResponse>({
      method: 'GET',
      providerId: this.id,
      url: url.toString(),
      headers: { accept: 'application/json', 'User-Agent': 'Go-http-client/2.0' },
      tolerateRefusalBody: true,
      ...(signal ? { signal } : {}),
    });

    if (response.status === 202 || response.status === 404) return { status: 'pending' };
    if (response.status !== 200) {
      const data = response.data ?? {};
      return { status: 'denied', error: data.error_description ?? data.error ?? `Qoder answered HTTP ${response.status}.` };
    }

    const data = response.data ?? {};
    const access = data.token ?? data.access_token ?? '';
    if (!access) {
      if (data.error) return { status: 'denied', error: data.error_description ?? data.error };
      return { status: 'pending' };
    }

    const expiresAt = parseQoderExpiry(data.expires_at, data.expires_in);
    let userInfo: QoderUserInfo = {};
    try {
      userInfo = await this.fetchUserInfo(access, signal);
    } catch {
      // Best-effort; a missing user id makes COSY refuse visibly later.
    }
    const userId = data.user_id ?? '';
    const email = (userInfo.email ?? '').trim() || (userId ? `qoder-user-${userId}` : '');

    return {
      status: 'connected',
      credential: {
        type: 'oauth',
        value: access,
        ...(typeof data.refresh_token === 'string' && data.refresh_token ? { refreshToken: data.refresh_token } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(email ? { email } : {}),
        ...(userId ? { accountId: userId } : {}),
        ...(userInfo.name ? { name: userInfo.name } : {}),
        ...(machineId ? { machineId } : {}),
      },
    };
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const credential = await this.credential(context);
    const configs = await this.fetchModelConfigs(credential, context.signal);
    const entries = Object.entries(configs);
    if (entries.length === 0) return Object.keys(QODER_MODEL_MAP).map((id) => ({ id, providerId: this.id }));
    return entries.map(([id, config]) => ({ id, providerId: this.id, ...(config.key ? { displayName: config.key } : {}) }));
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    let content = '';
    let finishReason: FinishReason = 'stop';
    let usage: TokenUsage | undefined;
    let id = `chat-${request.model}`;
    let model = request.model;
    for await (const chunk of this.streamChat(request, context)) {
      if (chunk.delta.content) content += chunk.delta.content;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.id) id = chunk.id;
      if (chunk.model) model = chunk.model;
    }
    return { id, providerId: this.id, model, createdAt: new Date().toISOString(), message: { role: 'assistant', content }, finishReason, ...(usage ? { usage } : {}) };
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    if (!this.signRequest) {
      throw new ProviderError('NOT_SUPPORTED', 'Qoder chat requires the gateway’s COSY signer.', { providerId: this.id });
    }
    const credential = await this.credential(context);
    const payload = await this.buildPayload(request, credential, context.signal);
    const encoded = qoderEncodeBody(JSON.stringify(payload));
    const encodedBytes = qoderEncodedBytes(encoded);

    const chatUrl = qoderBuildChatUrl(this.region, { accessToken: credential.value });
    const cosy = this.signRequest({
      bodyBytes: encodedBytes,
      requestUrl: chatUrl,
      creds: {
        userId: coysUserId(credential),
        authToken: credential.value,
        ...(credential.name ? { name: credential.name } : {}),
        ...(credential.email ? { email: credential.email } : {}),
        ...(credential.machineId ? { machineId: credential.machineId } : {}),
      },
    });

    const modelKey = payload.model_config?.key ?? request.model;
    const events = this.transport.stream({
      method: 'POST',
      providerId: this.id,
      url: chatUrl,
      headers: { ...this.headers, 'X-Model-Key': modelKey, 'X-Model-Source': payload.model_config?.source ?? 'system', ...cosy },
      body: encoded,
      ...(context.signal ? { signal: context.signal } : {}),
    });

    let sawPayload = false;
    for await (const event of parseSseStream(events)) {
      if (event.data.trim() === '[DONE]') break;
      const envelope = safeJson<CosySignedResponse>(event.data);
      if (!envelope) continue;
      const statusVal = envelope.statusCodeValue ?? 0;
      const innerText = typeof envelope.body === 'string' ? envelope.body : '';
      if (!innerText) continue;

      if (isBillingBlock(innerText)) {
        throw new ProviderError('PROVIDER_REQUEST_FAILED', 'Qoder refused the request: the account has no remaining allowance.', { providerId: this.id });
      }
      if (statusVal >= 400) throw new ProviderError('PROVIDER_REQUEST_FAILED', `Qoder returned status ${statusVal}.`, { providerId: this.id });

      const inner = safeJson<OpenAiChunk>(innerText);
      if (!inner) continue;
      sawPayload = true;
      const choice = inner.choices?.[0];
      const delta = choice?.delta;
      yield {
        id: inner.id ?? `stream-${request.model}`,
        providerId: this.id,
        model: inner.model ?? request.model,
        delta: {
          ...(delta?.role ? { role: normalizeRole(delta.role) } : {}),
          ...(delta?.content ? { content: delta.content } : {}),
          ...(delta?.tool_calls?.length ? { toolCalls: delta.tool_calls.map(normalizeToolCallDelta) } : {}),
        },
        ...(choice?.finish_reason ? { finishReason: normalizeFinishReason(choice.finish_reason) } : {}),
        ...(inner.usage ? { usage: normalizeUsage(inner.usage) } : {}),
      };
    }
    if (!sawPayload) throw new ProviderError('INVALID_RESPONSE', 'Qoder returned no chat content.', { providerId: this.id });
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

  /**
   * Qoder's allowance for the signed-in account, read from `/api/v2/quota/usage`.
   *
   * The response is a **credit pool**, not a time window: absolute `used`/`total`/`remaining` in the
   * unit the account is metered in (credits), beside the account's own type. So the row is named for
   * the unit the vendor reports and carries the absolute figures as-is — a percentage here would be
   * the gateway inventing a shape the provider did not send. `isQuotaExceeded` is not a separate
   * state: a pool with nothing remaining reads as exhausted on its own. Reading it is account
   * metadata and spends no credits.
   */
  async quota(context: ProviderRequestContext = {}): Promise<ProviderQuota> {
    const credential = await this.credential(context);
    const { data } = await this.transport.request<QoderQuotaResponse>({
      method: 'GET',
      providerId: this.id,
      url: qoderQuotaUsageUrl(this.region),
      headers: { accept: 'application/json', Authorization: `Bearer ${credential.value}` },
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return parseQoderQuota(data ?? {});
  }

  isCredentialExpired(credential: ProviderCredential | undefined, now?: number): boolean | undefined {
    if (!credential || credential.type !== 'oauth') return undefined;
    if (typeof credential.expiresAt !== 'string') return undefined;
    const at = Date.parse(credential.expiresAt);
    if (!Number.isFinite(at)) return undefined;
    return at - 30_000 <= (now ?? this.now());
  }

  private async fetchUserInfo(accessToken: string, signal?: AbortSignal): Promise<QoderUserInfo> {
    const response = await this.transport.request<QoderUserInfo>({
      method: 'GET',
      providerId: this.id,
      url: qoderUserInfoUrl(this.region),
      headers: { accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      ...(signal ? { signal } : {}),
    });
    return response.data ?? {};
  }

  private async credential(context: ProviderRequestContext): Promise<Extract<ProviderCredential, { type: 'oauth' }>> {
    const current = context.credential;
    if (!current || current.type !== 'oauth' || !current.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Qoder needs an OAuth sign-in.', { providerId: this.id });
    }
    return current;
  }

  private async fetchModelConfigs(credential: Extract<ProviderCredential, { type: 'oauth' }>, signal?: AbortSignal): Promise<Record<string, QoderModelConfig>> {
    const cached = this.modelConfigCache;
    if (cached && Date.now() - cached.fetchedAt < 10 * 60_000) return cached.configs;
    if (!this.signRequest) return {};

    const url = qoderModelListUrl(this.region);
    // **GET, empty body.** The model list is a read, and Qoder's endpoint refuses POST with
    // "Request method 'POST' not supported" — the old project signs an empty body over the GET.
    const cosy = this.signRequest({
      bodyBytes: new Uint8Array(0),
      requestUrl: url,
      creds: {
        userId: coysUserId(credential),
        authToken: credential.value,
        ...(credential.name ? { name: credential.name } : {}),
        ...(credential.email ? { email: credential.email } : {}),
        ...(credential.machineId ? { machineId: credential.machineId } : {}),
      },
    });
    const response = await this.transport.request<{ data?: unknown }>({
      method: 'GET',
      providerId: this.id,
      url,
      headers: { ...this.headers, Accept: 'application/json', ...cosy },
      ...(signal ? { signal } : {}),
    });
    const configs = extractModelConfigs(response.data);
    this.modelConfigCache = { configs, fetchedAt: Date.now() };
    return configs;
  }

  private async buildPayload(request: ChatRequest, credential: Extract<ProviderCredential, { type: 'oauth' }>, signal?: AbortSignal) {
    const configs = await this.fetchModelConfigs(credential, signal);
    const requestedKey = request.model.replace(/^qoder\//, '');
    const resolvedKey = QODER_MODEL_MAP[requestedKey] ?? requestedKey;
    const modelConfig = configs[resolvedKey] ?? configs[requestedKey] ?? { key: resolvedKey };

    const { messages, systemText } = normalizeMessages(request.messages);
    const lastUser = lastUserText(request.messages);
    const maxTokens = pickMaxTokens(request.maxOutputTokens, modelConfig.max_output_tokens);
    const sessionId = stableHash('qoder-session', coysUserId(credential), resolvedKey);
    const recordId = stableChatRecordId(resolvedKey, request.messages, request.tools, maxTokens);

    return {
      request_id: randomId(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: 'FREE_INPUT',
      is_reply: true,
      is_retry: false,
      source: 1,
      version: '3',
      session_type: 'qodercli',
      agent_id: 'agent_common',
      task_id: 'common',
      code_language: '',
      chat_prompt: '',
      image_urls: null,
      aliyun_user_type: '',
      system: systemText,
      messages,
      tools: Array.isArray(request.tools) ? request.tools : [],
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: '',
        imageUrls: null,
        extra: { context: [], modelConfig: { key: resolvedKey, is_reasoning: Boolean(modelConfig.is_reasoning) }, originalContent: lastUser },
        features: [],
        text: lastUser,
      },
      model_config: modelConfig,
      business: { product: 'cli', version: '1.0.0', type: 'agent', stage: 'start', id: randomId(), name: lastUser.slice(0, 30), begin_at: Date.now() },
    };
  }
}

export function createQoderAdapter(options: QoderAdapterOptions = {}): ProviderAdapter {
  return new QoderAdapter(options);
}

/* ------------------------------------------------------------------ *
 * Browser-safe helpers (Web Crypto for randomness and SHA-256).
 * ------------------------------------------------------------------ */

async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const random = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const verifier = toBase64Url(random);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: toBase64Url(new Uint8Array(digest)) };
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return toBase64Url(bytes);
}

function coysUserId(credential: ProviderCredential): string {
  return credential.type === 'oauth' ? credential.accountId ?? '' : '';
}

function isBillingBlock(innerBody: string): boolean {
  if (PRICING_HINT.test(innerBody)) return true;
  const parsed = safeJson<{ code?: unknown; error?: { code?: unknown } }>(innerBody);
  if (!parsed) return false;
  return BILLING_CODES.has(String(parsed.code ?? parsed.error?.code ?? ''));
}

function parseQoderExpiry(expiresAt: unknown, expiresIn: unknown): string | undefined {
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) return new Date(Date.now() + expiresIn * 1000).toISOString();
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) return new Date(expiresAt).toISOString();
  if (typeof expiresAt === 'string' && expiresAt.trim()) {
    const numeric = Number(expiresAt);
    if (Number.isFinite(numeric) && numeric > 1e12) return new Date(numeric).toISOString();
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

function pickMaxTokens(requested: number | undefined, configured: number | undefined): number {
  const base = configured && configured > 0 ? configured : 32768;
  if (typeof requested === 'number' && requested > 0) return Math.min(requested, base);
  return base;
}

function stableHash(prefix: string, ...parts: Array<string | number | undefined>): string {
  // A non-cryptographic but stable hash is enough for session/record ids; kept synchronous and
  // browser-safe (no node:crypto). These ids only need to be stable across requests on one account.
  const input = [prefix, ...parts.map((p) => String(p ?? ''))].join('\0');
  return fnv1a(input);
}

function stableChatRecordId(model: string, messages: readonly ChatMessage[], tools: unknown, maxTokens: number): string {
  const parts = [model];
  for (const message of messages) parts.push(message.role, typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''));
  return fnv1a(['qoder-record', ...parts, JSON.stringify(tools ?? []), String(maxTokens)].join('\0'));
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0') + input.length.toString(16).padStart(8, '0');
}

function normalizeMessages(messages: readonly ChatMessage[]): { messages: Array<{ role: string; content: unknown }>; systemText: string } {
  const systemParts: string[] = [];
  const out: Array<{ role: string; content: unknown }> = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const text = typeof message.content === 'string' ? message.content : contentToText(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    out.push({ role: message.role, content: normalizeContent(message.content) });
  }
  return { messages: out, systemText: systemParts.join('\n\n') };
}

function normalizeContent(content: ChatMessage['content']): unknown {
  if (content === null || typeof content === 'string') return content;
  if (content.every((part) => part.type === 'text')) return content.map((part) => (part as { text: string }).text).join('');
  return content.map((part) => (part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image_url', image_url: { url: part.imageUrl.url } }));
}

function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  return '';
}

function lastUserText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === 'user') return contentToText(message.content).slice(0, 2000);
  }
  return '';
}

function extractModelConfigs(data: unknown): Record<string, QoderModelConfig> {
  const out: Record<string, QoderModelConfig> = {};
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.key === 'string' && record.key) {
      out[record.key] = record as QoderModelConfig;
      return;
    }
    for (const value of Object.values(record)) visit(value);
  };
  if (data && typeof data === 'object' && 'data' in data) visit((data as { data: unknown }).data);
  else visit(data);
  return out;
}

function safeJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function normalizeRole(role: string): ChatMessage['role'] {
  return role === 'assistant' || role === 'system' || role === 'tool' ? role : 'user';
}

function normalizeFinishReason(reason: string | null | undefined): FinishReason {
  return reason === 'length' || reason === 'tool_calls' || reason === 'content_filter' ? reason : 'stop';
}

function normalizeUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } }): TokenUsage {
  return {
    ...(typeof usage.prompt_tokens === 'number' ? { inputTokens: usage.prompt_tokens } : {}),
    ...(typeof usage.completion_tokens === 'number' ? { outputTokens: usage.completion_tokens } : {}),
    ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
    ...(usage.prompt_tokens_details?.cached_tokens === undefined ? {} : { cacheReadTokens: usage.prompt_tokens_details.cached_tokens }),
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
