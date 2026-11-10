import type { ModelMetaMap } from '@omnihilbras/kernel-api/public';
import { desktopBridge, type OmniBridge } from './electronBridge';

export type GatewayProviderHealth = {
  providerId: string;
  status: 'healthy' | 'degraded' | 'unavailable';
  /**
   * What the check established, from the SDK's own vocabulary.
   *
   * `credential` means the credential was accepted and the catalog or session is readable. It does
   * **not** mean a model can answer — measured, two OpenCode connections reported `healthy` with
   * `verified: 'credential'` while every model on them was refused by the provider. `inference` means a
   * request actually completed, which is the only value that justifies calling a route usable.
   */
  verified: 'credential' | 'inference';
  latencyMs?: number;
  message?: string;
  checkedAt: string;
};

export type GatewayHealth = {
  service: string;
  status: 'ok' | 'degraded';
  checkedAt: string;
  providers: GatewayProviderHealth[];
};

export type GatewayResilience = {
  /** Per-request budget in ms. 0 uses the shared default. */
  timeoutMs: number;
  /** Extra attempts after the first failure. */
  maxRetries: number;
  /** Requests allowed per minute. 0 disables the limit. */
  requestsPerMinute: number;
  /** Requests allowed in flight at once. 0 or absent disables the limit. */
  maxConcurrentRequests?: number;
  /**
   * Delay before a second connection is raced against the first. 0 disables
   * hedging. Only sent when another connection can serve the same model.
   */
  hedgeAfterMs: number;
};

export type GatewayConnection = {
  id: string;
  providerId: string;
  name: string;
  endpoint: string;
  priority: number;
  proxyPool: string;
  enabled: boolean;
  hasCredential: boolean;
  /** The account identity the credential carries (an OAuth email), when it has one. */
  email?: string;
  /** The kind of credential this connection holds — for the account row's badge. Never the value. */
  credentialType?: 'oauth' | 'api-key' | 'none';
  modelPolicy: 'free' | 'all';
  modelIds: string[];
  customModelIds: string[];
  /** Catalog metadata for `modelIds`, when the provider published any. */
  modelMeta?: ModelMetaMap;
  resilience: GatewayResilience;
  /** Who is accountable for this connection, and what it is for. Absent means not recorded. */
  responsibility?: { owner?: string; purpose?: string };
  createdAt: string;
  updatedAt: string;
};

export type GatewayRoutingState = {
  failureThreshold: number;
  /** The strategy set for each provider; a provider with none set is `priority`. */
  strategies?: Partial<Record<string, GatewayProviderStrategy>>;
  connections: Array<{
    connectionId: string;
    providerId: string;
    enabled: boolean;
    hasCredential: boolean;
    /** Measured round trip for this account, once it has served a request. Absent means never measured. */
    latency?: { latencyMs: number; samples: number; measuredAt: string };
    resilience: GatewayResilience;
    /**
     * How long routing was last told this connection must wait, in ms.
     *
     * Absent when no request has asked about its limit; `0` when it was asked and is free. The
     * difference matters because the gateway records a zero deliberately (`rate-limit-policy.ts`):
     * *never checked* and *not waiting* are different answers.
     */
    rateLimitWaitMs?: number;
    failures?: number;
    successes?: number;
    ejected?: boolean;
    lastCheckedAt?: string;
    lastLatencyMs?: number;
    lastError?: string;
  }>;
};

export type GatewayConnectionValidation = {
  providerId: string;
  valid: true;
  checkedAt: string;
  latencyMs?: number;
};

export type GatewayModelTestResult = {
  model: string;
  provider: string;
  content: string;
  finishReason?: string;
  latencyMs: number;
  /**
   * Set when the model answered but the reply was reasoning-only: it spent the
   * whole budget thinking and emitted no text. That is a working connection, and
   * saying so is more honest than reporting an empty response.
   */
  note?: string;
};

export type OpenRouterConnectionInput = {
  name: string;
  apiKey: string;
  priority: number;
  proxyPool: string;
  enabled?: boolean;
  modelPolicy: 'free' | 'all';
};

export type GatewayApiKey = {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};

export type GatewayApiKeyList = {
  keys: GatewayApiKey[];
  requireApiKey: boolean;
};

// In development the dashboard calls its own origin, and Vite forwards `/v1` to the gateway with the
// per-launch dashboard token attached. In a production build there is no such proxy, so the gateway URL is used.
const gatewayBaseUrl = import.meta.env.DEV && typeof window !== 'undefined'
  ? normalizeGatewayBaseUrl(window.location.origin)
  : normalizeGatewayBaseUrl(
      (typeof globalThis !== 'undefined' ? (globalThis as { __OMNIHILBRAS_GATEWAY_URL__?: unknown }).__OMNIHILBRAS_GATEWAY_URL__ : undefined) as string
        ?? import.meta.env.VITE_GATEWAY_URL
        ?? 'http://127.0.0.1:8787',
    );

/**
 * The gateway's base URL, for callers that need to reach it outside `requestJson`.
 *
 * The status poller is one of them, and it cannot use a relative path: the gateway is on a
 * different port from the dashboard, so `/v1/connections` would reach Vite instead.
 */
export const gatewayBase = gatewayBaseUrl;

/** The same value as a call, for callers the truthfulness guard treats as data sources. */
export function gatewayOrigin() {
  return gatewayBaseUrl;
}

/**
 * A device key injected by the Android shell at runtime.
 *
 * The shell must put it in Keystore-backed storage and set this value before the dashboard mounts; this
 * module never writes it to localStorage or a cookie. A browser build has no value and keeps using the
 * gateway's local-mode behavior.
 */
