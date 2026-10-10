import { ProviderError, type ChatChunk, type ChatRequest, type ChatResponse, type EmbeddingRequest, type EmbeddingResponse } from '@hilbras/omnihilbras';
import { noCandidateMessage, type RouteCandidate, type RouteDecision } from './routing.js';
import { RetryPolicy } from './retry-policy.js';
import { HedgePolicy } from './hedge-policy.js';
import type { RequestScope } from './request-context.js';

/**
 * Trying routes until one answers.
 *
 * Extracted from `GatewayService`, which held the whole chain — hedge, retry, failover, attempt
 * ledger — in three private methods interleaved with the concerns that *perform* each attempt. The
 * loop and the effects were impossible to tell apart, so neither could be tested on its own.
 *
 * The split is: **this file owns the order, the ledger, and the counting. The caller owns every
 * effect.** Sending a request, applying a deadline, enforcing a rate limit, and recording an
 * outcome are all injected operations. That is why the dependency list below is eight functions
 * rather than one service: passing the service would have made the extraction cosmetic while
 * looking identical in a diff.
 *
 * ## What deliberately did not move
 *
 * Retry, hedge, timeout and rate-limit *policies* are still the caller's. Each one is a configured
 * value read off a candidate (`candidate.resilience.*`), and each has a policy file waiting for it
 * in the next phase. Pulling the policies in here now would have meant moving configuration
 * reading as well, and this file would have stopped being about the loop.
 *
 * ## The ledger is the contract with the client
 *
 * Every attempt is recorded, including the hedges that lose and the attempts abandoned when a
 * faster route wins. A client that sees `attempts` is seeing what was actually paid for, and that
 * is the difference between "the gateway tried three providers" and "it cost three times".
 */

/** One attempt at one provider, whether it won, failed, or was abandoned. */
export type GatewayFailoverAttempt = {
  providerId: string;
  /**
   * Which connection served this attempt.
   *
   * Added for the usage store, which attributes a request per connection rather than per provider: one
   * provider with three saved connections is three separate budgets, three latencies and three things to fix.
   * It was already in scope at every push site, so this surfaces existing state rather than threading a new
   * value through the executor.
   */
  connectionId?: string;
  attempt: number;
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
};

export type GatewayChatOutcome = {
  response: ChatResponse;
  attempts: GatewayFailoverAttempt[];
};

/**
 * The embeddings outcome, shaped exactly like {@link GatewayChatOutcome}.
 *
 * `attempts` is here for the same reason it is on the chat outcome: a client that sees four attempts
 * knows four calls were paid for. An embeddings request that fails over four times is four billable
 * embeddings calls, and the operator is the one who needs to know.
 */
export type GatewayEmbedOutcome = {
  response: EmbeddingResponse;
  attempts: GatewayFailoverAttempt[];
};

export type GatewayStreamOutcome = {
  chunks: AsyncIterable<ChatChunk>;
  attempts: GatewayFailoverAttempt[];
};

/** Error codes that mean "this request can never succeed on this route". */
const terminalRouteCodes = new Set(['INVALID_REQUEST', 'AUTHENTICATION_FAILED', 'NOT_SUPPORTED', 'NOT_FOUND']);

/**
 * Everything the loop needs from the service, as named operations.
 *
 * Each is one thing, because a caller-supplied object with a dozen methods is a service in
 * disguise and would make the tests below a re-implementation of the service rather than a
 * description of the loop.
 */
