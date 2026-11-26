import type { RouteContext } from './route-context.js';
import { invalidRequest, sendJson } from '../core/http.js';

const jobsPath = '/v1/jobs';

/**
 * `GET /v1/jobs` — the durable history of background passes.
 *
 * Health sweeps and token renewals record start/duration/outcome here. This is a history, not a
 * scheduler: stopping the timer stops the runs, and the record is what lets an operator see that a
 * sweep failed without reading a log file. Owner-only, like the audit trail.
 */
export async function handleJobsRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin } = ctx;
  if (request.method !== 'GET' || url.pathname !== jobsPath) return false;
  const limitParam = url.searchParams.get('limit');
  let limit = 50;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) throw invalidRequest('limit must be a whole number between 1 and 1000.');
    limit = parsed;
  }
  sendJson(response, 200, { object: 'list', data: await service.listJobs(limit) }, origin);
  return true;
}
