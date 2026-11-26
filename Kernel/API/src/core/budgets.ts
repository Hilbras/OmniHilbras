import type { RequestPrincipal } from './principal.js';

/**
 * What a key or workspace may spend, and when the question is asked.
 *
 * ## Why budgets live beside the key rather than in a billing service
 *
 * This is a local-first gateway pointed at the user's own provider accounts. A budget here is not an
 * invoice; it is a guardrail the operator sets so an agent, a shared key or a runaway loop cannot
 * spend a month's allowance in an afternoon. It is therefore enforced before dispatch and expressed
 * in the same units the usage page already reports — dollars and tokens — not credits.
 *
 * ## UTC windows, micro-USD
 *
 * Two operators in two timezones must not disagree about when a day started, so every window is UTC
 * and the reset time is returned to the client. Money is an integer count of millionths of a dollar:
 * a float column that accumulates `0.1 + 0.2` is how a budget ends up refusing at `$9.999999`.
 */

export type BudgetPeriod = 'day' | 'week' | 'month' | 'total';

export type Budget = {
  /** Dollars, as a positive decimal in configuration. Converted to micro-USD for arithmetic. */
  usd?: number;
  /** Tokens (input + output), as a positive integer. */
  tokens?: number;
  period: BudgetPeriod;
};

export type SpendSnapshot = {
  usdMicros: number;
  tokens: number;
  /** Held by in-flight requests: worst-case reservations, released on settlement. */
  heldUsdMicros: number;
  requests: number;
  /** Records with no price, so a dollar budget cannot see them. Always shown, never counted as $0. */
  unpricedRequests: number;
};

export type BudgetStatus =
  | { allowed: true; remainingUsdMicros?: number; remainingTokens?: number; resetAt?: string }
  | {
      allowed: false;
      kind: 'usd' | 'tokens';
      limit: number;
      remainingUsdMicros?: number;
      remainingTokens?: number;
      resetAt?: string;
    };

export const usdToMicros = (usd: number): number => Math.round(usd * 1_000_000);
export const microsToUsd = (micros: number): number => micros / 1_000_000;

const periods: readonly BudgetPeriod[] = ['day', 'week', 'month', 'total'];

/** The UTC window a period describes, with `endMs` absent for a lifetime budget. */
export function budgetWindow(period: BudgetPeriod, at: Date = new Date()): { startMs: number; endMs?: number } {
  if (period === 'total') return { startMs: 0 };
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const day = at.getUTCDate();
  if (period === 'day') {
    const start = Date.UTC(year, month, day);
    return { startMs: start, endMs: start + 86_400_000 };
  }
  if (period === 'week') {
    // Monday 00:00 UTC. `getUTCDay()` is 0 for Sunday, which is the end of an ISO week.
    const weekday = (at.getUTCDay() + 6) % 7;
    const start = Date.UTC(year, month, day - weekday);
    return { startMs: start, endMs: start + 7 * 86_400_000 };
  }
  const start = Date.UTC(year, month, 1);
  return { startMs: start, endMs: Date.UTC(year, month + 1, 1) };
}

/** ISO 8601 reset time for the next boundary, or undefined for a lifetime budget. */
export function budgetResetAt(period: BudgetPeriod, at: Date = new Date()): string | undefined {
  const { endMs } = budgetWindow(period, at);
  return endMs === undefined ? undefined : new Date(endMs).toISOString();
}

/** Reads a stored budget, refusing shapes the rest of the system would have to guess about. */
export function parseBudget(value: unknown): Budget | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const period = typeof record.period === 'string' && periods.includes(record.period as BudgetPeriod)
    ? (record.period as BudgetPeriod)
    : undefined;
  if (!period) return undefined;
  const usd = typeof record.usd === 'number' && Number.isFinite(record.usd) && record.usd > 0 ? record.usd : undefined;
  const tokens = typeof record.tokens === 'number' && Number.isInteger(record.tokens) && record.tokens > 0 ? record.tokens : undefined;
  if (usd === undefined && tokens === undefined) return undefined;
  return { period, ...(usd === undefined ? {} : { usd }), ...(tokens === undefined ? {} : { tokens }) };
}

/** The same validation, for a route that must answer why a body was refused. */
export function validateBudget(value: unknown): { budget?: Budget; error?: string } {
  const budget = parseBudget(value);
  if (budget) return { budget };
  return { error: 'budget must carry a period (day, week, month, total) and a positive usd or tokens limit.' };
}

/**
 * Whether one more request may start.
 *
 * A request at the limit is refused; a request that would cross it is allowed to start and then
 * settles, which is what makes the reservation meaningful rather than a guess at the exact cost.
 * The caller reserves before dispatch, so concurrent requests see each other's hold.
 */
export function evaluateBudget(budget: Budget, snapshot: SpendSnapshot, at: Date = new Date()): BudgetStatus {
  const resetAt = budgetResetAt(budget.period, at);
  const limitUsdMicros = budget.usd === undefined ? undefined : usdToMicros(budget.usd);
  const limitTokens = budget.tokens;
  const remainingUsdMicros = limitUsdMicros === undefined
    ? undefined
    : Math.max(0, limitUsdMicros - snapshot.usdMicros - snapshot.heldUsdMicros);
  const remainingTokens = limitTokens === undefined ? undefined : Math.max(0, limitTokens - snapshot.tokens);
  if (limitUsdMicros !== undefined && snapshot.usdMicros + snapshot.heldUsdMicros >= limitUsdMicros) {
    return {
      allowed: false,
      kind: 'usd',
      limit: limitUsdMicros,
      ...(remainingUsdMicros === undefined ? {} : { remainingUsdMicros }),
      ...(remainingTokens === undefined ? {} : { remainingTokens }),
      ...(resetAt === undefined ? {} : { resetAt }),
    };
  }
  if (limitTokens !== undefined && snapshot.tokens >= limitTokens) {
    return {
      allowed: false,
      kind: 'tokens',
      limit: limitTokens,
      ...(remainingUsdMicros === undefined ? {} : { remainingUsdMicros }),
      ...(remainingTokens === undefined ? {} : { remainingTokens }),
      ...(resetAt === undefined ? {} : { resetAt }),
    };
  }
  return {
    allowed: true,
    ...(remainingUsdMicros === undefined ? {} : { remainingUsdMicros }),
    ...(remainingTokens === undefined ? {} : { remainingTokens }),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

/** The budget fields a principal carries, so a gate does not have to ask the key store per request. */
export type PrincipalBudget = Pick<RequestPrincipal, 'apiKeyId' | 'workspaceId'> & {
  budget?: Budget;
};
