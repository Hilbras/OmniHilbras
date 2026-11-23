/**
 * `POST /v1/fetch` — a bounded document read through the gateway's own transport.
 *
 * Two refusals are deliberate. A named provider without a declared web-fetch capability is answered
 * with `NOT_SUPPORTED` by name rather than silently falling back to a gateway-side HTTP GET, because a
 * caller who asked for a provider's reader must not receive a different thing. And every URL goes
 * through the hostname-text check, a loopback refusal, and the async DNS check in
 * `assertPublicDestination` — the transport's own hook skips loopback by design for local inference,
 * which is the opposite of what an arbitrary user-supplied URL needs.
 *
 * Nothing puts the fetched text into a usage record. The record carries a request id, an outcome and a
 * byte count at most; prompts and responses stay out of the store by construction.
 */

import type { RouteContext } from './route-context.js';
import { invalidRequest, isRecord, readJsonBody, requestIdOf, sendJson } from '../core/http.js';
import { ProviderError } from '../core/provider-error.js';

const FETCH_PATH = '/v1/fetch';

export async function handleFetchRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, options, origin, signal } = ctx;
  if (request.method !== 'POST' || url.pathname !== FETCH_PATH) return false;

  const body = await readJsonBody(request, options.maxBodyBytes ?? 1_000_000);
  if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
  if (typeof body.url !== 'string' || !body.url.trim()) throw invalidRequest('url must be a non-empty string.');
  const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : undefined;
  if (provider !== undefined) {
    // No bundled adapter declares a web-fetch reader today; a provider-scoped read therefore cannot be
    // served by substituting the gateway's own HTTP client. The refusal names the capability rather
    // than saying the provider is unavailable.
    const declares = await service.supportsWebFetch(provider);
    const message = declares
      ? `Provider "${provider}" declares web fetch, but no provider-scoped reader is wired.`
      : `Provider "${provider}" does not support web fetch.`;
    throw new ProviderError('NOT_SUPPORTED', message, { providerId: provider, publicMessage: message });
  }

  const maxBytes = body.maxBytes === undefined ? undefined : body.maxBytes;
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || (maxBytes as number) <= 0)) {
    throw invalidRequest('maxBytes must be a positive integer.');
  }
  const startedAt = Date.now();
  const scope = service.startScope('web-fetch', undefined, undefined, requestIdOf(request));
  try {
    const result = await service.fetchDocument({
      url: body.url.trim(),
      ...(maxBytes === undefined ? {} : { maxBytes: maxBytes as number }),
      signal,
    });
    void service.usage?.record({
      at: new Date().toISOString(),
      model: 'web-fetch',
      outcome: 'success',
      attempts: 1,
      latencyMs: Date.now() - startedAt,
      requestId: scope.id,
    }).catch(() => undefined);
    sendJson(response, 200, {
      object: 'fetch',
      url: result.url,
      status: result.status,
      contentType: result.contentType,
      bytes: result.bytes,
      truncated: result.truncated,
      text: result.text,
      gateway: { requestId: scope.id },
    }, origin);
  } catch (error) {
    void service.usage?.record({
      at: new Date().toISOString(),
      model: 'web-fetch',
      outcome: 'failure',
      attempts: 1,
      latencyMs: Date.now() - startedAt,
      ...(error instanceof ProviderError ? { errorCode: error.code } : { errorCode: 'FETCH_FAILED' }),
      requestId: scope.id,
    }).catch(() => undefined);
    throw error;
  }
  return true;
}