function gatewayDeviceToken(): string | undefined {
  if (typeof globalThis === 'undefined') return undefined;
  const value = (globalThis as { __OMNIHILBRAS_GATEWAY_TOKEN__?: unknown }).__OMNIHILBRAS_GATEWAY_TOKEN__;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function gatewayAuthHeaders(): Record<string, string> {
  const token = gatewayDeviceToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function normalizeGatewayBaseUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = hostname === 'localhost' || hostname === '::1' || isLoopbackIpv4(hostname);
    // A remote gateway is only acceptable over HTTPS. Plain HTTP to a non-loopback host would put the
    // device key and every request on the wire in clear text.
    const secureRemote = url.protocol === 'https:';
    if ((!loopback && !secureRemote) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function isLoopbackIpv4(hostname: string) {
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

export async function getGatewayHealth(signal?: AbortSignal) {
  return requestJson<GatewayHealth>('/health', { signal });
}

/**
 * Whether the gateway is currently answering.
 *
 * Set by every request, so the dashboard can tell "the gateway is down" from "this failed",
 * and — more usefully — can tell when a gateway that *was* down has come back. A page that
 * rendered the down message once used to keep it forever, because nothing re-checked: the
 * only way out was a manual reload, which is exactly the wrong instinct when the fix is
 * something else entirely.
 */
let gatewayReachable: boolean | undefined;
const gatewayReachabilityListeners = new Set<(reachable: boolean) => void>();

function noteGatewayReachability(reachable: boolean): void {
  if (gatewayReachable === reachable) return;
  gatewayReachable = reachable;
  for (const listener of gatewayReachabilityListeners) {
    try {
      listener(reachable);
    } catch {
      // A listener that throws must not break the request that woke it.
    }
  }
}

export function isGatewayReachable(): boolean | undefined {
  return gatewayReachable;
}

/** Subscribes to reachability changes. Returns an unsubscribe function. */
export function onGatewayReachabilityChange(listener: (reachable: boolean) => void): () => void {
  gatewayReachabilityListeners.add(listener);
  return () => {
    gatewayReachabilityListeners.delete(listener);
  };
}

export type GatewayVirtualModelTarget = {
  connectionId: string;
  upstreamModelId: string;
  priority: number;
  enabled: boolean;
};

export type GatewayVirtualModel = {
  id: string;
  name: string;
  enabled: boolean;
  strategy: 'priority' | 'round-robin' | 'fastest';
  targets: GatewayVirtualModelTarget[];
  createdAt: string;
  updatedAt: string;
};

export async function listGatewayVirtualModels(signal?: AbortSignal) {
  const response = await requestJson<{ data: GatewayVirtualModel[] }>('/v1/virtual-models', { signal });
  return response.data;
}

export async function saveGatewayVirtualModel(input: {
  id: string;
  name?: string;
  enabled?: boolean;
  strategy?: GatewayVirtualModel['strategy'];
  targets: Array<{ connectionId: string; upstreamModelId: string; priority?: number; enabled?: boolean }>;
}, signal?: AbortSignal) {
  return requestJson<{ model: GatewayVirtualModel }>('/v1/virtual-models', {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
}

export async function updateGatewayVirtualModel(id: string, input: {
  name?: string;
  enabled?: boolean;
  strategy?: GatewayVirtualModel['strategy'];
  targets: Array<{ connectionId: string; upstreamModelId: string; priority?: number; enabled?: boolean }>;
}, signal?: AbortSignal) {
  return requestJson<{ model: GatewayVirtualModel }>(`/v1/virtual-models/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ id, ...input }),
    signal,
  });
}

export async function removeGatewayVirtualModel(id: string, signal?: AbortSignal) {
  return requestJson<{ deleted: boolean; id: string }>(`/v1/virtual-models/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
  });
}

export async function listGatewayConnections(signal?: AbortSignal) {
  const body = await requestJson<{ object: 'list'; data: GatewayConnection[] }>('/v1/connections', { signal });
  return body.data;
}

/**
 * Health for one provider.
 *
 * Not a filter over `/health`: that endpoint probes every active adapter, so asking it about
 * a single card meant waiting for the whole registry. A dashboard card shows one provider, so
 * it asks about one provider.
 */
/**
 * Probes **one saved connection** with its own stored credential.
 *
 * `/v1/health/:providerId` answers about a provider, and a provider with several accounts has no
 * single answer — the resolver picks the first — so "Test provider" on the second row used to test
 * the first account. A row calls this and tests itself.
 */
export async function probeGatewayConnection(connectionId: string, signal?: AbortSignal) {
  return requestJson<{ providerId: string; valid: boolean; checkedAt: string; latencyMs?: number }>(
    `/v1/connections/${encodeURIComponent(connectionId)}/probe`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ...(signal ? { signal } : {}) },
  );
}

export async function getGatewayProviderHealth(providerId: string, signal?: AbortSignal) {
  const body = await requestJson<{ provider: GatewayProviderHealth }>(`/v1/health/${encodeURIComponent(providerId)}`, { signal });
  return body.provider;
}

/**
 * Asks the gateway to check a candidate key for **any** provider.
 *
 * This used to be `checkOpenRouterConnection`, and it posted to a hardcoded
 * `/v1/connections/openrouter/check` while the save beside it was already generic
 * (`putGatewayConnection(providerId, …)`). Two spellings of one decision, and the consequence was not
 * cosmetic: the dashboard could only test an OpenRouter key, because it had no way to name a different
 * provider — even though the gateway has served `POST /v1/connections/:providerId/check` for every
 * provider since the duplicate route was deleted.
 *
 * `endpoint` is passed when the card has one, because a self-hosted or proxied provider is checked
 * against the address it will actually be saved with. The gateway puts it through the same address
 * check a saved connection gets.
 */
export function checkConnectionCredential(providerId: string, input: { apiKey: string; endpoint?: string }, signal?: AbortSignal) {
  return requestJson<GatewayConnectionValidation>(`/v1/connections/${encodeURIComponent(providerId)}/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: input.apiKey, ...(input.endpoint ? { endpoint: input.endpoint } : {}) }),
    ...(signal ? { signal } : {}),
  });
}

/**
 * A connection to save: **a key, or no credential at all — never an empty string.**
 *
 * This was `{ apiKey: string; ... }`, and that one required field is why two shipped defects existed. A
 * caller with no key to send had to invent one, so `ProvidersPage` sent `apiKey: ''` — which the gateway
 * refuses — under a comment asserting that the gateway "stores nothing secret for it", and
 * `ProviderDetailPage` threw before asking at all. Ollama, the only `auth: 'No key'` card, could not be
 * connected from either page.
 *
 * As a union there is no third option to reach for: a caller that cannot produce a key must say
 * `credential: 'none'` out loud, and `pnpm typecheck` is what makes it do so.
 */
export type GatewayConnectionInput = {
  /**
   * The connection to save to. The gateway accepts it "so a caller can add a second connection for a
   * provider that already has one" — omitting it reuses that provider's existing connection, which is
   * the repair behaviour. A caller that wants a second account mints one.
   */
  id?: string;
  name?: string;
  endpoint: string;
  priority?: number;
  proxyPool?: string;
  modelPolicy?: 'free' | 'all';
} & ({ apiKey: string; credential?: never } | { credential: 'none'; apiKey?: never });

/**
 * Saves any OpenAI-compatible provider by id. The gateway builds an adapter for
 * the endpoint on demand, so a provider needs no code change to be connectable.
 */
export function putGatewayConnection(providerId: string, input: GatewayConnectionInput, signal?: AbortSignal) {
  return requestJson<{ connection: GatewayConnection; duplicate?: 'identical' | 'updated' }>(`/v1/connections/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  }).then((body) => body.connection);
}

/**
 * The same save, reporting whether the credential was already saved.
 *
 * `identical` wrote nothing — the key is already an account, and the caller should say which one
 * instead of implying it added a twin. `updated` renewed that account's credential in place.
 */
export async function saveGatewayConnectionDetailed(providerId: string, input: GatewayConnectionInput, signal?: AbortSignal) {
  return requestJson<{ connection: GatewayConnection; duplicate?: 'identical' | 'updated' }>(`/v1/connections/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
}

export function saveOpenRouterConnection(input: OpenRouterConnectionInput, signal?: AbortSignal) {
  return requestJson<{ connection: GatewayConnection }>('/v1/connections/openrouter', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  }).then((body) => body.connection);
}

/**
 * Big enough that a reasoning model finishes thinking and still answers.
 *
 * A small probe starves the answer: reasoning models spend their budget on
 * chain-of-thought first, so a tiny limit yields `finish_reason: length` with no
 * content at all and the model looks broken. Cost is bounded by what a model
 * actually generates, not by this cap, and a model that answers in five tokens
 * still costs five tokens.
 */
export const MODEL_TEST_MAX_TOKENS = 1024;

/** A tool call is a real answer even with no text, so it must not read as empty. */
function hasToolCalls(message: Record<string, unknown>) {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

/**
 * Reasoning output, under any of the field names providers use for it. Its
 * presence proves the model generated tokens, which is all a connectivity probe
 * needs to know.
 */
function readReasoning(message: Record<string, unknown>): string {
  for (const field of ['reasoning', 'reasoning_content', 'thinking', 'thinking_content']) {
    const value = message[field];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.length > 0) return JSON.stringify(value);
  }
  return '';
}

export type GatewayChatMessage = { role: 'user' | 'assistant'; content: string };

export type GatewayChatTurn = {
  content: string;
  provider: string;
  model: string;
  latencyMs: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /**
   * Whether the answer actually arrived in pieces.
   *
   * False for providers that cannot stream — DeepSeek Web, and any other adapter declaring
   * `streaming: false`. The gateway answers such a request `501 NOT_SUPPORTED`, and the panel
   * retries it as one request rather than showing the user a refusal: the provider works, it
   * just cannot do it in a stream, and "this model cannot be tested here" would be wrong.
   */
  streamed: boolean;
};

/**
 * One streamed turn through `/v1/chat/completions`.
 *
 * Streaming, not a single JSON body, because a chat that shows nothing for eight seconds and
 * then prints the whole answer is not a chat — and on the providers page, where the whole
 * point is comparing models, the wait *is* the observation. The caller gets deltas as they
 * arrive and can stop mid-answer.
 *
 * Errors are raised as `Error` carrying the gateway's own message. That is deliberate: the
 * alternative is a panel that says "something went wrong" while the model above it was
 * refused for a specific, actionable reason.
 */
export async function streamGatewayChat(
  request: { providerId: string; model: string; messages: GatewayChatMessage[]; maxTokens?: number; stream?: boolean },
  onDelta: (delta: string, accumulated: string) => void,
  signal?: AbortSignal,
): Promise<GatewayChatTurn> {
  if (!gatewayBaseUrl) throw new Error('Gateway URL must target a loopback address.');
  const bridge = desktopBridge();
  if (bridge) return streamGatewayChatViaBridge(bridge, request, onDelta, signal);
  if (request.stream === false) {
    return sendWithoutStreaming(request, onDelta, signal, Date.now());
  }
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...gatewayAuthHeaders(), 'x-omnihilbras-provider': request.providerId },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens ?? 2048,
        stream: true,
      }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) noteGatewayReachability(false);
    throw error;
  }
  noteGatewayReachability(true);

  if (!response.ok) {
    // The gateway routes errors as JSON, and the message inside is the provider's reason.
    const text = await response.text().catch(() => '');
    let code = '';
    let message = `The gateway refused this request with ${response.status}.`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
      if (parsed.error?.message) message = parsed.error.message;
      code = parsed.error?.code ?? '';
    } catch {
      if (text.trim()) message = text.trim().slice(0, 400);
    }
    // A provider that cannot stream is not a provider that cannot answer. Send the same turn
    // as one request so the panel still works against it, and report `streamed: false` so the
    // user is told the answer arrived at once rather than being left waiting on deltas.
    if (code === 'NOT_SUPPORTED') {
      return sendWithoutStreaming(request, onDelta, signal, startedAt);
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error('The gateway returned no response body to stream from.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state: SseState = { content: '', provider: request.providerId, model: request.model };

  // SSE frames are separated by a blank line, and a frame can be split across reads, so the
  // tail is carried over rather than parsed per chunk.
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      consumeSseFrame(frame, state, onDelta);
      boundary = buffer.indexOf('\n\n');
    }
  }
  return { content: state.content, provider: state.provider, model: state.model, latencyMs: Date.now() - startedAt, streamed: true, ...(state.usage ? { usage: state.usage } : {}) };
}

function safeErrorPayload(payload: string) {
  try {
    const parsed = JSON.parse(payload) as { error?: { message?: string } };
    return parsed.error?.message ?? 'The stream failed partway through.';
  } catch {
    return 'The stream failed partway through.';
  }
}

type SseState = {
  content: string;
  provider: string;
  model: string;
  usage?: GatewayChatTurn['usage'];
};

/** One SSE frame from the chat stream, applied to the running state. Shared by both transports. */
function consumeSseFrame(frame: string, state: SseState, onDelta: (delta: string, accumulated: string) => void) {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return;
  const payload = dataLine.slice(5).trim();
  if (payload === '[DONE]') return;
  // A stream that fails mid-answer reports it as an event, not a status code — by then the 200 is
  // long gone, so this is the only place the reason can come from.
  if (frame.includes('event: error')) throw new Error(safeErrorPayload(payload));

  let parsed: { choices?: Array<{ delta?: { content?: string } }>; provider?: string; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  try {
    parsed = JSON.parse(payload) as typeof parsed;
  } catch {
    return;
  }
  if (parsed.provider) state.provider = parsed.provider;
  if (parsed.model) state.model = parsed.model;
  if (parsed.usage) {
    state.usage = {
      promptTokens: parsed.usage.prompt_tokens ?? 0,
      completionTokens: parsed.usage.completion_tokens ?? 0,
      totalTokens: parsed.usage.total_tokens ?? 0,
    };
  }
  const delta = parsed.choices?.[0]?.delta?.content;
  if (delta) {
    state.content += delta;
    onDelta(delta, state.content);
  }
}

/**
 * The same streaming turn through the desktop bridge.
 *
 * The renderer cannot open a cross-origin SSE connection under `app://`, and the token must not be in
 * the page. Main sends decoded text chunks over IPC; this keeps the one SSE parser above.
 */
async function streamGatewayChatViaBridge(
  bridge: OmniBridge,
  request: { providerId: string; model: string; messages: GatewayChatMessage[]; maxTokens?: number },
  onDelta: (delta: string, accumulated: string) => void,
  signal?: AbortSignal,
): Promise<GatewayChatTurn> {
  const startedAt = Date.now();
  const state: SseState = { content: '', provider: request.providerId, model: request.model };
  let buffer = '';
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;

  const cancel = bridge.gateway.streamChat('/v1/chat/completions', {
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 2048,
      stream: true,
    }),
  }, {
    onChunk: (text) => {
      buffer += text;
      try {
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          consumeSseFrame(frame, state, onDelta);
          boundary = buffer.indexOf('\n\n');
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error('The stream failed.');
        ended = true;
        cancel();
      }
      wake?.();
      wake = undefined;
    },
    onEnd: () => {
      ended = true;
      wake?.();
      wake = undefined;
    },
    onError: (error) => {
      failure = error;
      ended = true;
      wake?.();
      wake = undefined;
    },
  });

  const abort = () => {
    failure = new DOMException('Stopped.', 'AbortError');
    ended = true;
    cancel();
    wake?.();
    wake = undefined;
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!ended || buffer.includes('\n\n')) {
      if (!ended) await new Promise<void>((resolve) => { wake = resolve; });
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) continue;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      consumeSseFrame(frame, state, onDelta);
    }
    if (failure) throw failure;
  } finally {
    signal?.removeEventListener('abort', abort);
    cancel();
  }
  return {
    content: state.content,
    provider: state.provider,
    model: state.model,
    latencyMs: Date.now() - startedAt,
    streamed: true,
    ...(state.usage ? { usage: state.usage } : {}),
  };
}

/**
 * The same turn, asked for in one piece.
 *
 * Used only when the gateway refuses to stream a provider that works. The content is still
 * handed to `onDelta` so the transcript renders identically — the caller does not need two
 * code paths for "the answer is on screen".
 */
async function sendWithoutStreaming(
  request: { providerId: string; model: string; messages: GatewayChatMessage[]; maxTokens?: number },
  onDelta: (delta: string, accumulated: string) => void,
  signal: AbortSignal | undefined,
  startedAt: number,
): Promise<GatewayChatTurn> {
  const response = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...gatewayAuthHeaders(), 'x-omnihilbras-provider': request.providerId },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 2048,
      stream: false,
    }),
    ...(signal ? { signal } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = `The gateway refused this request with ${response.status}.`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      if (text.trim()) message = text.trim().slice(0, 400);
    }
    throw new Error(message);
  }
  const body = JSON.parse(text) as {
    provider?: string;
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const content = body.choices?.[0]?.message?.content ?? '';
  if (content) onDelta(content, content);
  return {
    content,
    provider: body.provider ?? request.providerId,
    model: body.model ?? request.model,
    latencyMs: Date.now() - startedAt,
    streamed: false,
    ...(body.usage
      ? {
          usage: {
            promptTokens: body.usage.prompt_tokens ?? 0,
            completionTokens: body.usage.completion_tokens ?? 0,
            totalTokens: body.usage.total_tokens ?? 0,
          },
        }
      : {}),
  };
}

