import { ProviderError, type ChatChunk, type ChatRequest, type ChatResponse } from '@hilbras/omnihilbras';
import { isRetryableFailure, noCandidateMessage, type RouteCandidate, type RouteDecision } from './routing.js';

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
  attempt: number;
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
};

export type GatewayChatOutcome = {
  response: ChatResponse;
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
  chat: (providerId: string, request: ChatRequest, signal?: AbortSignal) => Promise<ChatResponse>;
  /** Opens a stream with one provider. Only the first chunk is a failover decision point. */
  streamChat: (providerId: string, request: ChatRequest, signal?: AbortSignal) => AsyncIterable<ChatChunk>;
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
  constructor(private readonly deps: RequestExecutorDeps) {}

  async chat(request: ChatRequest, explicitProviderId: string | undefined, signal?: AbortSignal): Promise<GatewayChatOutcome> {
    const decision = await this.deps.planRoute(request.model, explicitProviderId);
    if (decision.candidates.length === 0) throw noRouteAvailable(decision.skipped);
    const attempts: GatewayFailoverAttempt[] = [];
    const race = await this.tryHedgedRace(decision.candidates, request, signal);
    if (race) {
      attempts.push(...race.attempts);
      if (race.response) return { response: race.response, attempts };
      // The race found no winner; continue down the normal chain.
    }
    const racedProviders = new Set(race?.attempts.filter((attempt) => !attempt.ok).map((attempt) => attempt.providerId));
    let lastError: unknown = race?.lastError;

    for (const candidate of decision.candidates) {
      if (racedProviders.has(candidate.providerId)) continue;
      for (let attempt = 1; attempt <= candidate.resilience.maxRetries + 1; attempt += 1) {
        if (signal?.aborted) throw new ProviderError('CANCELLED', 'The request was cancelled.', { cause: signal.reason });
        const startedAt = Date.now();
        try {
          this.deps.enforceRateLimit(candidate);
          const response = await this.deps.withDeadline(signal, candidate.resilience.timeoutMs, candidate.providerId, (deadline) => this.deps.chat(candidate.providerId, request, deadline));
          const latencyMs = Date.now() - startedAt;
          this.deps.recordSuccess(candidate.providerId, latencyMs, new Date().toISOString());
          this.deps.recordRateLimitUse(candidate.connectionId);
          attempts.push({ providerId: candidate.providerId, attempt, ok: true, latencyMs });
          return { response, attempts };
        } catch (error) {
          const latencyMs = Date.now() - startedAt;
          const code = error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED';
          this.deps.recordFailure(candidate.providerId, code, error instanceof Error ? error.message : 'The provider request failed.');
          attempts.push({ providerId: candidate.providerId, attempt, ok: false, latencyMs, errorCode: code });
          // A per-connection limit should hand off to the next route, not retry here.
          if (error instanceof ProviderError && error.code === 'RATE_LIMITED' && attempts.length > 1) break;
          if (!isRetryableFailure(error)) throw attachAttempts(error, attempts);
          lastError = error;
          if (signal?.aborted) break;
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
  private async tryHedgedRace(candidates: RouteCandidate[], request: ChatRequest, signal: AbortSignal | undefined) {
    const [leader, ...rest] = candidates;
    if (!leader || rest.length === 0 || leader.resilience.hedgeAfterMs <= 0) return undefined;

    type Outcome = { candidate: RouteCandidate; ok: boolean; latencyMs: number; response?: ChatResponse; error?: unknown };
    const attempts: GatewayFailoverAttempt[] = [];
    const inflight: Array<{ candidate: RouteCandidate; abort: () => void; done: Promise<Outcome>; startedAt: number }> = [];
    const settled = new Set<Promise<Outcome>>();
    const started = new Set<RouteCandidate>();
    let winner: Outcome | undefined;
    let lastError: unknown;
    let onChange: () => void = () => undefined;
    const resetChange = () => new Promise<void>((resolve) => { onChange = resolve; });

    const start = (candidate: RouteCandidate) => {
      started.add(candidate);
      const controller = new AbortController();
      const startedAt = Date.now();
      const done = this.deps.withDeadline(signal, candidate.resilience.timeoutMs, candidate.providerId, (deadline) => this.deps.chat(candidate.providerId, request, deadline))
        .then(
          (response): Outcome => ({ candidate, ok: true, latencyMs: Date.now() - startedAt, response }),
          (error: unknown): Outcome => ({ candidate, ok: false, latencyMs: Date.now() - startedAt, error }),
        )
        .then((outcome) => {
          settled.add(done);
          const code = outcome.ok ? undefined : outcome.error instanceof ProviderError ? outcome.error.code : 'PROVIDER_REQUEST_FAILED';
          if (outcome.ok) {
            this.deps.recordSuccess(candidate.providerId, outcome.latencyMs, new Date().toISOString());
            this.deps.recordRateLimitUse(candidate.connectionId);
          } else {
            this.deps.recordFailure(candidate.providerId, code ?? 'PROVIDER_REQUEST_FAILED', outcome.error instanceof Error ? outcome.error.message : 'The provider request failed.');
          }
          attempts.push({ providerId: candidate.providerId, attempt: 1, ok: outcome.ok, latencyMs: outcome.latencyMs, ...(code ? { errorCode: code } : {}) });
          if (outcome.ok) {
            if (!winner) {
              winner = outcome;
              // A faster route answered: stop paying for the others. The
              // abandoned attempts are recorded now so the client can see that
              // a hedge was fired and won.
              for (const other of inflight) {
                if (other.candidate === candidate) continue;
                other.abort();
                if (!settled.has(other.done)) {
                  attempts.push({ providerId: other.candidate.providerId, attempt: 1, ok: false, latencyMs: Date.now() - other.startedAt, errorCode: 'CANCELLED' });
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
      if (winner || signal?.aborted) {
        clearInterval(hedgeTimer);
        hedgePending = false;
        return;
      }
      // Only hedge while the leader is still in flight.
      if (settled.size > 0) {
        clearInterval(hedgeTimer);
        hedgePending = false;
        return;
      }
      const next = rest.find((candidate) => !started.has(candidate));
      if (next) {
        start(next);
        onChange();
      } else {
        clearInterval(hedgeTimer);
        hedgePending = false;
      }
    }, leader.resilience.hedgeAfterMs);
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
  async stream(request: ChatRequest, explicitProviderId: string | undefined, signal?: AbortSignal): Promise<GatewayStreamOutcome> {
    const decision = await this.deps.planRoute(request.model, explicitProviderId);
    if (decision.candidates.length === 0) throw noRouteAvailable(decision.skipped);
    const attempts: GatewayFailoverAttempt[] = [];
    let lastError: unknown;

    for (const candidate of decision.candidates) {
      const startedAt = Date.now();
      let opening: ChatChunk | undefined;
      let rest: AsyncIterator<ChatChunk> | undefined;
      try {
        this.deps.enforceRateLimit(candidate);
        const opened = await this.deps.withDeadline(signal, candidate.resilience.timeoutMs, candidate.providerId, async (deadline) => {
          const source = this.deps.streamChat(candidate.providerId, request, deadline)[Symbol.asyncIterator]();
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
        attempts.push({ providerId: candidate.providerId, attempt: 1, ok: false, latencyMs: Date.now() - startedAt, errorCode: code });
        lastError = error;
        if (!isRetryableFailure(error) || signal?.aborted) break;
        continue;
      }
      this.deps.recordRateLimitUse(candidate.connectionId);
      attempts.push({ providerId: candidate.providerId, attempt: 1, ok: true, latencyMs: Date.now() - startedAt });
      const settled = opening;
      return {
        attempts,
        chunks: (async function* (executor: RequestExecutor) {
          if (settled) yield settled;
          try {
            while (true) {
              const next = await rest!.next();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            // Recorded on the way out, not on the way in: a stream that opened and then died is a
            // failure the client already knows about, and a health counter that cannot see it
            // would keep sending traffic to a provider that is failing mid-answer.
            executor.deps.recordSuccess(candidate.providerId, Date.now() - startedAt, new Date().toISOString());
          }
        })(this),
      };
    }
    throw attachAttempts(lastError, attempts);
  }
}

function noRouteAvailable(skipped: Array<{ providerId: string; reason: string }>) {
  const detail = skipped.length > 0 ? ` Skipped: ${skipped.map((entry) => `${entry.providerId} (${entry.reason})`).join(', ')}.` : '';
  return new ProviderError('PROVIDER_UNAVAILABLE', `${noCandidateMessage}${detail}`, { retryable: true, publicMessage: `${noCandidateMessage}${detail}` });
}

function attachAttempts(error: unknown, attempts: GatewayFailoverAttempt[]) {
  const failedProviders = [...new Set(attempts.filter((attempt) => !attempt.ok).map((attempt) => attempt.providerId))];
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
        ...(error.details === undefined ? {} : { details: error.details }),
        cause: error,
      });
    }
    if (terminalRouteCodes.has(error.code)) {
      return new ProviderError(error.code, `${error.message} Tried: ${failedProviders.join(', ')}.`, {
        ...(error.providerId ? { providerId: error.providerId } : {}),
        ...(error.statusCode ? { statusCode: error.statusCode } : {}),
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
        cause: error,
      });
    }
    const message = `Every provider route failed. Tried: ${failedProviders.join(', ')}.`;
    return new ProviderError('PROVIDER_UNAVAILABLE', message, { retryable: true, publicMessage: message, cause: error });
  }
  const message = `Every provider route failed.${failedProviders.length > 0 ? ` Tried: ${failedProviders.join(', ')}.` : ''}`;
  return new ProviderError('PROVIDER_REQUEST_FAILED', message, { retryable: true, publicMessage: message, cause: error });
}