export type RequestExecutorDeps = {
  /** Which providers could serve this model, in preference order. */
  planRoute: (model: string, explicitProviderId?: string) => Promise<RouteDecision>;
  /** Sends one request to one provider. */
  chat: (providerId: string, request: ChatRequest, signal?: AbortSignal, scope?: RequestScope) => Promise<ChatResponse>;
  /** Opens a stream with one provider. Only the first chunk is a failover decision point. */
  streamChat: (providerId: string, request: ChatRequest, signal?: AbortSignal, scope?: RequestScope) => AsyncIterable<ChatChunk>;
  /**
   * Embeds with one provider.
   *
   * A ninth injected operation rather than a second executor, and that is the whole decision.
   * `chat`/`stream` and `embed` share every rule this file owns — retry count, rate-limit accounting,
   * terminal codes, the attempt ledger, and the three fixes that each took a release of its own:
   * a limiter refusal is not a provider failure (1.56.0), a cancellation is neither success nor
   * failure (1.52.0), and an abandoned hedge may not settle twice (1.53.0). A separate embeddings loop
   * would have had to re-derive all six, and would have been correct until someone changed one of them
   * here only.
   */
  embed: (providerId: string, request: EmbeddingRequest, signal?: AbortSignal, scope?: RequestScope) => Promise<EmbeddingResponse>;
  /** Applies a per-attempt deadline and never leaks its timer. */
  withDeadline: <T>(signal: AbortSignal | undefined, timeoutMs: number, providerId: string, run: (signal: AbortSignal | undefined) => Promise<T>) => Promise<T>;
  /** Refuses an attempt that would exceed the connection's per-minute limit. */
  enforceRateLimit: (candidate: RouteCandidate) => void;
  recordSuccess: (providerId: string, latencyMs: number, at: string) => void;
  recordFailure: (providerId: string, code: string, reason: string) => void;
  /** Credits a connection for a request that was actually sent. */
  recordRateLimitUse: (connectionId: string) => void;
};

export class RequestExecutor {
  /**
   * One decision, consulted by every path a request can fail on.
   *
   * It was inline at two of them and had already diverged — see `RetryPolicy` for the measurement.
   * A third copy inside this file would have been the fourth.
   */
  private readonly retryPolicy = new RetryPolicy();

  /** Whether a second request is worth sending, and which route. The *why* lives in the policy. */
  private readonly hedges = new HedgePolicy();

  constructor(private readonly deps: RequestExecutorDeps) {}

  async chat(request: ChatRequest, explicitProviderId: string | undefined, signal?: AbortSignal, scope?: RequestScope): Promise<GatewayChatOutcome> {
    const decision = await this.deps.planRoute(request.model, explicitProviderId);
    if (decision.candidates.length === 0) throw noRouteAvailable(decision.skipped);
    const attempts: GatewayFailoverAttempt[] = [];
    const race = await this.tryHedgedRace(decision.candidates, request, signal, scope);
    if (race) {
      attempts.push(...race.attempts);
      if (race.response) return { response: race.response, attempts };
      // The race found no winner; continue down the normal chain.
    }
    const racedProviders = new Set(race?.attempts.filter((attempt) => !attempt.ok).map((attempt) => attempt.providerId));
    return this.runSequential({
      candidates: decision.candidates,
      attempts,
      racedProviders,
      lastError: race?.lastError,
      signal,
      scope,
      dispatch: (candidate, deadline) => this.deps.chat(candidate.providerId, request, deadline, scope),
    });
  }

  /**
   * Embeds, walking the same route chain and obeying the same rules as {@link chat}.
   *
   * **Deliberately not a second loop.** The three fixes below each cost a release to find, and every
   * one of them is a property of *dispatching an attempt* rather than of chat specifically — so a
   * copied loop would have been correct on day one and quietly wrong the first time any of them was
   * changed here only:
   *
   * - a limiter refusal is not a provider failure (1.56.0) — nothing was sent, so nothing was learned;
   * - a cancellation is neither success nor failure (1.52.0) — a client that closes its request did
   *   not make the provider slow;
   * - `terminalRouteCodes` decides what is worth retrying, and it already lists `NOT_SUPPORTED` and
   *   `INVALID_REQUEST` — which is precisely what a provider with no embeddings endpoint returns.
   *
   * The one thing that is genuinely chat-only is **hedging**, and it is not merely omitted: a hedge
   * fires a second request after a delay to reach the fastest provider, and an embeddings request
   * that has already been computed by two providers has doubled the bill for a latency win nobody
   * asked for. So `tryHedgedRace` is not called here, and the loop below is the whole of the policy.
   * That is a decision recorded in code, not an oversight for a reader to infer.
   */
  async embed(request: EmbeddingRequest, explicitProviderId: string | undefined, signal?: AbortSignal, scope?: RequestScope): Promise<GatewayEmbedOutcome> {
    const decision = await this.deps.planRoute(request.model, explicitProviderId);
    if (decision.candidates.length === 0) throw noRouteAvailable(decision.skipped);
    return this.runSequential({
      candidates: decision.candidates,
      attempts: [],
      racedProviders: new Set(),
      lastError: undefined,
      signal,
      scope,
      dispatch: (candidate, deadline) => this.deps.embed(candidate.providerId, request, deadline, scope),
    });
  }

