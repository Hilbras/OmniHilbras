import type { RouteContext } from './route-context.js';
import { sendJson } from '../core/http.js';

const cachePath = '/v1/cache';

/** `DELETE /v1/cache` — empties the exact response cache. The semantic cache, when wired, goes with it. */
export async function handleCacheRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin } = ctx;
  if (url.pathname !== cachePath) return false;
  if (request.method !== 'DELETE') {
    sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Cache maintenance is a DELETE.' } }, origin);
    return true;
  }
  await service.clearResponseCache();
  sendJson(response, 200, { cleared: true }, origin);
  return true;
}
