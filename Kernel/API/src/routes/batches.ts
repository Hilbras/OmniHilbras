import type { RouteContext } from './route-context.js';
import { invalidRequest, isRecord, readJsonBody, sendJson } from '../core/http.js';
import { parseBatchItems } from '../core/batches.js';

const batchesPath = '/v1/batches';

/**
 * `/v1/batches` — submit many requests once, collect them later.
 *
 * The request shape follows OpenAI's batch objects where it can: `requests[].custom_id` and
 * `requests[].body`, with the body being the same chat body `/v1/chat/completions` accepts. A batch
 * runs through the ordinary routing, budget gate and usage accounting; it is a deferred lane, not a
 * cheaper one. The response is `202` with the record; completion is visible by polling this route or
 * by a `batch.completed` webhook.
 */
export async function handleBatchesRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin } = ctx;
  if (url.pathname !== batchesPath && !url.pathname.startsWith(`${batchesPath}/`)) return false;
  const store = service.batches;
  if (!store) {
    sendJson(response, 200, { available: false, reason: 'This gateway was started without a batch store.' }, origin);
    return true;
  }

  if (request.method === 'GET' && url.pathname === batchesPath) {
    const limit = Number(url.searchParams.get('limit') ?? '50');
    sendJson(response, 200, { available: true, batches: await store.list(Number.isFinite(limit) ? limit : 50) }, origin);
    return true;
  }

  if (request.method === 'POST' && url.pathname === batchesPath) {
    const body = await readJsonBody(request, Math.min(ctx.options.maxBodyBytes ?? 1_000_000, 8 * 1024 * 1024));
    if (!isRecord(body)) throw invalidRequest('The batch must be a JSON object.');
    const parsed = parseBatchItems(body.requests);
    if (parsed.error) throw invalidRequest(parsed.error);
    const batch = await service.submitBatch?.(parsed.items);
    if (!batch) throw invalidRequest('This gateway cannot run batches.');
    sendJson(response, 202, { batch }, origin);
    return true;
  }

  if (request.method === 'GET' && url.pathname.startsWith(`${batchesPath}/`)) {
    const id = decodeURIComponent(url.pathname.slice(`${batchesPath}/`.length));
    const batch = await store.get(id);
    if (!batch) throw invalidRequest('That batch does not exist.');
    sendJson(response, 200, { batch }, origin);
    return true;
  }

  if (request.method === 'POST' && url.pathname.endsWith('/cancel')) {
    const id = decodeURIComponent(url.pathname.slice(`${batchesPath}/`.length, -'/cancel'.length));
    const batch = await service.cancelBatch?.(id);
    if (!batch) throw invalidRequest('That batch cannot be cancelled.');
    sendJson(response, 200, { batch }, origin);
    return true;
  }

  sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Unsupported batch method.' } }, origin);
  return true;
}