  /**
   * The route chain, walked one candidate at a time, with every rule this file owns applied once.
   *
   * Extracted from `chat` rather than written twice. The duplication would have been ~85 lines
   * carrying six behaviours that all had to stay in step — retry counting, the limiter-before-dispatch
   * ordering, per-attempt accounting, the ledger shape, `attachAttempts`, and the two health verdicts
   * that `abandoned`/`aborted` distinguish. Six rules that must not drift is six chances to drift, and
   * the drift is invisible until a provider is ejected for something nobody did.
   *
   * Generic over the response type so embeddings and chat share it rather than the file holding a
   * near-identical copy that only the type parameter separates.
   */
  private async runSequential<T>(input: {
    candidates: readonly RouteCandidate[];
    attempts: GatewayFailoverAttempt[];
    /** Candidates a hedge already tried and failed; walked past rather than paid for twice. */
    racedProviders: ReadonlySet<string>;
    lastError: unknown;
    signal?: AbortSignal;
    scope?: RequestScope;
    dispatch: (candidate: RouteCandidate, deadline: AbortSignal | undefined) => Promise<T>;
  }): Promise<{ response: T; attempts: GatewayFailoverAttempt[] }> {
    // `scope` is deliberately not destructured: the dispatch closure already captures it, and
    // reading an unused binding here is what `noUnusedLocals` caught when this loop was extracted.
    const { candidates, attempts, racedProviders, signal } = input;
    let lastError: unknown = input.lastError;

    for (const candidate of candidates) {
      if (racedProviders.has(candidate.providerId)) continue;
      for (let attempt = 1; attempt <= candidate.resilience.maxRetries + 1; attempt += 1) {
        if (signal?.aborted) throw new ProviderError('CANCELLED', 'The request was cancelled.', { cause: signal.reason });
        const startedAt = Date.now();
        // **A refusal by the limiter is not a provider failure** (1.56.0).
        //
        // `enforceRateLimit` throwing is checked outside the dispatch `try`, so it could not reach the
        // provider's own error handling — and that was the point of it: nothing has been sent, so
        // nothing was spent and there is nothing to learn about the provider. Measured with the limiter
        // refusing the only candidate:
        //
        // ```
        // client saw      : PROVIDER_REQUEST_FAILED
        // provider calls  : 0   enforce calls: 1
        // recordFailure   : ["p:PROVIDER_REQUEST_FAILED"]
        // ```
        //
        // So a provider that was **never contacted** was recorded as having failed, and the client got a
        // 502 telling it to retry — against a connection that is at its RPM ceiling. This is the same
        // class as the cancellation fix in 1.52.0 and the abandoned-hedge fix in 1.53.0: a health counter
        // recording something that did not happen.
        //
        // Two requests raced against a limit of 1 showed both halves at once — the loser of the race is
        // the one refused here:
        //
        // ```
        // A: HTTP 502  code=PROVIDER_REQUEST_FAILED
        // B: HTTP 429  code=RATE_LIMITED
        // ```
        //
        // `RetryPolicy` already stops on `RATE_LIMITED`, so nothing was retried; the ledger entry and the
        // status code were the whole of it. Throwing a `ProviderError` rather than the limiter's own error
        // means the code survives to `statusForError`, which maps `RATE_LIMITED` to 429.
        try {
          this.deps.enforceRateLimit(candidate);
        } catch (error) {
          const code = error instanceof ProviderError ? error.code : 'RATE_LIMITED';
          attempts.push({ providerId: candidate.providerId, connectionId: candidate.connectionId, attempt, ok: false, latencyMs: 0, errorCode: code });
          throw new ProviderError(
            code,
            `The connection is at its rate limit.${code === 'RATE_LIMITED' ? '' : ''}`,
            { retryable: false, publicMessage: 'This connection is at its rate limit. Wait for the window to reset.', cause: error },
          );
        }
        try {
          // Counted here, at dispatch, rather than on success: a request that was sent and then
          // failed still cost the provider a call. A request the limit *refused* is not counted,
          // because nothing was sent.
          this.deps.recordRateLimitUse(candidate.connectionId);
          const response = await this.deps.withDeadline(signal, candidate.resilience.timeoutMs, candidate.providerId, (deadline) => input.dispatch(candidate, deadline));
          const latencyMs = Date.now() - startedAt;
          this.deps.recordSuccess(candidate.providerId, latencyMs, new Date().toISOString());
          attempts.push({ providerId: candidate.providerId, connectionId: candidate.connectionId, attempt, ok: true, latencyMs });
          return { response, attempts };
        } catch (error) {
          const latencyMs = Date.now() - startedAt;
          const code = error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED';
          this.deps.recordFailure(candidate.providerId, code, error instanceof Error ? error.message : 'The provider request failed.');
          attempts.push({ providerId: candidate.providerId, connectionId: candidate.connectionId, attempt, ok: false, latencyMs, errorCode: code });
          lastError = error;
          const action = this.retryPolicy.afterFailure({
            error,
            candidate,
            attemptsOnThisRoute: attempt,
            aborted: Boolean(signal?.aborted),
            canRetry: true,
          });
          if (action === 'stop') throw attachAttempts(error, attempts);
          if (action === 'next-route') break;
        }
      }
    }
    throw attachAttempts(lastError, attempts);
  }