export async function testGatewayModel(providerId: string, model: string, options?: AbortSignal | { signal?: AbortSignal; maxTokens?: number }) {
  const signal = options instanceof AbortSignal ? options : options?.signal;
  const maxTokens = options instanceof AbortSignal ? MODEL_TEST_MAX_TOKENS : options?.maxTokens ?? MODEL_TEST_MAX_TOKENS;
  const startedAt = Date.now();
  const body = await requestJson<unknown>('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-omnihilbras-provider': providerId,
    },
    body: JSON.stringify({
      model,
      // Deliberately trivial. The probe measures whether the model answers, not
      // what it can write, and a longer prompt only adds tokens to reason about.
      messages: [{ role: 'user', content: 'hi' }],
      // Large enough for a reasoning model to finish thinking and still answer.
      // At 16 tokens several models spent the whole budget on hidden reasoning
      // and returned nothing at all, which read as a pass.
      max_tokens: maxTokens,
      stream: false,
    }),
    ...(signal ? { signal } : {}),
  });
  if (!isRecord(body) || body.object !== 'chat.completion' || !Array.isArray(body.choices)) {
    throw new Error('The gateway returned an invalid model test response.');
  }
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) throw new Error('The gateway returned an invalid model test response.');
  const content = choice.message.content;
  const text = typeof content === 'string' ? content.trim() : '';
  const reasoning = readReasoning(choice.message);
  const truncated = choice.finish_reason === 'length';

  // A reasoning model that spends the whole budget thinking and emits no text has
  // still proved the connection works. Reporting that as a failure is what made
  // working models look broken here while they behaved in other clients.
  if (!text && reasoning) {
    return {
      model: typeof body.model === 'string' ? body.model : model,
      provider: typeof body.provider === 'string' ? body.provider : providerId,
      content: '',
      finishReason: 'length',
      note: 'Reasoning-only reply — the model answered, using its whole budget to think.',
      latencyMs: Math.max(0, Date.now() - startedAt),
    } satisfies GatewayModelTestResult;
  }

  // A response with no visible text and no reasoning is not a working model,
  // however well formed the envelope is.
  if (!text && !hasToolCalls(choice.message)) {
    if (truncated && maxTokens < MODEL_TEST_MAX_TOKENS * 2) {
      return testGatewayModel(providerId, model, { ...(signal ? { signal } : {}), maxTokens: maxTokens * 2 });
    }
    throw new Error(truncated
      ? 'The model produced no output within the test budget.'
      : 'The model returned an empty response.');
  }
  return {
    model: typeof body.model === 'string' ? body.model : model,
    provider: typeof body.provider === 'string' ? body.provider : providerId,
    content: typeof content === 'string' ? content : '',
    ...(typeof choice.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
    latencyMs: Math.max(0, Date.now() - startedAt),
  } satisfies GatewayModelTestResult;
}

