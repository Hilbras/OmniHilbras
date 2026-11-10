import { invalidRequest, sendJson } from '../core/http.js';
import type { RouteContext } from './route-context.js';

/**
 * Retrieval for a token-saver marker.
 *
 * The model sees `<<token-saver:<id> ...>>` where content was elided. This route returns the original
 * bytes for that id. It is a management route: the content it returns is the uncompressed prompt, which
 * may contain tool output or file contents.
 */
export async function handleTokenSaverRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin } = ctx;
  if (!url.pathname.startsWith('/v1/token-saver/')) return false;
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Retrieval is a GET.' } }, origin);
    return true;
  }
  const raw = url.pathname.slice('/v1/token-saver/'.length);
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw invalidRequest('The retrieval id is not valid.');
  }
  if (!/^[a-f0-9]{12}$/.test(id)) throw invalidRequest('The retrieval id is not valid.');
  const content = service.retrieveTokenSaverContext(id);
  if (content === undefined) {
    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'That token-saver entry has expired or was never stored.' } }, origin);
    return true;
  }
  sendJson(response, 200, { id, content }, origin);
  return true;
}