  /**
   * Races the leading candidates when a hedge delay is configured. The first
   * successful reply wins and the losers are aborted, so the client waits for
   * the fastest route instead of the first-priority one. A hedge is only sent
   * while the leader is still in flight and another candidate can serve the
   * model, so a single connection never pays the extra cost.
   */
  private async tryHedgedRace(candidates: RouteCandidate[], request: ChatRequest, signal: AbortSignal | undefined, scope?: RequestScope) {
    const plan = this.hedges.planFor(candidates);
    if (!plan.enabled || !plan.leader) return undefined;
    const leader = plan.leader;

    type Outcome = { candidate: RouteCandidate; ok: boolean; latencyMs: number; response?: ChatResponse; error?: unknown };
    const attempts: GatewayFailoverAttempt[] = [];
    const inflight: Array<{ candidate: RouteCandidate; abort: () => void; done: Promise<Outcome>; startedAt: number }> = [];
    const settled = new Set<Promise<Outcome>>();
    const started = new Set<RouteCandidate>();
    /** Attempts the winner abandoned: still paid for, but no longer ours to judge. */
    const abandoned = new Set<RouteCandidate>();
    let winner: Outcome | undefined;
    let lastError: unknown;
    let onChange: () => void = () => undefined;
    const resetChange = () => new Promise<void>((resolve) => { onChange = resolve; });

    const start = (candidate: RouteCandidate) => {
      started.add(candidate);
      const controller = new AbortController();
      const startedAt = Date.now();
      // Enforced, then accounted for — the same order as the sequential path, for the same reason.
      //
      // This call was **missing** (1.52.0). The hedge recorded a use but never asked whether the
      // connection had capacity, so a connection sitting at its RPM ceiling accepted hedges without
      // bound: it spent budget it was not counting. Measured with
      // `enforceRateLimit` called 0 times inside `tryHedgedRace` while `recordRateLimitUse` was called
      // once, and the same file's sequential path calling both.
      //
      // A hedge that is refused must not become a failure of the *request* either — the leader may still
      // answer — so the refusal is recorded as this attempt failing and the race continues.
      try {
        this.deps.enforceRateLimit(candidate);
      } catch (error) {
        attempts.push({
          providerId: candidate.providerId,
          attempt: 1,
          ok: false,
          latencyMs: 0,
          errorCode: error instanceof ProviderError ? error.code : 'RATE_LIMITED',
        });
        return;
      }
      // Counted here for the same reason as the sequential path: a hedge that loses was still sent
      // and still cost money, and the ledger records it as such.
      this.deps.recordRateLimitUse(candidate.connectionId);
      const done = this.deps.withDeadline(signal, candidate.resilience.timeoutMs, candidate.providerId, (deadline) => this.deps.chat(candidate.providerId, request, deadline, scope))
        .then(
          (response): Outcome => ({ candidate, ok: true, latencyMs: Date.now() - startedAt, response }),
          (error: unknown): Outcome => ({ candidate, ok: false, latencyMs: Date.now() - startedAt, error }),
        )
        .then((outcome) => {
          settled.add(done);
          const code = outcome.ok ? undefined : outcome.error instanceof ProviderError ? outcome.error.code : 'PROVIDER_REQUEST_FAILED';
          // **An attempt that was already abandoned must not record health again.**
          //
          // When a winner is chosen the losers are aborted and recorded `CANCELLED`. A provider that does
          // not stop on the abort then settles normally, and this handler — which runs for *every*
          // outcome — recorded a success or failure for an attempt the ledger had already closed. Measured:
          // a hedge recorded `CANCELLED` and then `recordSuccess`, so a connection the gateway had stopped
          // paying for still moved its health.
          //
          // The ledger was already correct in this case, which is why the duplicate was invisible there:
          // the winner branch checks `!settled.has(other.done)` and this push happens after the method has
          // returned. So the bug was never in the outcome — it was in the provider's health.
          //
          // `abandoned` is what the winner branch sets, and it means "we stopped paying for this". The
          // attempt still cost money, so `recordRateLimitUse` stays where it is; only the *health* verdict
          // belongs to the request we are no longer waiting on.
          if (abandoned.has(candidate)) return outcome;
          if (outcome.ok) {
            this.deps.recordSuccess(candidate.providerId, outcome.latencyMs, new Date().toISOString());
          } else {
            this.deps.recordFailure(candidate.providerId, code ?? 'PROVIDER_REQUEST_FAILED', outcome.error instanceof Error ? outcome.error.message : 'The provider request failed.');
          }
          attempts.push({ providerId: candidate.providerId, connectionId: candidate.connectionId, attempt: 1, ok: outcome.ok, latencyMs: outcome.latencyMs, ...(code ? { errorCode: code } : {}) });
          if (outcome.ok) {
            if (!winner) {
              winner = outcome;
              // A faster route answered: stop paying for the others. The
              // abandoned attempts are recorded now so the client can see that
              // a hedge was fired and won.
              for (const other of inflight) {
                if (other.candidate === candidate) continue;
                abandoned.add(other.candidate);
                other.abort();
                if (!settled.has(other.done)) {
                  attempts.push({ providerId: other.candidate.providerId, connectionId: other.candidate.connectionId, attempt: 1, ok: false, latencyMs: Date.now() - other.startedAt, errorCode: 'CANCELLED' });
                }
              }
            }
          } else {
            lastError = outcome.error;
          }
          onChange();
          return outcome;
        });
      inflight.push({ candidate, done, startedAt, abort: () => controller.abort(new ProviderError('CANCELLED', 'A faster provider answered this request.')) });
      return done;
    };

    start(leader);
    let hedgePending = true;
    const hedgeTimer = setInterval(() => {
      const decision = this.hedges.nextHedge({ plan, started, settledCount: settled.size, hasWinner: Boolean(winner), aborted: Boolean(signal?.aborted) });
      if (!decision.hedge) {
        // The reason is deliberately not recorded anywhere: there is nowhere in the outcome to put
        // it without changing the public shape, and a variable written and never read is worse than
        // no variable. It is the policy's to answer, and the tests below ask it directly — which is
        // the part that matters, because a decision that decides how many paid requests a gateway
        // makes should be assertable rather than discoverable by reading a timer callback.
        clearInterval(hedgeTimer);
        hedgePending = false;
        // The loop is parked on `resetChange()`. Without this wake-up, a leader that failed before the timer
        // fired leaves the loop waiting on a change that will never come, and the request never answers.
        onChange();
        return;
      }
      start(decision.candidate);
      onChange();
    }, plan.delayMs);
    hedgeTimer.unref?.();

    // Wait for the first success, or until every candidate has been tried.
    while (!winner) {
      const running = inflight.filter((handle) => !settled.has(handle.done));
      if (running.length === 0) {
        if (hedgePending) {
          // The hedge timer decides whether another candidate is worth starting.
          await resetChange();
          continue;
        }
        break;
      }
      await resetChange();
    }
    clearInterval(hedgeTimer);
    if (winner) {
      // Return immediately: the losers were aborted and their own bookkeeping
      // continues in the background. Waiting for them would reintroduce the
      // leader's latency, which is exactly what hedging exists to avoid.
      return { response: winner.response!, attempts, lastError };
    }
    await Promise.allSettled(inflight.map((handle) => handle.done));
    return attempts.length === 0 ? undefined : { response: undefined, attempts, lastError };
  }

