import type { RouteCandidate } from './routing.js';

/**
 * Whether a second request is worth sending, and if so which route.
 *
 * The race in `request-executor.ts` was 107 lines, and every one of them was either bookkeeping or
 * a *decision about spending the operator's money*. The bookkeeping belongs in the executor; the
 * decision belongs here, and a decision that decides how many paid requests a gateway makes should
 * not be discoverable only by reading a timer callback.
 *
 * ## Every answer says why
 *
 * Each refusal carries a reason, because "no hedge was fired" and "a hedge was fired and lost" are
 * completely different outcomes for a client reading the attempt ledger, and a caller asking why
 * their configured `hedgeAfterMs` did nothing deserves an answer other than silence.
 *
 * ## The clause that costs the most
 *
 * `nothing settled`. A hedge is only worth sending while the leader is *still in flight*: if the
 * leader has already answered, the second request is a request whose answer nobody will read, paid
 * for in full. That is the one condition that is checked on every tick rather than once, and it is
 * the one that most easily drifts if the tick and the settle bookkeeping live in different places.
 */
export type HedgeRefusal =
  /** There is no leader, so there is nothing to hedge. */
  | 'no-leader'
  /** Only one route can serve the request, so a hedge would be a second copy of the same call. */
  | 'no-alternative'
  /** The connection did not opt in. A hedge is an extra paid request, so it is off unless asked for. */
  | 'not-configured'
  /** Someone already answered. Sending another request now buys an answer nobody will read. */
  | 'already-won'
  /** The caller went away. */
  | 'cancelled'
  /** The leader has settled. A hedge now is a paid request whose answer is discarded. */
  | 'leader-settled'
  /** Every candidate has been started, so there is nothing left to hedge with. */
  | 'exhausted';

export type HedgeDecision =
  | { hedge: true; candidate: RouteCandidate }
  | { hedge: false; reason: HedgeRefusal };

/** What hedging is for this request, decided once. */
export type HedgePlan = {
  enabled: boolean;
  reason?: Exclude<HedgeRefusal, 'already-won' | 'cancelled' | 'leader-settled' | 'exhausted'>;
  /** The connection whose `hedgeAfterMs` applies. */
  leader?: RouteCandidate;
  /** Everyone who could be hedged with, in preference order. */
  rest: readonly RouteCandidate[];
  /** How long to wait before the first hedge, in ms. */
  delayMs: number;
};

export class HedgePolicy {
  /**
   * Whether hedging is configured for this request at all.
   *
   * Decided once rather than per tick, because three of the seven conditions cannot change while a
   * request is in flight, and re-deciding them is how they drift apart from the loop that obeys them.
   */
  planFor(candidates: readonly RouteCandidate[]): HedgePlan {
    const [leader, ...rest] = candidates;
    if (!leader) return { enabled: false, reason: 'no-leader', rest: [], delayMs: 0 };
    if (rest.length === 0) return { enabled: false, reason: 'no-alternative', rest, delayMs: 0 };
    // Off unless asked for. A hedge is an extra request the operator pays for, and the client gets
    // the faster answer rather than a cheaper one, so it is not a default anyone should inherit.
    if (leader.resilience.hedgeAfterMs <= 0) return { enabled: false, reason: 'not-configured', leader, rest, delayMs: 0 };
    return { enabled: true, leader, rest, delayMs: leader.resilience.hedgeAfterMs };
  }

  /**
   * The decision for one tick: which route to hedge with, or why not.
   *
   * Checked in the order that spends the least to learn the most — a cancelled request is decided
   * before anything is looked at, because there is nothing left to decide.
   */
  nextHedge(input: {
    plan: HedgePlan;
    started: ReadonlySet<RouteCandidate>;
    /** How many requests have settled so far. A hedge past the first is a paid answer nobody reads. */
    settledCount: number;
    hasWinner: boolean;
    aborted: boolean;
  }): HedgeDecision {
    if (!input.plan.enabled || !input.plan.leader) return { hedge: false, reason: 'not-configured' };
    if (input.hasWinner) return { hedge: false, reason: 'already-won' };
    if (input.aborted) return { hedge: false, reason: 'cancelled' };
    // The expensive one: the leader is still in flight, which is the only time a second request can
    // be faster than the first.
    if (input.settledCount > 0) return { hedge: false, reason: 'leader-settled' };
    const next = input.plan.rest.find((candidate) => !input.started.has(candidate));
    if (!next) return { hedge: false, reason: 'exhausted' };
    return { hedge: true, candidate: next };
  }
}
