// Per-request budget on upstream calls.
//
// One client request can turn into many upstream calls: a combo tries each of
// its models against each provider account, and a fusion combo runs every panel
// model in parallel plus a judge call. Without a bound, a single request can
// drain the operator's provider accounts, so the gateway spends from a budget
// that is created per client request and threaded down to the places that
// actually call upstream.
//
// The budget is deliberately dependency-free apart from the error helper: it is
// created by the app layer (which knows the configured limit) and consumed by
// the engine, which must not read the settings itself.
import { errorResponse } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

/**
 * @param {number} limit - Max upstream calls allowed for one client request.
 *   A non-positive / non-finite limit means "unbounded".
 * @param {Function} [onExhaust] - Called once when the budget runs out. The
 *   app layer uses it to report the rejection: the budget is spent in the
 *   handlers, so the limiter itself never sees the exhaustion.
 */
export function createFanOutBudget(limit, onExhaust = null) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity;
  return { limit: max, used: 0, exhausted: false, labels: [], onExhaust };
}

/**
 * Spend one slot of the budget.
 * @returns {boolean} true when the call may proceed, false when the budget is
 *   exhausted (the caller must stop and tell the client).
 */
export function consumeFanOutSlot(budget, label) {
  if (!budget) return true;
  if (budget.used >= budget.limit) {
    // The report fires once: several handlers can notice the exhaustion.
    if (!budget.exhausted) {
      budget.exhausted = true;
      try {
        budget.onExhaust?.();
      } catch {
        // Reporting must never break the request that ran out of budget.
      }
    }
    return false;
  }
  budget.used += 1;
  if (label) budget.labels.push(label);
  return true;
}

/** Slots still available in the budget (Infinity when unbounded). */
export function fanOutRemaining(budget) {
  if (!budget) return Infinity;
  return Math.max(0, budget.limit - budget.used);
}

/**
 * The response the client gets when its request tried to fan out further than
 * the budget allows. It names the cap so the caller knows the request itself
 * was too wide, not that a provider was unavailable.
 */
export function fanOutLimitResponse(budget) {
  const limit = Number.isFinite(budget?.limit) ? budget.limit : "unlimited";
  const message =
    `Request exceeded the upstream call limit for a single client request ` +
    `(max ${limit} upstream calls). Use a smaller combo, or split the request.`;
  return errorResponse(HTTP_STATUS.RATE_LIMITED, message, { "Retry-After": "60" });
}
