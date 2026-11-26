import type { RouteContext } from './route-context.js';
import { invalidRequest, isRecord, readJsonBody, sendJson } from '../core/http.js';
import { parseGuardrailPolicy } from '../core/guardrails.js';

const guardrailsPath = '/v1/guardrails';

/**
 * `GET`/`PUT /v1/guardrails` — the policy, as data.
 *
 * A dry run is a first-class mode: an operator turns rules on in dry-run, reads the counters, and only
 * then enforces. The route refuses a rule it cannot understand instead of dropping it, because a
 * policy that silently lost a rule is a guardrail that reports success while doing nothing.
 */
export async function handleGuardrailsRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin } = ctx;
  if (url.pathname !== guardrailsPath) return false;
  const store = service.guardrails;
  if (!store) {
    sendJson(response, 200, { available: false, reason: 'This gateway was started without a guardrail store.' }, origin);
    return true;
  }
  if (request.method === 'GET') {
    sendJson(response, 200, { available: true, policy: await store.get() }, origin);
    return true;
  }
  if (request.method === 'PUT') {
    const body = await readJsonBody(request, Math.min(ctx.options.maxBodyBytes ?? 1_000_000, 1_000_000));
    if (!isRecord(body)) throw invalidRequest('The policy must be a JSON object.');
    if (typeof body.enabled !== 'boolean') throw invalidRequest('enabled must be a boolean.');
    if (body.rules !== undefined && !Array.isArray(body.rules)) throw invalidRequest('rules must be an array.');
    const policy = parseGuardrailPolicy(body);
    // A rule whose shape was refused must not vanish from the saved policy.
    if (Array.isArray(body.rules) && policy.rules.length !== body.rules.length) throw invalidRequest('One or more guardrail rules are not readable.');
    sendJson(response, 200, { available: true, policy: await store.set(policy) }, origin);
    return true;
  }
  sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Guardrails are read or replaced.' } }, origin);
  return true;
}
