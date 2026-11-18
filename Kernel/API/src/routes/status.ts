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

    /**
     * The latest published release, asked for by the **gateway** rather than the browser.
     *
     * The dashboard used to call `api.github.com` directly, which meant every load made a cross-origin request that a
     * proxy, an offline machine or a rate limit turned into a red `403` in the console — noise about the update feed,
     * on a page about something else. Server-side it is one request the gateway can cache, time out and fail quietly,
     * and it works when the browser's network path to GitHub does not.
     *
     * `unavailable` is a result, not an error: the caller is told the check could not be made and says so, which is the
     * same honesty rule the dashboard already applies to a provider that reports no usage.
     */
    if (request.method === 'GET' && url.pathname === '/v1/system/update') {
      sendJson(response, 200, await readLatestRelease(signal), origin);
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
    const singleHealthPath = '/v1/health/';
    const singleHealthId = url.pathname.startsWith(singleHealthPath) ? url.pathname.slice(singleHealthPath.length) : '';
    if (request.method === 'GET' && singleHealthId && !singleHealthId.includes('/')) {
      sendJson(response, 200, { provider: await service.healthForProvider(decodeProviderId(singleHealthId), signal) }, origin);
      return true;
    }

    if (url.pathname.startsWith('/v1/connections')) response.setHeader('cache-control', 'no-store');


    if (request.method === 'GET' && url.pathname === '/v1/routing') {
      sendJson(response, 200, await service.describeRouting(), origin);
      return true;
    }


  return false;
}

/** How long a release answer is reused. GitHub's unauthenticated limit is 60 requests an hour; this asks twice a day. */
const RELEASE_CACHE_MS = 6 * 60 * 60 * 1000;
const RELEASE_FETCH_TIMEOUT_MS = 4_000;
let releaseCache: { at: number; body: Record<string, unknown> } | undefined;

/**
 * `GET /v1/system/update` — the newest release tag, or a plain statement that it could not be read.
 *
 * No token, no retry storm: a failure is cached for the same six hours, because a gateway that cannot reach GitHub
 * should not try again on every dashboard load. The dashboard's own retry cadence is what decides when to ask again.
 */
async function readLatestRelease(signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (releaseCache && Date.now() - releaseCache.at < RELEASE_CACHE_MS) return releaseCache.body;
  const remember = (body: Record<string, unknown>) => {
    releaseCache = { at: Date.now(), body };
    return body;
  };
  try {
    const timeout = AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS);
    const response = await fetch('https://api.github.com/repos/Hilbras/OmniHilbras/releases/latest', {
      headers: { accept: 'application/vnd.github+json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) return remember({ unavailable: true, reason: `GitHub answered ${response.status}` });
    const body = (await response.json()) as { tag_name?: string; html_url?: string; published_at?: string };
    const version = body.tag_name?.trim();
    if (!version) return remember({ unavailable: true, reason: 'the release has no tag' });
    return remember({
      version: version.replace(/^v/i, ''),
      url: body.html_url ?? 'https://github.com/Hilbras/OmniHilbras/releases/latest',
      ...(body.published_at ? { publishedAt: body.published_at } : {}),
    });
  } catch (error) {
    return remember({ unavailable: true, reason: error instanceof Error ? error.message : 'the update check failed' });
  }
}
