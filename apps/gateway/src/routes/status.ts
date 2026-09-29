/**
 * Whether the gateway is up, and what routing it would do. The only module with no request body.
 */

import type { RouteContext } from './route-context.js';
import {
  sendJson,
} from '../http.js';

export async function handleStatusRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, signal } = ctx;

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { service: 'omnihilbras-gateway', ...(await service.health(signal)) }, origin);
      return true;
    }

    // One provider, not thirteen. `/health` probes every active adapter, so a dashboard that
    // asked it in order to render a single provider card waited on the whole registry — long
    // enough on a loaded machine that "Test provider" looked permanently stuck.
    const singleHealth = /^\/v1\/health\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && singleHealth?.[1]) {
      sendJson(response, 200, { provider: await service.healthForProvider(decodeURIComponent(singleHealth[1]), signal) }, origin);
      return true;
    }

    if (url.pathname.startsWith('/v1/connections')) response.setHeader('cache-control', 'no-store');


    if (request.method === 'GET' && url.pathname === '/v1/routing') {
      sendJson(response, 200, await service.describeRouting(), origin);
      return true;
    }


  return false;
}
