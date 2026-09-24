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

const gatewayBaseUrl = (import.meta.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

export async function getGatewayHealth(signal?: AbortSignal) {
  return requestJson<GatewayHealth>('/health', { signal });
}

async function requestJson<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${gatewayBaseUrl}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...init.headers },
  });
  const body = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
  if (!response.ok) throw new Error(body?.error?.message ?? `Gateway request failed with status ${response.status}.`);
  return body as T;
}
