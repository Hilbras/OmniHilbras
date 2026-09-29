import { ProviderError } from '@hilbras/omnihilbras';
import { isRetryableFailure, type RouteCandidate } from './routing.js';

/**
 * What happens after a request fails.
 *
 * Phase 3, and the smallest useful piece of it: one decision — *retry this route, move to the next
 * one, or stop* — that was previously written inline at each place a request can fail, and had
 * already diverged.
 *
 * ## The divergence this found
 *
 * The chat path had:
 *
 * ```ts
 * if (error.code === 'RATE_LIMITED' && attempts.length > 1) break;
 * if (!isRetryableFailure(error)) throw attachAttempts(error, attempts);
 * ```
 *
 * and the streaming path had:
 *
 * ```ts
 * if (!isRetryableFailure(error) || signal?.aborted) break;
 * ```
 *
 * Two copies, one difference, and the difference was the bug. The chat path's rate-limit rule was
 * gated on `attempts.length > 1` — *not the first attempt* — so a connection that had just answered
 * **"you have reached your limit"** was asked again. Measured, with the attempt ledger as the
 * source of truth:
 *
 * ```
 * chat  / RATE_LIMITED   primary → primary → backup     3 attempts
 * stream/ RATE_LIMITED   primary → backup                2 attempts
 * ```
 *
 * The second request is not a retry that might succeed; it is a request the provider has already
 * said it will refuse, and it is paid for. The line's own comment said *"A per-connection limit
 * should hand off to the next route, not retry here"* — and the condition did the opposite for the
 * one attempt where it mattered most.
 *
 * ## The three answers, and why each
 *
 * - **`stop`.** The failure is permanent, or the caller cancelled. Another connection will refuse
 *   identically, so trying one spends an upstream request to learn nothing. This is the answer for
 *   the four terminal codes, and it is the one a stream and a chat must agree on.
 * - **`next-route`.** This connection cannot serve the request right now — a per-connection limit,
 *   or nothing left to try on it. Another connection might.
 * - **`retry`.** The failure looks transient and this connection has attempts left. A cancelled
 *   signal is never transient, and is checked before this so a caller who asked to stop is not
 *   argued with.
 *
 * ## The one difference that is real
 *
 * Streaming cannot retry at all. Once the first chunk is not yet sent a stream *could* in
 * principle retry, but it does not: the route chain is walked once, and the policy is told so
 * rather than being trusted to notice. A stream that has already emitted bytes is the client's
 * problem to see, not a reason to re-plan the request.
 */

export type FailureAction = 'retry' | 'next-route' | 'stop';

export type RetryPolicyInput = {
  error: unknown;
  /** The connection being tried. */
  candidate: RouteCandidate;
  /** How many times this connection has already been tried, including the failure now in hand. */
  attemptsOnThisRoute: number;
  /** The caller asked to stop. */
  aborted: boolean;
  /** Streaming walks the chain once and does not retry. */
  canRetry: boolean;
};

export class RetryPolicy {
  /**
   * The decision. One function, so the two request paths cannot answer differently.
   *
   * `attemptsOnThisRoute` is the *retry budget*, not the global ledger. Keying the rule off the
   * global count is what made the first attempt behave differently from the second: a connection
   * that was limited on a fresh request had a global count of one, which read as "not the first
   * attempt" for no reason connected to this connection at all.
   */
  afterFailure(input: RetryPolicyInput): FailureAction {
    // A caller who cancelled is never argued with, whatever the error says. A timeout on top of a
    // cancellation is the deadline firing as the request is torn down, and retrying it would spend
    // a request the caller has already abandoned.
    if (input.aborted) return 'stop';
    // Permanent by construction: the request or the credential is wrong, and the next connection
    // will refuse it identically. Spending an upstream request to confirm that is the cost this
    // avoids.
    if (!isRetryableFailure(input.error)) return 'stop';

    /**
     * A per-connection limit hands off, always.
     *
     * Unconditional, and that is the whole fix: a provider that has said "you have reached your
     * limit" has said it about the connection, so the next request to that connection is one it has
     * already refused. Retrying is not optimism, it is paying twice for the same refusal.
     */
    if (input.error instanceof ProviderError && input.error.code === 'RATE_LIMITED') return 'next-route';

    // Nothing left to give this connection.
    if (input.attemptsOnThisRoute >= input.candidate.resilience.maxRetries + 1) return 'next-route';
    return input.canRetry ? 'retry' : 'next-route';
  }
}