export function addGatewayConnectionModels(connectionId: string, modelIds: string[], signal?: AbortSignal) {
  return requestJson<{ connection: GatewayConnection }>(`/v1/connections/${encodeURIComponent(connectionId)}/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelIds }),
    ...(signal ? { signal } : {}),
  }).then((body) => body.connection);
}

/**
 * Ask the provider what models this connection can serve right now, and save the answer.
 *
 * A card's model list is what the provider said when the connection was saved, so it goes stale
 * whenever a provider adds or retires a model. This is the only way to find out — there is no
 * local list to re-read.
 */
export function refreshGatewayConnectionModels(connectionId: string, signal?: AbortSignal) {
  return requestJson<{ connection: GatewayConnection }>(`/v1/connections/${encodeURIComponent(connectionId)}/models/refresh`, {
    // The JSON media type is required even though this call has nothing to say: the gateway
    // refuses a JSON-routed POST without it, so omitting the header answered 415 and the button
    // looked broken rather than mis-declared.
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    ...(signal ? { signal } : {}),
  }).then((body) => body.connection);
}

/** How a provider's connections share traffic. `priority` is the default; `round-robin` takes turns across them. */
/** How a provider's connections share traffic: `fastest` orders same-priority accounts by measured round trip. */
export type GatewayProviderStrategy = 'priority' | 'round-robin' | 'fastest';

export function updateGatewayProviderStrategy(providerId: string, strategy: GatewayProviderStrategy, signal?: AbortSignal) {
  return requestJson<{ providerId: string; strategy: GatewayProviderStrategy }>(`/v1/providers/${encodeURIComponent(providerId)}/strategy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy }),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Records who owns a connection and what it is for.
 *
 * A `PUT` on the connection itself rather than a side endpoint: responsibility is part of the record,
 * and a second table for it would have to be kept in step with the first.
 */
