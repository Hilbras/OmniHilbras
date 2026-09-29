import { ProviderError, type ProviderError as ProviderErrorType } from '@hilbras/omnihilbras';
import type { SlidingWindowRateLimiter } from './routing.js';
import type { RouteCandidate } from './routing.js';

/**
 * What a request limit means, and when it is spent.
 *
 * The mechanism is a sliding window of timestamps. The policy is everything around it, and it was
 * split across two files: the window answered "may I send, and how long should I wait", the routing
 * engine turned a wait into a refusal and recorded it, and the request executor decided when to
 * spend the budget. Three files, one policy, and the disagreement between them was the defect
 * fixed in 1.25.0 — a limit of 60 per minute allowed 30, because the query recorded *and* the
 * dispatch recorded.
 *
 * ## Asking costs nothing
 *
 * `check` is a query. It reads the window and returns a wait, and it changes nothing, so a request
 * the limit refuses spends no budget — there was no request to spend it on. The commit is
 * `spend`, and the executor calls it when a request is **dispatched**, not when it succeeds: a
 * request that was sent and then failed still cost the provider a call, and a limit that forgives
 * failures is not a limit.
 *
 * ## Why a zero limit means unlimited
 *
 * This is a local, single-operator gateway pointed at the user's own providers. A default rate
 * limit would refuse requests the user did not know was throttled, for no protection — the thing
 * being protected is the user's own account, and the user can set a limit if they want one. So `0`
 * means unlimited, and it is asked for rather than inferred.
 */

export type RateLimitPolicyOptions = {
  limiter: SlidingWindowRateLimiter;
};

export class RateLimitPolicy {
  /**
   * The waits each connection was last told to observe.
   *
   * Held here rather than in the engine so the whole limit policy is one object, and so the
   * dashboard's view of a cooling-down connection cannot disagree with the limiter that made it
   * cool. A wait of `0` is recorded as `0` and not omitted: *never checked* and *not waiting* are
   * different answers, and a connection that refuses traffic while looking ready is one an
   * operator keeps sending to.
   */
  private readonly waits = new Map<string, number>();

  constructor(private readonly options: RateLimitPolicyOptions) {}

  /**
   * The wait each connection was last told to observe, keyed by connection id.
   *
   * A read-only *view* rather than a copy, because `plan()` reads it on every request and copying
   * a map per request to defend against a caller that does not exist would be the wrong trade. And
   * a view rather than the map itself, because `ReadonlyMap` is only a type: handing back the real
   * `Map` under that annotation is a promise the runtime does not keep, and a caller that could
   * `set` a wait could make a throttled connection look ready — the exact confusion these waits
   * exist to prevent.
   */
  observed(): ReadonlyMap<string, number> {
    // Held in a local rather than reached for through `this`, because inside the returned literal
    // `this` is contextually typed as the `ReadonlyMap` and not as this class.
    const waits = this.waits;
    return {
      get: (key) => waits.get(key),
      has: (key) => waits.has(key),
      get size() { return waits.size; },
      entries: () => waits.entries(),
      keys: () => waits.keys(),
      values: () => waits.values(),
      forEach: (callback, thisArg) => waits.forEach(callback, thisArg),
      [Symbol.iterator]: () => waits[Symbol.iterator](),
    };
  }

  /**
   * Checks one candidate, and refuses it if its connection is over its limit.
   *
   * The wait is recorded either way, so the dashboard sees a connection as cooling down rather
   * than as unknown.
   */
  enforce(candidate: RouteCandidate): void {
    const waitMs = this.options.limiter.check(candidate.connectionId, candidate.resilience.requestsPerMinute);
    this.waits.set(candidate.connectionId, waitMs);
    if (waitMs > 0) throw this.refusal(candidate);
  }

  /**
   * Counts one dispatched request against its connection's budget.
   *
   * Called when a request is sent — not when it succeeds, and not when the limit allowed it. The
   * three are different facts and conflating any two of them is how a limit ended up half of what
   * it said.
   */
  spend(connectionId: string): void {
    this.options.limiter.record(connectionId);
  }

  /**
   * The refusal a limited connection gets.
   *
   * `retryable`, because it is retryable — *elsewhere*. The retry policy reads the code and hands
   * off to the next route, so a limited connection steps aside rather than being asked again.
   */
  refusal(candidate: RouteCandidate): ProviderErrorType {
    return new ProviderError(
      'RATE_LIMITED',
      `This connection reached its limit of ${candidate.resilience.requestsPerMinute} requests per minute.`,
      { providerId: candidate.providerId, retryable: true },
    );
  }
}
