import type { RouteContext } from './route-context.js';
import { sendJson } from '../core/http.js';

const pxpipePrefix = '/v1/pxpipe';

export async function handlePxpipeRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin } = ctx;
  if (request.method === 'GET' && url.pathname === pxpipePrefix) {
    sendJson(response, 200, { pxpipe: 'ok', timestamp: new Date().toISOString() }, origin);
    return true;
  }
  return false;
}
