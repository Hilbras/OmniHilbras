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
  return false;
}
