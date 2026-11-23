import type { RouteContext } from './route-context.js';
import { sendJson } from '../core/http.js';

const observabilityPrefix = '/v1/observability';

export async function handleObservabilityRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin, service } = ctx;
  if (request.method === 'GET' && url.pathname === observabilityPrefix) {
    const connections = await (service.listConnections?.() ?? Promise.resolve([]));
    const skills = await (service.skills?.list?.() ?? Promise.resolve([]));
    const workspaces = await (service.workspaces?.list?.() ?? Promise.resolve([]));
    const tunnels = await (service.tunnels?.list?.() ?? Promise.resolve([]));
    const mitm = await (service.mitm?.list?.() ?? Promise.resolve([]));
    const proxyPools = await (service.proxyPools?.list?.() ?? Promise.resolve([]));
    const providerNodes = await (service.providerNodes?.list?.() ?? Promise.resolve([]));
    sendJson(response, 200, {
      observability: {
        uptimeMs: Math.round(process.uptime() * 1000),
        version: process.env.npm_package_version ?? null,
        counts: {
          connections: connections.length,
          skills: skills.length,
          workspaces: workspaces.length,
          tunnels: tunnels.length,
          mitm: mitm.length,
          proxyPools: proxyPools.length,
          providerNodes: providerNodes.length,
        },
        timestamp: new Date().toISOString(),
      },
    }, origin);
    return true;
  }
  if (request.method === 'GET' && url.pathname === `${observabilityPrefix}/request-details`) {
    const store = service.requestDetailStore;
    if (!store) {
      sendJson(response, 200, { object: 'list', data: [], enabled: false, reason: 'This gateway was not configured with a request-detail store.' }, origin);
      return true;
    }
    const requestId = url.searchParams.get('requestId') ?? undefined;
    const limit = url.searchParams.get('limit');
    const parsedLimit = limit === null ? undefined : Number(limit);
    const data = await store.list({
      ...(requestId ? { requestId } : {}),
      ...(parsedLimit !== undefined && Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? { limit: Math.min(parsedLimit, 200) } : {}),
    });
    sendJson(response, 200, { object: 'list', data, enabled: true }, origin);
    return true;
  }
  return false;
}
