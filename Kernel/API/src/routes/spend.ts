import type { RouteContext } from './route-context.js';
import { invalidRequest, sendJson } from '../core/http.js';
import { evaluateBudget, microsToUsd, type Budget, type BudgetPeriod } from '../core/budgets.js';

const spendPath = '/v1/spend';
const periods: readonly BudgetPeriod[] = ['day', 'week', 'month', 'total'];

/**
 * `GET /v1/spend` — what one key or workspace has spent, and how much of its budget is left.
 *
 * The usage page answers "what happened"; this answers "may this keep happening". They are different
 * questions over different data on purpose: usage is bounded to the last thousand requests, while
 * the ledger keeps day buckets for a year, so a monthly budget does not reset when the log rolls.
 *
 * A scope and an id are required. A summary of "every key" belongs on the usage page, where the
 * records are; asking for it here would invite a second implementation of the same totals.
 */
export async function handleSpendRoute(context: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin } = context;
  if (url.pathname !== spendPath) return false;
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Spend is read-only.' } }, origin);
    return true;
  }
  const scopeParam = url.searchParams.get('scope');
  if (scopeParam !== 'key' && scopeParam !== 'workspace') throw invalidRequest('scope must be key or workspace.');
  const id = url.searchParams.get('id');
  if (!id) throw invalidRequest('id is required.');
  const periodParam = url.searchParams.get('period') ?? 'month';
  if (!periods.includes(periodParam as BudgetPeriod)) throw invalidRequest(`period must be one of ${periods.join(', ')}.`);
  const period = periodParam as BudgetPeriod;

  const ledger = service.spend;
  if (!ledger) {
    sendJson(response, 200, {
      ledger: false,
      reason: 'This gateway was started without a spend ledger, so budgets cannot be enforced or reported.',
      scope: scopeParam,
      id,
      period,
    }, origin);
    return true;
  }

  const spend = await ledger.snapshot(scopeParam, id, period);
  let budget: Budget | undefined;
  if (scopeParam === 'key') {
    const listed = await service.listApiKeys();
    budget = listed.keys.find((key) => key.id === id)?.budget;
  } else {
    budget = (await service.workspaces?.get(id))?.budget;
  }
  const status = budget ? evaluateBudget(budget, spend) : undefined;
  sendJson(response, 200, {
    ledger: true,
    scope: scopeParam,
    id,
    period,
    spend: {
      usd: microsToUsd(spend.usdMicros),
      usdMicros: spend.usdMicros,
      tokens: spend.tokens,
      requests: spend.requests,
      unpricedRequests: spend.unpricedRequests,
      heldUsd: microsToUsd(spend.heldUsdMicros),
    },
    ...(budget ? { budget } : {}),
    ...(status ? {
      status: {
        allowed: status.allowed,
        ...(status.remainingUsdMicros === undefined ? {} : { remainingUsd: microsToUsd(status.remainingUsdMicros) }),
        ...(status.remainingTokens === undefined ? {} : { remainingTokens: status.remainingTokens }),
        ...(status.resetAt === undefined ? {} : { resetAt: status.resetAt }),
      },
    } : {}),
  }, origin);
  return true;
}