/**
 * Pauses or resumes one account.
 *
 * Its own call rather than a full connection PUT: that route re-validates the credential and re-reads
 * the catalog, and a switch must not spend a provider request to flip.
 */
export function setGatewayConnectionEnabled(connectionId: string, enabled: boolean, signal?: AbortSignal) {
  return requestJson<{ connection: GatewayConnection }>(`/v1/connections/${encodeURIComponent(connectionId)}/enabled`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
    ...(signal ? { signal } : {}),
  }).then((body) => body.connection);
}

export function saveGatewayConnectionResponsibility(
  connectionId: string,
  responsibility: { owner?: string; purpose?: string },
  signal?: AbortSignal,
) {
  return requestJson<{ connection: GatewayConnection }>(
    `/v1/connections/${encodeURIComponent(connectionId)}/responsibility`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(responsibility),
      ...(signal ? { signal } : {}),
    },
  );
}

export function updateGatewayConnectionResilience(connectionId: string, resilience: Partial<GatewayResilience>, signal?: AbortSignal) {
  return requestJson<{ connection: GatewayConnection }>(`/v1/connections/${encodeURIComponent(connectionId)}/resilience`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(resilience),
    ...(signal ? { signal } : {}),
  }).then((body) => body.connection);
}

/**
 * One recorded request, as `GET /v1/usage` returns it.
 *
 * **`providerId` and `connectionId` are optional**, because a request can end before any route is tried: a
 * client that disconnects during startup, or a request nothing could serve. The page shows those as
 * unattributed rather than inventing a provider name — a request log that puts a provider on a request that
 * provider never saw is the one thing a usage page must not do.
 */
export type GatewayUsageRecord = {
  id: string;
  at: string;
  model: string;
  providerId?: string;
  connectionId?: string;
  outcome: 'success' | 'failure' | 'cancelled';
  errorCode?: string;
  attempts: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  tokensEstimated?: boolean;
};

export type GatewayUsageTotals = {
  requests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /**
   * True when **no** record carried token counts.
   *
   * The reason this field exists: an unmetered provider and a free provider both sum to zero, and a page that
   * cannot tell them apart reports "$0 spent" for a connection that was never asked.
   */
  tokensUnmeasured: boolean;
};

export type GatewayUsageCost = {
  costUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
  unpricedEntirely: boolean;
  /** `null` when every record was priced; a caveat printed every time is one nobody reads. */
  caveat: string | null;
};

export type GatewayUsageGroup = {
  requests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Records in this group that reported tokens. Zero means the sums are an absence, not a measured zero. */
  tokensMeasured: number;
  costUsd: number;
  /** Records that could be priced. Zero with `requests` above zero means "no published price". */
  pricedRequests: number;
  unpricedRequests: number;
};

export type GatewayUsageProviderGroup = GatewayUsageGroup & { id: string };
export type GatewayUsageModelGroup = GatewayUsageGroup & { model: string; lastUsed: string };
export type GatewayUsageTimelinePoint = GatewayUsageGroup & { label: string; bucketStart: string };

/** The aggregates behind the charts, over the same window as the totals. */
export type GatewayUsageBreakdown = {
  period: string;
  since?: string;
  byProvider: GatewayUsageProviderGroup[];
  byModel: GatewayUsageModelGroup[];
  timeline: GatewayUsageTimelinePoint[];
};

