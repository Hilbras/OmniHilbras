import type { GatewayRoutingState } from './gatewayClient';

/**
 * Why routing would not choose a connection — decided from the gateway's own reasons.
 *
 * ## What this replaces
 *
 * `RoutingPage` used to answer "can routing use this?" by reading the record itself:
 *
 * ```ts
 * if (!connection.enabled) return 'paused …';
 * if (!connection.hasCredential) return 'no credential saved';
 * if (connection.ejected) return `ejected after ${connection.failures} consecutive failures …`;
 * if (connection.lastError) return `last attempt failed: ${connection.lastError}`;
 * return undefined;   // → "eligible — routing can choose this"
 * ```
 *
 * Four fields, four rules, hand-written in a `.tsx` — and it disagreed with routing in two measured
 * ways. `resolveRoute` skips on health *only* once `failures >= failureThreshold`, so a connection
 * with one timeout and a threshold of 3 is a **live candidate**; this rule read `lastError` and
 * called it blocked, so the page said "last attempt failed" about a route the next request would take.
 * And it had no rule at all for rate limiting: a connection over its per-minute limit was skipped by
 * routing with reason `rate-limited` and shown here as eligible, because `rateLimitWaitMs` was never
 * in the payload (`RoutingEngine.waits()` had no caller outside tests — the promise in
 * `rate-limit-policy.ts` that the dashboard would see a cooling-down connection was not wired up).
 *
 * The shape of the defect is the session's recurring one: **two copies of one decision, free to
 * disagree, with the disagreement invisible until some invisible state picks a winner.** Here the
 * winner is `lastError`, which survives after the ejection it triggered has decayed.
 *
 * ## Why the ordering is the gateway's
 *
 * The order below is the order `resolveRoute` applies: eligibility filters first, then health, then
 * the rate-limit wait. The first reason that applies is the one shown, because that is the reason the
 * connection is not in the candidate list — later rules do not change that it was dropped, only why
 * routing would notice next. `ejected` is checked before `lastError` because ejection is the decision
 * and the error is the evidence; showing the evidence while hiding the decision inverts them.
 *
 * `lastError` alone is no longer a reason. A stale error is shown as context on an eligible
 * connection, which is what it is: a record of one past failure, not a verdict on the route.
 */
export type RoutingSkipCopy = { eligible: true } | { eligible: false; reason: string };

/** The subset of a routing connection this decides on, so the test can build the awkward cases. */
export type RoutingVerdictInput = GatewayRoutingState['connections'][number] & { rateLimitWaitMs?: number };

const ms = (value: number) => `${Math.ceil(value / 1000)} s`;

export function routingVerdict(connection: RoutingVerdictInput, failureThreshold: number): RoutingSkipCopy {
  if (!connection.enabled) return { eligible: false, reason: 'paused — routing skips it before health is considered' };
  if (!connection.hasCredential) return { eligible: false, reason: 'no credential saved' };
  if (connection.ejected) {
    return { eligible: false, reason: `ejected after ${connection.failures ?? 0} consecutive failures (threshold ${failureThreshold})` };
  }
  // `ejected` already covers "failing hard". A failure below the threshold is a blip the gateway is
  // deliberately tolerating, and calling the route unusable over it contradicts the candidate list.
  if ((connection.rateLimitWaitMs ?? 0) > 0) {
    return { eligible: false, reason: `at its rate limit — retry in ${ms(connection.rateLimitWaitMs ?? 0)}` };
  }
  return { eligible: true };
}

/**
 * The one count on this page: how many connections routing could choose right now.
 *
 * Counted from the same verdict the cards render, so the summary and the cards cannot disagree —
 * the two were derived separately before, which is how a page could report "3 eligible" above three
 * cards that each said otherwise.
 */
export function eligibleCount(connections: readonly RoutingVerdictInput[], failureThreshold: number): number {
  return connections.filter((connection) => routingVerdict(connection, failureThreshold).eligible).length;
}