import type { RouteContext } from './route-context.js';
import { invalidRequest, sendJson } from '../core/http.js';

const auditPath = '/v1/audit';

/**
 * `GET /v1/audit` — the management-write audit trail.
 *
 * Every authenticated management write is recorded at the HTTP boundary with the actor, method,
 * path, status and request id. This route is deliberately owner-only: the trail names which keys
 * changed which resources, which is metadata a read-only key has no reason to see.
 */
export async function handleAuditRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin } = ctx;
  if (request.method !== 'GET' || url.pathname !== auditPath) return false;
  const limitParam = url.searchParams.get('limit');
  let limit = 100;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) throw invalidRequest('limit must be a whole number between 1 and 1000.');
    limit = parsed;
  }
  const records = await service.listAudit(limit);
  sendJson(response, 200, { object: 'list', data: records }, origin);
  return true;
}
