/**
 * Whether the gateway is up, and what routing it would do. The only module with no request body.
 */

import type { RouteContext } from './route-context.js';
import {
  sendJson,
} from '../core/http.js';
import { decodeProviderId } from './connections.js';
import { gatewayBuild } from '../core/build-info.js';
import { readHostSystemStats } from '../core/system-stats.js';

export async function handleStatusRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, signal } = ctx;

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      // The build rides on health, not only on /v1/settings, because health is the one call an
      // operator makes when something looks wrong. "Which build is this" is exactly that question,
      // and answering it only from the settings route means the person debugging cannot reach it.
      sendJson(response, 200, { service: 'omnihilbras-gateway', build: gatewayBuild(), ...(await service.health(signal)) }, origin);
      return true;
    }

    // The machine's own load, not the providers'. The Servers page already answers "is the gateway
    // up"; this answers "what is it running on", which is the other half of a server screen.
    if (request.method === 'GET' && url.pathname === '/v1/system') {
      sendJson(response, 200, await readHostSystemStats(), origin);
      return true;
    }

    // One provider, not thirteen. `/health` probes every active adapter, so a dashboard that
    // asked it in order to render a single provider card waited on the whole registry — long
    // enough on a loaded machine that "Test provider" looked permanently stuck.
    const singleHealth = /^\/v1\/health\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && singleHealth?.[1]) {
      sendJson(response, 200, { provider: await service.healthForProvider(decodeProviderId(singleHealth[1]), signal) }, origin);
      return true;
    }

    if (url.pathname.startsWith('/v1/connections')) response.setHeader('cache-control', 'no-store');


    if (request.method === 'GET' && url.pathname === '/v1/routing') {
      sendJson(response, 200, await service.describeRouting(), origin);
      return true;
    }


  return false;
}