  /** Streaming cannot retry after bytes are sent, so failover only covers the first chunk. */
  async stream(request: ChatRequest, explicitProviderId: string | undefined, signal?: AbortSignal, scope?: RequestScope): Promise<GatewayStreamOutcome> {
    const decision = await this.deps.planRoute(request.model, explicitProviderId);
    if (decision.candidates.length === 0) throw noRouteAvailable(decision.skipped);
    const attempts: GatewayFailoverAttempt[] = [];
    let lastError: unknown;

    for (const candidate of decision.candidates) {
      const startedAt = Date.now();
      let opening: ChatChunk | undefined;
      let rest: AsyncIterator<ChatChunk> | undefined;
      // Same rule as the chat path (1.56.0), and found by enumerating every `enforceRateLimit` call site
      // rather than by reasoning about it. Measured here with the limiter refusing the only candidate:
      //
      //   client saw      : PROVIDER_REQUEST_FAILED
      //   stream calls    : 0
      //   recordFailure   : ["p:PROVIDER_REQUEST_FAILED"]
      //
      // The provider was never contacted. Streaming is where this matters most: a client that asked for a
      // stream and is told "the provider failed" will go and debug a provider that is working perfectly.
      try {
        this.deps.enforceRateLimit(candidate);
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'RATE_LIMITED';
        attempts.push({ providerId: candidate.providerId, connectionId: candidate.connectionId, attempt: 1, ok: false, latencyMs: Date.now() - startedAt, errorCode: code });
        throw new ProviderError(code, 'This connection is at its rate limit.', {
          retryable: false,
          publicMessage: 'This connection is at its rate limit. Wait for the window to reset.',
          cause: error,
        });
      }
      try {
        this.deps.recordRateLimitUse(candidate.connectionId);
        const opened = await this.deps.withDeadline(signal, candidate.resilience.timeoutMs, candidate.providerId, async (deadline) => {
          const source = this.deps.streamChat(candidate.providerId, request, deadline, scope)[Symbol.asyncIterator]();
          const first = await source.next();
          if (first.done) throw new ProviderError('INVALID_RESPONSE', 'The provider stream ended before producing a chunk.');
          // The deadline has passed; the rest of the stream continues without it.
          const remainder = (async function* (): AsyncGenerator<ChatChunk> {
            while (true) {
              const next = await source.next();
              if (next.done) return;
              yield next.value;
            }
          })();
          return { first: first.value, remainder };
        });
        opening = opened.first;
        rest = opened.remainder[Symbol.asyncIterator]();
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED';
        this.deps.recordFailure(candidate.providerId, code, error instanceof Error ? error.message : 'The provider stream failed.');
        attempts.push({ providerId: candidate.providerId, connectionId: candidate.connectionId, attempt: 1, ok: false, latencyMs: Date.now() - startedAt, errorCode: code });
        lastError = error;
        // `canRetry: false`, because a stream walks the route chain once: once the first chunk has
        // not been sent there is still a chain to walk, and once it has, the client already holds a
        // partial answer a second provider would not match. The policy is asked anyway rather than
        // trusting that this loop happens to be the shape that needs no answer.
        //
        // `stop` leaves the loop and reports; anything else walks to the next connection, which is
        // what `continue` does here and what the old inline check was doing with its two branches.
        const action = this.retryPolicy.afterFailure({ error, candidate, attemptsOnThisRoute: 1, aborted: Boolean(signal?.aborted), canRetry: false });
        if (action === 'stop') break;
        continue;
      }
      attempts.push({ providerId: candidate.providerId, connectionId: candidate.connectionId, attempt: 1, ok: true, latencyMs: Date.now() - startedAt });
      const settled = opening;
      return {
        attempts,
        chunks: (async function* (executor: RequestExecutor) {
          if (settled) yield settled;
          // Recorded on the way **out**, but only on the way out *successfully*.
          //
          // This was a `finally` block, so `recordSuccess` also ran when the stream threw — a provider
          // that emitted one chunk and then died was recorded healthy, and routing kept selecting it. The
          // comment above it already described the correct behaviour, which is how a wrong line survives
          // review: the sentence explains why the line is right, and the line is not.
          //
          // A client that disconnects aborts the iterator and raises here like any other throw, so this
          // `catch` cannot tell a provider failure from a cancellation by shape alone — the abort check
          // below is what separates them. Cancelling a request is the user's decision and must not count
          // against the provider.
          try {
            while (true) {
              const next = await rest!.next();
              // `done` is the only path that is not a throw, so it is the only path that is a success.
              // Recording here rather than after the loop is deliberate: a `return` inside the loop
              // skips whatever follows it, which is exactly why my first attempt at this fix — an
              // `if (completed)` *after* the loop — was dead code, and the test that guards it said so.
              if (next.done) {
                executor.deps.recordSuccess(candidate.providerId, Date.now() - startedAt, new Date().toISOString());
                return;
              }
              yield next.value;
            }
          } catch (error) {
            // The stream died mid-answer. That is the provider's fault whatever the client did next, and
            // a health counter that cannot see it keeps sending traffic to a provider that is failing
            // mid-answer.
            // A cancellation is not a provider failure. The client's own abort reaches here shaped like
            // any other throw, so the signal — not the error — is what separates "the provider died" from
            // "the user closed the tab", and counting the second against the first would let any client
            // poison a provider's health. That is the same defect as recording the failure as a success,
            // pointed the other way.
            const cancelled = signal?.aborted === true;
            if (cancelled) throw error;
            const code = error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED';
            executor.deps.recordFailure(
              candidate.providerId,
              code,
              error instanceof Error ? error.message : 'The provider stream failed after it started.',
            );
            attempts.push({
              providerId: candidate.providerId,
              attempt: 1,
              ok: false,
              latencyMs: Date.now() - startedAt,
              errorCode: code,
            });
            throw error;
          }
        })(this),
      };
    }
    throw attachAttempts(lastError, attempts);
  }
}

