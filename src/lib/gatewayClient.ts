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

export type GatewayConnection = {
  id: string;
  providerId: string;
  name: string;
  endpoint: string;
  priority: number;
  proxyPool: string;
  enabled: boolean;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GatewayConnectionValidation = {
  providerId: string;
  valid: true;
  checkedAt: string;
  latencyMs?: number;
};

export type OpenRouterConnectionInput = {
  name: string;
  apiKey: string;
  priority: number;
  proxyPool: string;
  enabled?: boolean;
};

const gatewayBaseUrl = (import.meta.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

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

export function saveOpenRouterConnection(input: OpenRouterConnectionInput, signal?: AbortSignal) {
  return requestJson<{ connection: GatewayConnection }>('/v1/connections/openrouter', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  }).then((body) => body.connection);
}

export function removeGatewayConnection(connectionId: string, signal?: AbortSignal) {
  return requestJson<{ deleted: true; id: string }>(`/v1/connections/${encodeURIComponent(connectionId)}`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  });
}

async function requestJson<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${gatewayBaseUrl}${path}`, {
    cache: 'no-store',
    credentials: 'omit',
    ...init,
    headers: { accept: 'application/json', ...init.headers },
  });
  const body = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
  if (!response.ok) throw new Error(body?.error?.message ?? `Gateway request failed with status ${response.status}.`);
  return body as T;
}
