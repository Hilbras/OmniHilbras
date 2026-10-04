import type { ModelMetaMap } from '@hilbras/omnihilbras';

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
  modelPolicy: 'free' | 'all';
  modelIds: string[];
  customModelIds: string[];
  /** Catalog metadata for `modelIds`, when the provider published any. */
  modelMeta?: ModelMetaMap;
  resilience: GatewayResilience;
  createdAt: string;
  updatedAt: string;
};

export type GatewayRoutingState = {
  failureThreshold: number;
  connections: Array<{
    connectionId: string;
    providerId: string;
    enabled: boolean;
    hasCredential: boolean;
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

const gatewayBaseUrl = normalizeGatewayBaseUrl(import.meta.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:8787');

/**
 * The gateway's base URL, for callers that need to reach it outside `requestJson`.
 *
 * The status poller is one of them, and it cannot use a relative path: the gateway is on a
 * different port from the dashboard, so `/v1/connections` would reach Vite instead.
 */
export const gatewayBase = gatewayBaseUrl;

function normalizeGatewayBaseUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const loopback = hostname === 'localhost' || hostname === '::1' || isLoopbackIpv4(hostname);
    if (!loopback || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return '';
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

export type GatewayConnectionInput = {
  apiKey: string;
  name?: string;
  endpoint: string;
  priority?: number;
  proxyPool?: string;
  modelPolicy?: 'free' | 'all';
};

/**
 * Saves any OpenAI-compatible provider by id. The gateway builds an adapter for
 * the endpoint on demand, so a provider needs no code change to be connectable.
 */
export function putGatewayConnection(providerId: string, input: GatewayConnectionInput, signal?: AbortSignal) {
  return requestJson<{ connection: GatewayConnection }>(`/v1/connections/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  }).then((body) => body.connection);
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
  const startedAt = Date.now();
  const response = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-omnihilbras-provider': request.providerId },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 2048,
      stream: true,
    }),
    ...(signal ? { signal } : {}),
  });
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
    if (code === 'NOT_SUPPORTED' && request.stream !== false) {
      return sendWithoutStreaming(request, onDelta, signal, startedAt);
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error('The gateway returned no response body to stream from.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let provider = request.providerId;
  let model = request.model;
  let usage: GatewayChatTurn['usage'];

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
      boundary = buffer.indexOf('\n\n');

      const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (payload === '[DONE]') continue;
      // A stream that fails mid-answer reports it as an event, not a status code — by then
      // the 200 is long gone, so this is the only place the reason can come from.
      if (frame.includes('event: error')) throw new Error(safeErrorPayload(payload));

      let parsed: { choices?: Array<{ delta?: { content?: string } }>; provider?: string; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
      try {
        parsed = JSON.parse(payload) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.provider) provider = parsed.provider;
      if (parsed.model) model = parsed.model;
      if (parsed.usage) {
        usage = {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
          totalTokens: parsed.usage.total_tokens ?? 0,
        };
      }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        onDelta(delta, content);
      }
    }
  }
  return { content, provider, model, latencyMs: Date.now() - startedAt, streamed: true, ...(usage ? { usage } : {}) };
}

function safeErrorPayload(payload: string) {
  try {
    const parsed = JSON.parse(payload) as { error?: { message?: string } };
    return parsed.error?.message ?? 'The stream failed partway through.';
  } catch {
    return 'The stream failed partway through.';
  }
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
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-omnihilbras-provider': request.providerId },
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
};

export type GatewayUsageTotals = {
  requests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
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

export type GatewayUsage = {
  /**
   * False when the gateway was started without a usage store, so nothing has been recorded.
   *
   * Reported honestly rather than as `404` or as zeros that read as "nothing was spent".
   */
  recording: boolean;
  reason?: string;
  totals: GatewayUsageTotals;
  records: GatewayUsageRecord[];
  cost?: GatewayUsageCost;
};

export function getGatewayUsage(query?: { outcome?: 'success' | 'failure' | 'cancelled'; limit?: number }, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query?.outcome) params.set('outcome', query.outcome);
  if (query?.limit !== undefined) params.set('limit', String(query.limit));
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
};

/** Starts a sign-in and returns the URL to send the browser to. */
export function startGatewayOauthSignIn(providerId: string, signal?: AbortSignal) {
  return requestJson<GatewayOauthSignIn>(`/v1/oauth/${encodeURIComponent(providerId)}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    ...(signal ? { signal } : {}),
  });
}

/** Whether a sign-in started earlier has finished, and how it went. */
export function getClineSignInStatus(sessionId: string, signal?: AbortSignal) {
  return requestJson<GatewayOauthSignInStatus>(`/v1/oauth/cline/session/${encodeURIComponent(sessionId)}`, { signal });
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

export function startGatewayDeviceSignIn(signal?: AbortSignal) {
  return requestJson<GatewayDeviceSignIn>('/v1/oauth/opencode-console/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    ...(signal ? { signal } : {}),
  });
}

export function getDeviceSignInStatus(sessionId: string, signal?: AbortSignal) {
  return requestJson<GatewayDeviceSignInStatus>(`/v1/oauth/opencode-console/session/${encodeURIComponent(sessionId)}`, { signal });
}

/** Kiro signs in through AWS's device flow, so there is a code and no auth URL. */
export function startKiroSignIn(signal?: AbortSignal) {
  return requestJson<{ sessionId: string; userCode: string; verificationUrl: string; expiresAt: string }>('/v1/oauth/kiro/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    ...(signal ? { signal } : {}),
  });
}

export function getKiroSignInStatus(sessionId: string, signal?: AbortSignal) {
  return requestJson<{ status: 'pending' | 'connected' | 'failed' | 'expired'; connection?: GatewayConnection; error?: string; userCode?: string; verificationUrl?: string }>(
    `/v1/oauth/kiro/session/${encodeURIComponent(sessionId)}`,
    { signal },
  );
}

export function getGatewayOauthAuthorization(providerId: string, signal?: AbortSignal) {
  return requestJson<GatewayOauthAuthorization>(`/v1/oauth/${encodeURIComponent(providerId)}/authorize`, { signal });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function requestJson<T>(path: string, init: RequestInit = {}) {
  if (!gatewayBaseUrl) throw new Error('Gateway URL must target a loopback address.');
  let response: Response;
  try {
    response = await fetch(`${gatewayBaseUrl}${path}`, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      ...init,
      headers: { accept: 'application/json', ...init.headers },
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

  const body = await response.json().catch(() => undefined) as { error?: { message?: string; providerMessage?: string } } | undefined;
  /**
   * The gateway's neutral message is written for API clients, so it says little. The
   * provider's own words ride alongside in `providerMessage` and are only sent to a
   * trusted local dashboard origin, which is exactly who is asking here — so they are
   * what the operator should read, not "the request failed".
   */
  if (!response.ok) {
    const providerMessage = body?.error?.providerMessage?.trim();
    const summary = body?.error?.message?.trim();
    throw new Error(
      providerMessage && providerMessage !== summary
        ? `${summary ? `${summary} ` : ''}${providerMessage}`.trim()
        : summary || `Gateway request failed with status ${response.status}.`,
    );
  }
  return body as T;
}