/**
 * The error for a request with nowhere to go, and it is the *reason* that decides the code.
 *
 * ## Why the reason matters (1.54.0)
 *
 * Every skipped connection being rate-limited is not "the provider is unavailable" — it is "you asked
 * too fast". The two need opposite client behaviour: one is worth retrying elsewhere, the other is worth
 * backing off from and reporting as `429`. Measured with a limit of 1:
 *
 * ```
 * req 1: HTTP 200
 * req 2: HTTP 502  code=PROVIDER_UNAVAILABLE  retryable=true
 * ```
 *
 * So a client obeying `retryable: true` retried a connection that was at its RPM ceiling, and got a 502
 * where the standard answer is 429. `statusForError` already maps `RATE_LIMITED` to 429; this never
 * reached it, because the connection was skipped during planning and no rate-limit error was ever
 * thrown.
 *
 * The rule: **when every skipped connection is rate-limited, say so.** A mix still reports
 * `PROVIDER_UNAVAILABLE`, because then something other than a limit is also wrong and one code cannot
 * describe both.
 */
function noRouteAvailable(skipped: Array<{ providerId: string; reason: string }>) {
  const detail = skipped.length > 0 ? ` Skipped: ${skipped.map((entry) => `${entry.providerId} (${entry.reason})`).join(', ')}.` : '';
  const allRateLimited = skipped.length > 0 && skipped.every((entry) => entry.reason === 'rate-limited');
  if (allRateLimited) {
    return new ProviderError(
      'RATE_LIMITED',
      `Every connection for this model is at its rate limit.${detail}`,
      // Not retryable: retrying immediately is exactly what produced the refusal. The limit resets on its
      // own window, and `GET /v1/routing` reports `rateLimitWaitMs` so a caller can wait the right amount.
      { retryable: false, publicMessage: `Every connection for this model is at its rate limit.${detail}` },
    );
  }
  return new ProviderError('PROVIDER_UNAVAILABLE', `${noCandidateMessage}${detail}`, { retryable: true, publicMessage: `${noCandidateMessage}${detail}` });
}