export type GatewayUsage = {
  /**
   * False when the gateway was started without a usage store, so nothing has been recorded.
   *
   * Reported honestly rather than as `404` or as zeros that read as "nothing was spent".
   */
  recording: boolean;
  reason?: string;
  /** The window the figures cover, echoed by the gateway so the page states it rather than assuming. */
  period?: string;
  totals: GatewayUsageTotals;
  records: GatewayUsageRecord[];
  /** Absent on a gateway too old to send it; the page then shows the cards without the charts. */
  breakdown?: GatewayUsageBreakdown;
  cost?: GatewayUsageCost;
};

/** One finished request, as `GET /v1/logs/stream` sends it. No message content, prompt or credential. */
export type GatewayLogEvent = {
  id: string;
  at: string;
  model: string;
  providerId?: string;
  connectionId?: string;
  outcome: 'success' | 'failure' | 'cancelled';
  errorCode?: string;
  attempts: number;
  latencyMs: number;
  requestId?: string;
};

/**
 * Opens the live request stream. Each finished request is passed to `onEvent`; `onState` reports whether the stream is
 * connected. Returns a function that closes it.
 */
export function openGatewayLogStream(onEvent: (event: GatewayLogEvent) => void, onState: (connected: boolean) => void): () => void {
  const bridge = desktopBridge();
  if (bridge) {
    // Main owns the SSE connection and the token; the renderer only receives parsed records.
    const offEvent = bridge.gateway.onLog((event) => {
      if (event.streamError) {
        onState(false);
        return;
      }
      onEvent(event as GatewayLogEvent);
    });
    const offState = bridge.gateway.onLogState((state) => onState(state.connected));
    return () => {
      offEvent();
      offState();
    };
  }
  // In development the relative URL is required: EventSource cannot carry the per-launch dashboard
  // token, and the Vite proxy attaches it. In a build there is no proxy, so a relative URL reaches
  // the static host instead of the gateway — the feed used to be dead in production for that reason.
  const url = import.meta.env.DEV ? '/v1/logs/stream' : gatewayBaseUrl ? `${gatewayBaseUrl}/v1/logs/stream` : '';
  if (!url) {
    onState(false);
    return () => undefined;
  }
  const source = new EventSource(url);
  source.onopen = () => onState(true);
  source.onerror = () => onState(false);
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as GatewayLogEvent);
    } catch {
      // A line that is not a record is skipped, not shown.
    }
  };
  return () => source.close();
}

export type GatewayTokenSaverStats = {
  period: string;
  since?: string;
  requests: number;
  requestsWithTelemetry: number;
  requestsWithSavings: number;
  totalTokensSaved: number;
  totalBytesSaved: number;
  cache: { read: number; write: number };
  savers: Array<{ id: string; kind: string; requests: number; requestsWithSavings: number; ran?: number; skipped?: number; tokensSaved: number; bytesSaved: number }>;
  byProvider: Array<{ providerId: string; requests: number; tokensSaved: number; bytesSaved: number }>;
};

export function getGatewayTokenSaverStats(period = '7d', signal?: AbortSignal) {
  return requestJson<GatewayTokenSaverStats>(`/v1/token-saver/stats?period=${encodeURIComponent(period)}`, { signal });
}

export function getGatewayUsage(query?: { period?: string; provider?: string; connection?: string; outcome?: 'success' | 'failure' | 'cancelled'; limit?: number; offset?: number }, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query?.period) params.set('period', query.period);
  // The gateway filters by the recorded `providerId`; a provider page passes the id its records are written
  // under, which is the connection owner for a card that shares another provider's credential.
  if (query?.provider) params.set('provider', query.provider);
  if (query?.connection) params.set('connection', query.connection);
  if (query?.outcome) params.set('outcome', query.outcome);
  if (query?.limit !== undefined) params.set('limit', String(query.limit));
  if (query?.offset !== undefined) params.set('offset', String(query.offset));
  const suffix = params.toString();
  return requestJson<GatewayUsage>(`/v1/usage${suffix ? `?${suffix}` : ''}`, { signal });
}

/**
 * The configuration this gateway process loaded, after defaults, parsing and validation.
 *
 * **`settings` can be `null`.** A service constructed without a loaded configuration reports a reason
 * instead, and the page shows that rather than inventing values — the two sources of numbers in this project
 * are `config.ts` and the environment, and a third would be a third thing to keep in step.
 */
export type GatewaySettings = {
  host: string;
  port: number;
  /** Always true: the gateway refuses to bind anything but loopback. Shown because a reader wants to know. */
  localOnly: boolean;
  timeoutMs: number;
  healthIntervalMs: number;
  failureThreshold: number;
  recoveryCooldownMs: number;
  corsOrigins: string[];
  dataDir: string;
  /** Opt-in standalone context saver, as loaded at startup. */
  compression?: {
    enabled: boolean;
    targetRatio: number;
    protectRecent: number;
    compressUsers: boolean;
    compressCode: boolean;
    reversible: boolean;
    ccrLimit: number;
  };
  maxOutputTokensCap?: number;
  thinkingBudgetCap?: number;
  historyTrim?: { maxInputTokens: number; keepRecent: number };
  cacheAnchor?: boolean;
  caveman?: { level: string };
  ponytail?: { level: string };
  headroom?: { enabled: boolean; timeoutMs?: number };
  pxpipe?: { enabled: boolean; timeoutMs?: number; minChars?: number };
  endpoints: {
    openai: string;
    anthropic: string;
    gemini: string;
    openrouter: string;
    compatible: { id: string; name: string; baseUrl: string; modelsPath?: string; chatPath?: string; authRequired: boolean };
  };
  /** The only setting changeable without a restart. */
  mutableAtRuntime: string[];
  mutableByRestart: string[];
};

export type GatewaySettingsResponse = { settings: GatewaySettings | null; reason?: string };

export function getGatewaySettings(signal?: AbortSignal) {
  return requestJson<GatewaySettingsResponse>('/v1/settings', { signal });
}

export function getGatewayRoutingState(signal?: AbortSignal) {
  return requestJson<GatewayRoutingState>('/v1/routing', { signal });
}

export function removeGatewayConnection(connectionId: string, signal?: AbortSignal) {
  return requestJson<{ deleted: true; id: string }>(`/v1/connections/${encodeURIComponent(connectionId)}`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  });
}

export type GatewayOauthAuthorization = {
  authUrl: string;
  redirectUri: string;
};

