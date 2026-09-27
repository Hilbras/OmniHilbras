export type GatewayProviderHealth = {
  providerId: string;
  status: 'healthy' | 'degraded' | 'unavailable';
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

export async function listGatewayConnections(signal?: AbortSignal) {
  const body = await requestJson<{ object: 'list'; data: GatewayConnection[] }>('/v1/connections', { signal });
  return body.data;
}

export function checkOpenRouterConnection(apiKey: string, signal?: AbortSignal) {
  return requestJson<GatewayConnectionValidation>('/v1/connections/openrouter/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
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

async function requestJson<T>(path: string, init: RequestInit = {}) {
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
    if (error instanceof TypeError) throw new Error(`Could not reach the local gateway at ${gatewayBaseUrl}. Start it with pnpm dev:gateway.`);
    throw error;
  }
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