/**
 * Wraps a failure with the ledger of what was tried.
 *
 * **The ledger travels in `details.attempts`** (1.60.0). It used to travel nowhere: this function rebuilt
 * the error to carry a better message and dropped the attempt list on the floor, so a caller that had
 * already received it — the usage recorder, for one — could not know which provider failed or that any
 * provider was tried at all. Measured on a single-connection gateway whose provider throws:
 *
 * ```
 * error.code   : PROVIDER_REQUEST_FAILED
 * has .attempts: false
 * own keys     : [ 'code', 'providerId', 'statusCode', 'retryable', 'name' ]
 * ```
 *
 * So a failure produced **no usage record at all**, because the recorder correctly refused to attribute a
 * request to a provider it could not identify. The honest reading of that is that the ledger should have
 * been there to read.
 *
 * `details` rather than a new own-property, because every branch below constructs a fresh `ProviderError`
 * and a bespoke property would have to be threaded through each one — which is the mechanism by which two
 * branches come to disagree.
 */
function attachAttempts(error: unknown, attempts: GatewayFailoverAttempt[]) {
  const failedProviders = [...new Set(attempts.filter((attempt) => !attempt.ok).map((attempt) => attempt.providerId))];
  const ledger = { attempts };
  if (error instanceof ProviderError) {
    // A single route keeps the adapter's own redacted public message, so existing
    // error semantics do not change when failover never engaged.
    if (failedProviders.length <= 1) {
      const suffix = failedProviders.length === 1 ? ` Tried: ${failedProviders[0]}.` : '';
      return new ProviderError(error.code, `${error.message}${suffix}`, {
        ...(error.providerId ? { providerId: error.providerId } : {}),
        ...(error.statusCode ? { statusCode: error.statusCode } : {}),
        retryable: error.retryable,
        ...(error.publicMessage ? { publicMessage: `${error.publicMessage}${suffix}` } : {}),
        // Carried through: without this the provider's own wording is lost the
        // moment a request passes through the failover path, and the operator is
        // left with a generic refusal and no cause.
        details: { ...(typeof error.details === 'object' && error.details !== null ? error.details : {}), ...ledger },
        cause: error,
      });
    }
    if (terminalRouteCodes.has(error.code)) {
      return new ProviderError(error.code, `${error.message} Tried: ${failedProviders.join(', ')}.`, {
        ...(error.providerId ? { providerId: error.providerId } : {}),
        ...(error.statusCode ? { statusCode: error.statusCode } : {}),
        retryable: error.retryable,
        details: { ...(typeof error.details === 'object' && error.details !== null ? error.details : {}), ...ledger },
        cause: error,
      });
    }
    const message = `Every provider route failed. Tried: ${failedProviders.join(', ')}.`;
    return new ProviderError('PROVIDER_UNAVAILABLE', message, { retryable: true, publicMessage: message, details: ledger, cause: error });
  }
  const message = `Every provider route failed.${failedProviders.length > 0 ? ` Tried: ${failedProviders.join(', ')}.` : ''}`;
  return new ProviderError('PROVIDER_REQUEST_FAILED', message, { retryable: true, publicMessage: message, details: ledger, cause: error });
}
