import type { RouteContext } from './route-context.js';
import { randomUUID } from 'node:crypto';
import { invalidRequest, isRecord, readJsonBody, requestIdOf, sendJson } from '../core/http.js';
import { ProviderError } from '../core/provider-error.js';
import { recordUsage } from './inference.js';

export const rerankPath = '/v1/rerank';

/**
 * `POST /v1/rerank` — order documents against a query.
 *
 * Reranking is a provider capability, not a gateway heuristic: a gateway that invented relevance
 * scores would be answering a different question. The route selects a connection whose adapter
 * declares `rerank`; when none does, it answers `501 NOT_SUPPORTED` rather than falling back to a
 * lexical score that looks like a model's answer.
 */
export async function handleRerankRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, signal } = ctx;
  if (url.pathname !== rerankPath) return false;
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Rerank requires POST.' } }, origin);
    return true;
  }
  const body = await readJsonBody(request, Math.min(ctx.options.maxBodyBytes ?? 1_000_000, 8 * 1024 * 1024));
  if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
  if (typeof body.model !== 'string' || !body.model.trim()) throw invalidRequest('model is required.');
  if (typeof body.query !== 'string' || !body.query.trim()) throw invalidRequest('query is required.');
  const model = body.model as string;
  const query = body.query as string;
  if (!Array.isArray(body.documents) || body.documents.length === 0) throw invalidRequest('documents must be a non-empty array.');
  const documents = body.documents.map((document, index) => {
    if (typeof document === 'string') return { index, text: document };
    if (isRecord(document) && typeof document.text === 'string') return { index, text: document.text, ...(typeof document.id === 'string' ? { id: document.id } : {}) };
    throw invalidRequest(`documents[${index}] must be a string or { id?, text }.`);
  });
  const topN = body.top_n === undefined ? undefined : Number(body.top_n);
  if (topN !== undefined && (!Number.isInteger(topN) || topN <= 0)) throw invalidRequest('top_n must be a positive integer.');
  const requestId = requestIdOf(request) ?? randomUUID().replace(/-/g, '');
  const startedAt = Date.now();
  const refusal = await service.reserveBudget({ requestId, model, route: '/v1/rerank' });
  if (refusal) {
    for (const [name, value] of Object.entries(refusal.headers)) if (value !== undefined) response.setHeader(name, value);
    sendJson(response, refusal.status, { error: { code: refusal.code, message: refusal.message } }, origin);
    return true;
  }
  const result = await service.rerank?.({ model, query, documents, ...(topN === undefined ? {} : { topN }) }, signal);
  if (!result) {
    recordUsage(service, { model, outcome: 'failure', attempts: 0, latencyMs: Date.now() - startedAt, errorCode: 'NOT_SUPPORTED', requestId });
    throw new ProviderError('NOT_SUPPORTED', 'No connection declares rerank support for that model.', { publicMessage: 'No connection declares rerank support for that model.' });
  }
  recordUsage(service, { model, ...(result.providerId ? { providerId: result.providerId } : {}), ...(result.connectionId ? { connectionId: result.connectionId } : {}), outcome: 'success', attempts: 1, latencyMs: Date.now() - startedAt, requestId });
  sendJson(response, 200, { object: 'list', model, data: result.results }, origin);
  return true;
}