export type GatewayOauthSignIn = GatewayOauthAuthorization & {
  sessionId: string;
  /** Echoed back on the callback so the gateway can recognise its own sign-in. */
  state: string;
};

export type GatewayOauthSignInStatus = {
  status: 'pending' | 'connected' | 'failed' | 'expired';
  connection?: GatewayConnection;
  error?: string;
  expiresAt?: string;
  verificationUrl?: string;
};

/** Starts a sign-in and returns the URL to send the browser to. */
export function startGatewayOauthSignIn(providerId: string, signal?: AbortSignal, connectionId?: string) {
  return requestJson<GatewayOauthSignIn>(`/v1/oauth/${encodeURIComponent(providerId)}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(connectionId ? { connectionId } : {}),
    ...(signal ? { signal } : {}),
  });
}

/** Whether a sign-in started earlier has finished, and how it went. */
export function getClineSignInStatus(sessionId: string, signal?: AbortSignal) {
  return requestJson<GatewayOauthSignInStatus>(`/v1/oauth/cline/session/${encodeURIComponent(sessionId)}`, { signal });
}

/**
 * Claude Code — an authorization-code flow with PKCE, so the browser opens on Claude's page.
 *
 * `verificationUrl` is the URL to open, the same field the device flows use. There is deliberately no
 * `authUrl`/`state` pair here: the session id travels in the redirect path, so the callback can be tied
 * to its PKCE verifier without the provider echoing anything back.
 */
export function startClaudeCodeSignIn(addAccount?: boolean, signal?: AbortSignal, connectionId?: string) {
  return requestJson<{ sessionId: string; verificationUrl: string; expiresAt: string }>('/v1/oauth/claude-code/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(addAccount ? { addAccount: true } : {}), ...(connectionId ? { connectionId } : {}) }),
    ...(signal ? { signal } : {}),
  });
}

export function getClaudeCodeSignInStatus(sessionId: string, signal?: AbortSignal) {
  return requestJson<GatewayOauthSignInStatus & { verificationUrl?: string }>(
    `/v1/oauth/claude-code/session/${encodeURIComponent(sessionId)}`,
    { signal },
  );
}

export function startCodexSignIn(addAccount?: boolean, signal?: AbortSignal, connectionId?: string) {
  return requestJson<{ sessionId: string; verificationUrl: string; expiresAt: string }>('/v1/oauth/codex/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(addAccount ? { addAccount: true } : {}), ...(connectionId ? { connectionId } : {}) }), ...(signal ? { signal } : {}),
  });
}

export function getCodexSignInStatus(sessionId: string, signal?: AbortSignal) {
  return requestJson<GatewayOauthSignInStatus & { verificationUrl?: string }>(
    `/v1/oauth/codex/session/${encodeURIComponent(sessionId)}`, { signal },
  );
}

/**
 * A device-flow sign-in. The provider hands back a code the user types into its own
 * page, so there is no authUrl to navigate to and nothing is echoed back on a callback.
 */
export type GatewayDeviceSignIn = {
  sessionId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
};

export type GatewayDeviceSignInStatus = GatewayOauthSignInStatus & {
  userCode?: string;
  verificationUrl?: string;
};

/**
 * Starts a device-code sign-in for whichever provider is asking.
 *
 * Both OpenCode Console and Kiro are device flows with the same shape, so the dialog
 * keeps them in one set. These took no provider and sent every request to
 * `opencode-console`, which made the set a claim the code did not honour: a second
 * device provider added to it would silently sign into the first one's endpoint. The
 * Kiro branch in the dialog runs first today, so nothing was routed wrongly yet — this
 * is the state that made it impossible for that to stay true.
 */
export function startGatewayDeviceSignIn(providerId: string, addAccount?: boolean, signal?: AbortSignal, connectionId?: string) {
  return requestJson<GatewayDeviceSignIn>(`/v1/oauth/${encodeURIComponent(providerId)}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Absent means repair the provider's one connection; `true` signs a second account in beside it.
    body: JSON.stringify({ ...(addAccount ? { addAccount: true } : {}), ...(connectionId ? { connectionId } : {}) }),
    ...(signal ? { signal } : {}),
  });
}

export function getDeviceSignInStatus(providerId: string, sessionId: string, signal?: AbortSignal) {
  return requestJson<GatewayDeviceSignInStatus>(
    `/v1/oauth/${encodeURIComponent(providerId)}/session/${encodeURIComponent(sessionId)}`,
    { signal },
  );
}

/** Kiro signs in through AWS's device flow, so there is a code and no auth URL. */
export function startKiroSignIn(addAccount?: boolean, signal?: AbortSignal) {
  return requestJson<{ sessionId: string; userCode: string; verificationUrl: string; expiresAt: string }>('/v1/oauth/kiro/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The gateway has taken this flag since multi-account Kiro shipped; the dialog never sent it.
    body: JSON.stringify(addAccount ? { addAccount: true } : {}),
    ...(signal ? { signal } : {}),
  });
}

export function getKiroSignInStatus(sessionId: string, signal?: AbortSignal) {
  return requestJson<{ status: 'pending' | 'connected' | 'failed' | 'expired'; connection?: GatewayConnection; error?: string; userCode?: string; verificationUrl?: string }>(
    `/v1/oauth/kiro/session/${encodeURIComponent(sessionId)}`,
    { signal },
  );
}

/** Exchanges what the user pasted for tokens, then saves the connection. */
export function connectGatewayOauthProvider(providerId: string, input: { code: string; redirectUri?: string; name?: string }, signal?: AbortSignal) {
  return requestJson<{ connection: GatewayConnection }>(`/v1/oauth/${encodeURIComponent(providerId)}/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  }).then((body) => body.connection);
}

export function listGatewayApiKeys(signal?: AbortSignal) {
  return requestJson<GatewayApiKeyList & { object: 'list' }>('/v1/keys', { signal }).then((body) => ({ keys: body.keys, requireApiKey: body.requireApiKey }));
}

/** The returned `key` is the only time the gateway will ever hand out the secret. */
export function createGatewayApiKey(name: string, signal?: AbortSignal) {
  return requestJson<{ apiKey: GatewayApiKey; key: string }>('/v1/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
    ...(signal ? { signal } : {}),
  }).then((body) => ({ apiKey: body.apiKey, key: body.key }));
}

export function setGatewayApiKeyEnabled(id: string, enabled: boolean, signal?: AbortSignal) {
  return requestJson<{ apiKey: GatewayApiKey }>(`/v1/keys/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
    ...(signal ? { signal } : {}),
  }).then((body) => body.apiKey);
}

