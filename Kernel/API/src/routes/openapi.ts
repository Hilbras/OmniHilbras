import type { RouteContext } from './route-context.js';
import { sendJson } from '../core/http.js';
import { openApiDocument } from '../core/route-contracts.js';

const openApiPath = '/v1/openapi';

/**
 * `GET /v1/openapi` — the route inventory as an OpenAPI 3.1 document.
 *
 * Each path carries `x-omnihilbras-served`; prefixes are listed as paths too and repeated in
 * `x-omnihilbras-prefixes`. This is a discovery contract, not a request/response schema: a route
 * that exists is listed, and `tests/gateway-routes.test.js` fails if the list and the dispatcher
 * disagree. A client can use it to find the surface; it cannot use it to generate a typed SDK yet.
 */
export async function handleOpenApiRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin } = ctx;
  if (request.method !== 'GET' || url.pathname !== openApiPath) return false;
  sendJson(response, 200, openApiDocument(), origin);
  return true;
}
