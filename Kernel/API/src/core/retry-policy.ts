import { isProviderError, ProviderError } from './provider-error.js';
import { isRetryableFailure, providerWordingOf, saysAccountRestricted, shouldRotateAccount, type RouteCandidate } from './routing.js';

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

    /**
     * A dead credential stops here, even though a sibling *could* answer.
     *
     * This is the one place the "move on" rule is deliberately not applied. Rotating past a revoked
     * key would succeed — and would quietly bill a different account for every request while the
     * operator's broken account stays broken and invisible. The failure belongs to the account that
     * owns the credential, so it is reported against it.
     */
    if (isProviderError(input.error) && (input.error.code === 'AUTHENTICATION_FAILED' || input.error.statusCode === 401)) return 'stop';

    /**
     * A **local** concurrency saturation stops here too.
     *
     * It arrives during dispatch rather than from the limiter, and it means only that this gateway is
     * already running its allowed number of requests for the account. Nothing was sent, the provider
     * said nothing, and a sibling should not be billed for it — the honest answer is "the account is
     * busy", which is what the caller is told. Every other limiter refusal steps aside to the next route.
     */
    const details = isProviderError(input.error) ? input.error.details as { concurrencyLimited?: unknown } | undefined : undefined;
    if (details?.concurrencyLimited === true) return 'stop';

    /**
     * A **restriction** stops the walk, and it is checked ahead of the allowance rule.
     *
     * Reported from the field: CodeBuddy answered `403` `11140 request illegal` / "Your account has been
     * restricted due to unusual activity". The old behaviour treated a `403` as "the allowance is gone" and
     * moved to the sibling account — with the same IDE fingerprint, from the same address, one request
     * later. That is the shape the provider flags, so rotating deepens the problem it is complaining about
     * instead of routing around it.
     */
    if (isProviderError(input.error) && saysAccountRestricted(providerWordingOf(input.error))) return 'stop';

    /**
     * A refusal about the **account's allowance** hands off, before anything is retried.
     *
     * Checked ahead of `isRetryableFailure` because it answers a different question. A `400` carrying
     * `insufficient_quota` is not worth retrying on this account — it will refuse again — but it is a
     * reason to spend the *next* account. The old order asked only "is this retryable?", saw a 400,
     * and stopped, so a provider that reports an exhausted plan as a 400 or 422 left every sibling
     * account unused and the caller with a failure a healthy account would have answered.
     *
     * This is the reference implementation's rule (its `ERROR_RULES` match text before status), and
     * the exclusion set its chat loop keeps: an account that has said no is not asked again in this
     * request.
     */
    if (shouldRotateAccount(input.error)) return 'next-route';

    // Permanent by construction: the request or the model is wrong, and the next connection
    // will refuse it identically. Spending an upstream request to confirm that is the cost this
    // avoids.
    if (!isRetryableFailure(input.error)) return 'stop';

    // Nothing left to give this connection.
    if (input.attemptsOnThisRoute >= input.candidate.resilience.maxRetries + 1) return 'next-route';
    return input.canRetry ? 'retry' : 'next-route';
  }
}