export function removeGatewayApiKey(id: string, signal?: AbortSignal) {
  return requestJson<{ deleted: true; id: string }>(`/v1/keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  });
}

export function setGatewayRequireApiKey(requireApiKey: boolean, signal?: AbortSignal) {
  return requestJson<{ requireApiKey: boolean }>('/v1/settings/require-api-key', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requireApiKey }),
    ...(signal ? { signal } : {}),
  }).then((body) => body.requireApiKey);
}

/** The encrypted envelope; the passphrase never leaves this call and is not stored. */
export function exportGatewayBackup(passphrase: string, signal?: AbortSignal) {
  return requestJson<{ backup: unknown }>('/v1/backup/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase }),
    ...(signal ? { signal } : {}),
  }).then((body) => body.backup);
}

export function importGatewayBackup(passphrase: string, backup: unknown, signal?: AbortSignal) {
  return requestJson<{ connections: number; strategies: number; apiKeys: number; removed: number }>('/v1/backup/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passphrase, backup, confirmReplace: true }),
    ...(signal ? { signal } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A refused gateway request, keeping the machine-readable code beside the sentence.
 *
 * The message alone cannot answer "is this provider out of quota, or does it not publish a balance?"
 * — those are different answers with the same shape of failure, and a panel that cannot tell them
 * apart shows zeroes for a provider that never reported any. Existing callers read `.message` and are
 * unaffected by the added field.
 */
export class GatewayRequestError extends Error {
  readonly code?: string;
  readonly status?: number;

  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'GatewayRequestError';
    if (options.code) this.code = options.code;
    if (options.status !== undefined) this.status = options.status;
  }
}

/** One metered resource on a provider's account, as the provider itself reports it. */
export type GatewayProviderResourceQuota = {
  used: number;
  limit: number;
  remaining: number;
  resetsAt?: string;
};

export type GatewayProviderQuota = {
  plan?: string;
  resources: Record<string, GatewayProviderResourceQuota>;
};

/**
 * What the account behind a connection has left.
 *
 * Rejects with a `GatewayRequestError` carrying code `NOT_SUPPORTED` when the provider publishes no
 * quota at all — which is most of them, and is not the same as an account with nothing remaining.
 */
/**
 * Whether a refusal means "this provider does not publish that" rather than "the request failed".
 *
 * A named helper rather than an `instanceof` at the call site, because the two must not be confused:
 * a page that treats a failure as "nothing to report" would show a healthy-looking panel for a gateway
 * that is simply down.
 */
export function isNotSupported(error: unknown): boolean {
  return error instanceof GatewayRequestError && error.code === 'NOT_SUPPORTED';
}

export function getProviderQuota(connectionId: string, signal?: AbortSignal) {
  return requestJson<{ object: 'quota' } & GatewayProviderQuota>(`/v1/connections/${encodeURIComponent(connectionId)}/quota`, { signal });
}

export async function requestJson<T>(path: string, init: RequestInit = {}) {
  const bridge = desktopBridge();
  if (bridge) {
    if (init.body !== undefined && typeof init.body !== 'string') throw new Error('Desktop gateway requests require a string body.');
    const result = await bridge.gateway.request(path, {
      ...(init.method ? { method: String(init.method) } : {}),
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    noteGatewayReachability(result.status !== 0);
    let body: { error?: { code?: string; message?: string; providerMessage?: string } } | undefined;
    try {
      body = JSON.parse(result.text) as typeof body;
    } catch {
      body = undefined;
    }
    if (!result.ok) {
      if (result.status === 0) throw new Error(result.text || 'Could not reach the local gateway.');
      const providerMessage = body?.error?.providerMessage?.trim();
      const summary = body?.error?.message?.trim();
      throw new GatewayRequestError(
        providerMessage && providerMessage !== summary
          ? `${summary ? `${summary} ` : ''}${providerMessage}`.trim()
          : summary || `Gateway request failed with status ${result.status}.`,
        { ...(body?.error?.code ? { code: body.error.code } : {}), status: result.status },
      );
    }
    if (body === undefined) throw new GatewayRequestError(`The gateway returned a ${result.status} response that is not JSON.`, { status: result.status });
    return body as T;
  }
  if (!gatewayBaseUrl) throw new Error('Gateway URL must target a loopback address or HTTPS.');
  let response: Response;
  try {
    response = await fetch(`${gatewayBaseUrl}${path}`, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      ...init,
      headers: { accept: 'application/json', ...gatewayAuthHeaders(), ...init.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof TypeError) {
      noteGatewayReachability(false);
      throw new Error(`Could not reach the local gateway at ${gatewayBaseUrl}. Start it with pnpm dev:gateway.`);
    }
    throw error;
  }
  // A response at all means something answered. A 500 is a working gateway having a bad day,
  // and treating it as "down" would flash the offline banner at the user at the wrong moment.
  noteGatewayReachability(true);

  const body = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string; providerMessage?: string } } | undefined;
  /**
   * The gateway's neutral message is written for API clients, so it says little. The
   * provider's own words ride alongside in `providerMessage` and are only sent to a
   * trusted local dashboard origin, which is exactly who is asking here — so they are
   * what the operator should read, not "the request failed".
   */
  if (!response.ok) {
    const providerMessage = body?.error?.providerMessage?.trim();
    const summary = body?.error?.message?.trim();
    throw new GatewayRequestError(
      providerMessage && providerMessage !== summary
        ? `${summary ? `${summary} ` : ''}${providerMessage}`.trim()
        : summary || `Gateway request failed with status ${response.status}.`,
      { ...(body?.error?.code ? { code: body.error.code } : {}), status: response.status },
    );
  }
  // A 200 that is not JSON is an HTML error page or a proxy response, not a gateway answer. Returning
  // `undefined` as `T` moved the failure to the caller as `Cannot read properties of undefined`.
  if (body === undefined) throw new GatewayRequestError(`The gateway returned a ${response.status} response that is not JSON.`, { status: response.status });
  return body as T;
}
