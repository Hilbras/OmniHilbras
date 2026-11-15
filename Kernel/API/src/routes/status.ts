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

/**
 * `POST /v1/system/shutdown` — the dashboard asking this gateway to stop.
 *
 * ## Why the server has a stop button
 *
 * The update notice offers the manual path for a build that cannot replace itself: copy the install command,
 * stop the server, run the command in a terminal, start it again. Without this the "stop" half was a person
 * hunting a terminal to kill a process, which is exactly the step the reference implementation automated.
 *
 * ## What it refuses
 *
 * A gateway started with no shutdown hook — an embedder, a test — answers `503` saying so, rather than
 * `{"stopping": true}` and continuing to run. A promise nothing keeps is worse than a refusal. The reply is
 * sent **before** the stop is triggered: a process that has already gone cannot tell anyone it is going.
 *
 * It is a management path (`/v1/system` is in the gateway's management prefixes), so it is reachable only
 * from an allowlisted dashboard origin with the per-launch token, or with a valid gateway API key — the same
 * gate as every other write.
 */
export const gatewayShutdownPath = '/v1/system/shutdown';

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

    if (url.pathname === gatewayShutdownPath) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `${gatewayShutdownPath} answers POST.` } }, origin);
        return true;
      }
      const stop = ctx.options.onShutdownRequest;
      if (!stop) {
        sendJson(
          response,
          503,
          { error: { code: 'SHUTDOWN_UNAVAILABLE', message: 'This gateway was started without a shutdown hook, so it cannot stop itself.' } },
          origin,
        );
        return true;
      }
      // Answered first, stopped after it has flushed.
      sendJson(response, 200, { stopping: true }, origin);
      response.once('finish', () => {
        setTimeout(() => {
          try {
            stop();
          } catch {
            // The stop is the point; a throwing hook has nothing left to report to.
          }
        }, 0);
      });
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
