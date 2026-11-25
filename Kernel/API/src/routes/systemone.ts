/**
 * `POST /v1/systemone` — a native decision-model JSON lane.
 *
 * Decision models do not speak the chat translation layer: the body that arrives (`model`, `state`,
 * `questions`) is the body the vendor expects, and the JSON answer is returned untouched. The only
 * edit is the model id, replaced by the catalog's stated upstream id when the connection recorded
 * one. This is not a chat route in disguise, and no result is simulated when a provider has no wire.
 *
 * Two refusals are deliberate. A connection with no declared System One endpoint is named in a
 * `501 NOT_SUPPORTED` rather than silently sent to its chat endpoint — a different wire would answer
 * with a different shape and look like success. And no client-impersonation header or `public` token
 * stub is generated: the credential is the saved account's own, or the request is refused.
 *
 * It is a management path (`/v1/systemone` is in `MANAGEMENT_PREFIXES`), so with key enforcement on
 * an unauthenticated caller is refused before this handler runs. The handler also asks the same
 * authorization question the inference surface asks, because this route spends a real turn.
 */

import type { RouteContext } from './route-context.js';
import { invalidRequest, isRecord, maxInferenceBodyBytes, readJsonBody, requestIdOf, sendJson } from '../core/http.js';
import { ProviderError, isProviderError } from '../core/provider-error.js';
import { extractApiKey, getExplicitConnectionId, getExplicitProviderId } from './inference.js';
import { isTrustedDashboard } from '../core/runtime.js';

const SYSTEMONE_PATH = '/v1/systemone';

export async function handleSystemOneRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, options, origin, signal } = ctx;
  if (request.method !== 'POST' || url.pathname !== SYSTEMONE_PATH) return false;

  if (!isTrustedDashboard(ctx.auth)) await service.authorizePublicRequest(extractApiKey(request));

  const parsed = await readJsonBody(request, options.maxBodyBytes ?? maxInferenceBodyBytes);
  if (!isRecord(parsed)) throw invalidRequest('The request body must be a JSON object.');
  const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
  if (!model) throw invalidRequest('model must be a non-empty string.');
  if (parsed.state === undefined || parsed.state === null) throw invalidRequest('state is required.');
  if (!isRecord(parsed.questions)) throw invalidRequest('questions must be an object of questions.');

  const scope = service.startScope(model, undefined, undefined, requestIdOf(request));
  const startedAt = Date.now();
  let providerId: string | undefined;
  let attempts = 1;
  try {
    const result = await service.runSystemOne({
      model,
      body: parsed,
      ...(getExplicitConnectionId(request, parsed) ? { connectionId: getExplicitConnectionId(request, parsed) } : {}),
      ...(getExplicitProviderId(request, parsed) ? { explicitProviderId: getExplicitProviderId(request, parsed) } : {}),
      signal,
    });
    providerId = result.providerId;
    attempts = result.attempts;
    void service.usage?.record({
      at: new Date().toISOString(),
      model,
      providerId: result.providerId,
      ...(result.connectionId ? { connectionId: result.connectionId } : {}),
      outcome: 'success',
      attempts,
      latencyMs: Date.now() - startedAt,
      requestId: scope.id,
    }).catch(() => undefined);
    sendJson(response, 200, result.body, origin);
    return true;
  } catch (error) {
    const reported = isProviderError(error)
      ? (error.details as { attempts?: unknown } | undefined)?.attempts
      : undefined;
    if (typeof reported === 'number' && Number.isSafeInteger(reported) && reported > 0) attempts = reported;
    void service.usage?.record({
      at: new Date().toISOString(),
      model,
      ...(providerId ? { providerId } : {}),
      outcome: 'failure',
      attempts,
      latencyMs: Date.now() - startedAt,
      ...(isProviderError(error) ? { errorCode: error.code } : { errorCode: 'SYSTEMONE_FAILED' }),
      requestId: scope.id,
    }).catch(() => undefined);
    throw error;
  }
}
