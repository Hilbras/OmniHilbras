import { invalidRequest, sendJson } from '../core/http.js';
import { resolveUsagePeriod, usagePeriods, type UsagePeriod } from '../core/usage-breakdown.js';
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

  if (url.pathname === '/v1/token-saver/stats') {
    const periodParam = url.searchParams.get('period') ?? '7d';
    if (!usagePeriods.includes(periodParam as UsagePeriod)) {
      throw invalidRequest(`period must be one of ${usagePeriods.join(', ')}.`);
    }
    const period = periodParam as UsagePeriod;
    const { since } = resolveUsagePeriod(period, new Date());
    const records = await service.usage?.list({ ...(since ? { since: since.toISOString() } : {}) }) ?? [];
    const savers = new Map<string, { id: string; kind: string; requests: number; requestsWithSavings: number; tokensSaved: number; bytesSaved: number }>();
    const providers = new Map<string, { providerId: string; requests: number; tokensSaved: number; bytesSaved: number }>();
    let requestsWithTelemetry = 0;
    let requestsWithSavings = 0;
    let totalTokensSaved = 0;
    let totalBytesSaved = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    for (const record of records) {
      cacheReadTokens += record.cacheReadTokens ?? 0;
      cacheWriteTokens += record.cacheWriteTokens ?? 0;
      const compression = record.compression;
      if (!compression) continue;
      requestsWithTelemetry += 1;
      const saved = compression.totalTokensSaved > 0 || compression.totalBytesSaved > 0;
      if (saved) requestsWithSavings += 1;
      totalTokensSaved += compression.totalTokensSaved;
      totalBytesSaved += compression.totalBytesSaved;
      const providerId = record.providerId ?? 'unattributed';
      const provider = providers.get(providerId) ?? { providerId, requests: 0, tokensSaved: 0, bytesSaved: 0 };
      provider.requests += 1;
      provider.tokensSaved += compression.totalTokensSaved;
      provider.bytesSaved += compression.totalBytesSaved;
      providers.set(providerId, provider);
      for (const [id, entry] of Object.entries(compression.savers)) {
        const saver = savers.get(id) ?? { id, kind: entry.kind, requests: 0, requestsWithSavings: 0, tokensSaved: 0, bytesSaved: 0 };
        saver.requests += 1;
        if (entry.tokensSaved > 0) saver.requestsWithSavings += 1;
        saver.tokensSaved += entry.tokensSaved;
        saver.bytesSaved += Math.max(0, entry.bytesBefore - entry.bytesAfter);
        savers.set(id, saver);
      }
    }
    sendJson(response, 200, {
      period,
      ...(since ? { since: since.toISOString() } : {}),
      requests: records.length,
      requestsWithTelemetry,
      requestsWithSavings,
      totalTokensSaved,
      totalBytesSaved,
      cache: { read: cacheReadTokens, write: cacheWriteTokens },
      savers: [...savers.values()].sort((a, b) => b.tokensSaved - a.tokensSaved),
      byProvider: [...providers.values()].sort((a, b) => b.tokensSaved - a.tokensSaved),
    }, origin);
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
