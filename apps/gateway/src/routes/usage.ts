import type { ProviderError } from '@hilbras/omnihilbras';
import type { RouteContext } from './route-context.js';
import type { UsageOutcome } from '../usage-store.js';
import { priceUsage, pricingCaveat } from '../usage-pricing.js';
import { sendJson } from '../http.js';

/**
 * `GET /v1/usage` — what has been spent, measured rather than estimated.
 *
 * ## What a record holds, and what it deliberately does not
 *
 * The store's record has no field capable of holding a message, and this route serializes that type directly
 * rather than projecting it. There is no redaction step here because there is nothing to redact: **no prompt,
 * no response, no headers, no credential.** A usage page that shows what things cost does not need the text,
 * and a request log that keeps prompts is a prompt-injection target this gateway does not need to be.
 *
 * ## Three numbers a reader must not confuse
 *
 * `requests` counts records. `inputTokens`/`outputTokens` sum only over records where the provider actually
 * reported usage, and `tokensUnmeasured` says whether *any* did. An unmetered provider and a free provider
 * both sum to zero, so the flag is what keeps the page from presenting an absence as a measurement.
 *
 * ## The gateway may hold no store at all
 *
 * `GatewayServiceOptions.usageStore` is optional and has no default, so "this gateway records nothing" is a
 * state a caller chose. That is reported honestly — `recording: false` with empty totals — rather than
 * returning a 404 or, worse, zeros that read as "you have spent nothing".
 */
export const usagePath = '/v1/usage';

/** Outcomes, as an allowlist rather than a cast: an unknown value is a caller bug, not a passthrough. */
const outcomes: readonly UsageOutcome[] = ['success', 'failure', 'cancelled'];

/** Rows returned when the caller does not ask for a count. The totals still cover every retained record. */
const recentRequestsDefault = 10;

export async function handleUsageRoute(context: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin } = context;
  // A positive comparison on purpose: `!==` would be the same route and an *invisible* one. The route guard
  // in `tests/gateway-routes.test.js` resolves `url.pathname === <constant>` but not `!==`, and a route it
  // cannot see is a route nobody can be reminded to document. Every other route module here matches `===`.
  if (url.pathname === usagePath) {
    // fall through to the handling below
  } else {
    return false;
  }
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Usage is read-only.' } }, origin);
    return true;
  }

  const store = service.usage;
  if (!store) {
    sendJson(response, 200, {
      recording: false,
      reason: 'This gateway was started without a usage store, so no request has been recorded.',
      totals: { requests: 0, succeeded: 0, failed: 0, cancelled: 0, inputTokens: 0, outputTokens: 0, tokensUnmeasured: true },
      records: [],
    }, origin);
    return true;
  }

  // Every query value is validated here rather than trusted, because each becomes a filter predicate. An
  // unvalidated `outcome` would silently match nothing, which reads as "you have no failures" rather than
  // as "that was not a value".
  const outcomeParam = url.searchParams.get('outcome');
  if (outcomeParam !== null && !outcomes.includes(outcomeParam as UsageOutcome)) {
    sendJson(response, 400, {
      error: { code: 'INVALID_REQUEST', message: `outcome must be one of ${outcomes.join(', ')}.` },
    }, origin);
    return true;
  }

  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null && (!/^\d+$/.test(limitParam) || Number(limitParam) > 10_000)) {
    sendJson(response, 400, {
      error: { code: 'INVALID_REQUEST', message: 'limit must be an integer from 0 to 10000.' },
    }, origin);
    return true;
  }

  const offsetParam = url.searchParams.get('offset');
  if (offsetParam !== null && !/^\d+$/.test(offsetParam)) {
    sendJson(response, 400, {
      error: { code: 'INVALID_REQUEST', message: 'offset must be a non-negative integer.' },
    }, origin);
    return true;
  }

  try {
    const summary = await store.summary({
      ...(url.searchParams.get('provider') ? { providerId: url.searchParams.get('provider')! } : {}),
      ...(url.searchParams.get('model') ? { model: url.searchParams.get('model')! } : {}),
      ...(url.searchParams.get('connection') ? { connectionId: url.searchParams.get('connection')! } : {}),
      ...(url.searchParams.get('since') ? { since: url.searchParams.get('since')! } : {}),
      ...(url.searchParams.get('until') ? { until: url.searchParams.get('until')! } : {}),
      ...(outcomeParam ? { outcome: outcomeParam as UsageOutcome } : {}),
    });
    // Totals and cost cover every retained record that matches; only the listed rows are capped. A cap
    // applied to the store query would shrink the totals with it, so the page would report fewer requests
    // than the gateway recorded.
    const offset = offsetParam !== null ? Number(offsetParam) : 0;
    const pageSize = limitParam !== null ? Number(limitParam) : recentRequestsDefault;
    const listed = summary.records.slice(offset, offset + pageSize);
    // Priced at read time from the connection's catalog, never stored and never defaulted. See
    // `usage-pricing.ts`: a model whose provider publishes no price contributes tokens to the totals and
    // nothing to the cost, and the response says how much of the page that covers.
    const prices = await service.modelPrices(summary.records);
    const priced = priceUsage(summary.records.map((record, index) => ({ ...record, pricing: prices[index] })));
    sendJson(response, 200, {
      recording: true,
      totals: summary.totals,
      records: listed,
      cost: {
        ...priced,
        // `null` rather than a string nobody should show: a caveat printed every time is a caveat read
        // never, so the route returns nothing when every record was priced.
        caveat: pricingCaveat(priced),
      },
    }, origin);
    return true;
  } catch (error) {
    // A store that cannot be read is a report that is missing, not a request that failed. The error shape is
    // the standard one so a client can read it, and the cause is the real one rather than a blanket 500.
    const code = (error as Partial<ProviderError>)?.code ?? 'INTERNAL_ERROR';
    sendJson(response, 500, {
      error: {
        code,
        message: 'Usage records could not be read.',
      },
    }, origin);
    return true;
  }
}
