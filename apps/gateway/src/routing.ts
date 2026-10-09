import { ProviderError } from '@hilbras/omnihilbras';
import type { ConnectionRecord, ResilienceSettings } from './connections.js';

/** Why a candidate was skipped, so the gateway can explain the decision. */
export type RouteSkipReason = 'disabled' | 'no-credential' | 'unhealthy' | 'rate-limited' | 'no-models';

export type RouteCandidate = {
  providerId: string;
  connectionId: string;
  priority: number;
  resilience: ResilienceSettings;
};

export type RouteDecision = {
  candidates: RouteCandidate[];
  skipped: Array<{ providerId: string; reason: RouteSkipReason }>;
};

/**
 * A sliding-window limiter. One window is kept per connection so a burst that
 * straddles a minute boundary cannot double the effective rate.
 */
export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * The wait in ms before the next request is allowed, or 0 when one is allowed now.
   *
   * **A query. It records nothing.** It used to push the timestamp into the window when it allowed
   * a request, and the request path calls `record()` as well — so every request was counted twice
   * and a connection set to 60 requests per minute behaved like 30. The over-count only bites when
   * a limit is actually set, and the default is no limit, which is why it survived.
   *
   * It also over-counted in a second way: a request that was refused still consumed budget, and so
   * did a request whose provider call was never made. `record()` is the commit, and it is called
   * when the request is dispatched.
   */
  check(key: string, limitPerMinute: number): number {
    if (limitPerMinute <= 0) return 0;
    const now = this.now();
    const cutoff = now - 60_000;
    const recent = (this.window(key, cutoff));
    if (recent.length < limitPerMinute) return 0;
    return Math.max(0, recent[0]! + 60_000 - now);
  }

  /** The requests still inside the window, for the dashboard's view of a connection's load. */
  private window(key: string, cutoff: number): number[] {
    return (this.windows.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
  }

  /** Records a request that was allowed without going through `check`. */
  /**
   * Counts one request against a connection's budget.
   *
   * Called when a request is **dispatched**, not when it succeeds: a request that was sent and then
   * failed still cost the provider a call, and a rate limit that forgives failures is not a rate
   * limit. A request that was *refused* is not counted, because nothing was sent.
   */
  record(key: string) {
    const now = this.now();
    const recent = this.window(key, now - 60_000);
    recent.push(now);
    this.windows.set(key, recent);
  }

  /**
   * Drops the windows of connections that no longer exist.
   *
   * Distinct from `prune()`, and both are needed. `prune()` answers *"is this timestamp still inside the
   * window?"* and is the right question for a live connection — which `prune()` could do but **nothing
   * called**, so every window ever recorded was retained for the life of the process. Measured: 3000
   * connections dispatched once each left 3000 windows behind, and `prune()` had to be called by hand to
   * clear them.
   *
   * Age alone cannot answer this either. A connection created ten minutes ago and dispatched to once has a
   * window that is stale by `prune()`'s standard and current by the connection store's, and pruning by age
   * would forgive the budget of a connection that still exists. So the live set decides existence and
   * `prune()` decides age, and neither is asked to do the other's job.
   */
  retain(liveKeys: ReadonlySet<string>): void {
    for (const key of this.windows.keys()) {
      if (!liveKeys.has(key)) this.windows.delete(key);
    }
  }

  /** Releases retained windows so an idle gateway does not grow without bound. */
  prune(maxAgeMs = 120_000) {
    const cutoff = this.now() - maxAgeMs;
    for (const [key, timestamps] of this.windows) {
      const recent = timestamps.filter((timestamp) => timestamp > cutoff);
      if (recent.length === 0) this.windows.delete(key);
      else this.windows.set(key, recent);
    }
  }
}

export type ProviderOutcome = {
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
};

/**
 * Tracks recent provider outcomes so routing can skip a connection that is
 * failing right now, without waiting for a health poll.
 */
/** How long an ejected provider waits before one probe request is allowed. */
const defaultRecoveryCooldownMs = 30_000;

export class HealthRegistry {
  private readonly state = new Map<string, { failures: number; successes: number; lastFailureAt?: number; lastCheckedAt?: string; lastLatencyMs?: number; lastError?: string }>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly recoveryCooldownMs: number = defaultRecoveryCooldownMs,
  ) {}

  recordSuccess(providerId: string, latencyMs: number, checkedAt = new Date().toISOString()) {
    const current = this.state.get(providerId) ?? { failures: 0, successes: 0 };
    this.state.set(providerId, { failures: 0, successes: current.successes + 1, lastCheckedAt: checkedAt, lastLatencyMs: latencyMs });
  }

  recordFailure(providerId: string, errorCode: string, errorMessage: string) {
    const current = this.state.get(providerId) ?? { failures: 0, successes: 0 };
    this.state.set(providerId, { ...current, failures: current.failures + 1, lastFailureAt: this.now(), lastCheckedAt: new Date().toISOString(), lastError: `${errorCode}: ${errorMessage}` });
  }

  /**
   * A connection is treated as unhealthy only after consecutive failures, so a
   * single blip does not eject a working route. After the cooldown it is probed
   * again, so a recovered provider rejoins the chain without a restart.
   */
  isUnhealthy(providerId: string, threshold: number) {
    if (threshold <= 0) return false;
    const current = this.state.get(providerId);
    if (!current || current.failures < threshold) return false;
    return this.now() - (current.lastFailureAt ?? 0) < this.recoveryCooldownMs;
  }

  snapshot(providerId: string, threshold: number) {
    const current = this.state.get(providerId);
    if (!current) return undefined;
    return {
      failures: current.failures,
      successes: current.successes,
      ...(current.lastCheckedAt === undefined ? {} : { lastCheckedAt: current.lastCheckedAt }),
      ...(current.lastLatencyMs === undefined ? {} : { lastLatencyMs: current.lastLatencyMs }),
      ...(current.lastError === undefined ? {} : { lastError: current.lastError }),
      ...(this.isUnhealthy(providerId, threshold) ? { ejected: true } : {}),
    };
  }

  forget(providerId: string) {
    this.state.delete(providerId);
  }
}

/** Failures worth another attempt. Bad requests and auth errors never are. */
export function isRetryableFailure(error: unknown) {
  if (!(error instanceof ProviderError)) return false;
  if (error.code === 'CANCELLED') return false;
  if (error.code === 'INVALID_REQUEST' || error.code === 'AUTHENTICATION_FAILED' || error.code === 'NOT_SUPPORTED' || error.code === 'NOT_FOUND') return false;
  /**
   * `INVALID_RESPONSE` is about the *answer*, not the request, and that distinction is the whole
   * reason it is here.
   *
   * Every code above describes this request or this credential: the model is wrong, the key is
   * refused, the lane does not exist. Another provider will refuse them the same way, so trying one
   * spends an upstream request to learn nothing. `INVALID_RESPONSE` is the opposite — the provider
   * accepted the request and returned a body nobody could read, which is 23 sites across the
   * adapters and says nothing at all about whether the *next* provider can answer.
   *
   * Before this, the system contradicted itself: the failover loop called `recordFailure` with this
   * code, marking the connection unhealthy, and then immediately stopped instead of trying a
   * connection the health system had just judged capable. One provider returning an empty stream
   * took down a request a healthy second provider would have served.
   */
  if (error.code === 'INVALID_RESPONSE') return true;
  return error.retryable || error.code === 'PROVIDER_TIMEOUT' || error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'RATE_LIMITED' || error.code === 'PROVIDER_REQUEST_FAILED';
}

/**
 * Splits a `provider/model` request into its provider and model, but only when the prefix is a
 * provider this gateway actually has a connection for.
 *
 * Splitting at the first slash alone would misread real model ids: most ids in the catalog already
 * contain one (`qwen/qwen3.8-27b:free`), and `qwen` is not a provider prefix there. So the prefix must
 * name a connected provider, and anything else is returned unchanged as a bare model id.
 */
export function splitProviderPrefix(
  model: string,
  connections: readonly Pick<ConnectionRecord, 'providerId'>[],
): { model: string; providerId?: string } {
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return { model: trimmed };
  const prefix = trimmed.slice(0, slash);
  const rest = trimmed.slice(slash + 1);
  if (!rest) return { model: trimmed };
  return connections.some((connection) => connection.providerId === prefix)
    ? { model: rest, providerId: prefix }
    : { model: trimmed };
}

/** Resolves a failover chain, ordered by priority then name for determinism. */
export function resolveRoute(input: {
  connections: ConnectionRecord[];
  model: string;
  explicitProviderId?: string;
  health: HealthRegistry;
  failureThreshold: number;
  rateLimitWaitMs?: Map<string, number>;
}): RouteDecision {
  const modelId = input.model.trim();
  const usable = input.connections
    .filter((connection) => connection.enabled && connection.hasCredential)
    .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));

  const skipped: RouteDecision['skipped'] = [];
  const ownsModel = (connection: ConnectionRecord) => modelId.length > 0 && connection.modelIds.includes(modelId);

  if (input.explicitProviderId) {
    // An explicit request is a deliberate pin: it is served even when the model
    // is not in that connection's catalog.
    const pinned = usable.filter((connection) => connection.providerId === input.explicitProviderId);
    if (pinned.length > 0) {
      return { candidates: pinned.map(toCandidate), skipped: [] };
    }
    skipped.push({ providerId: input.explicitProviderId, reason: 'no-models' });
  }

  const matching = usable.filter(ownsModel);
  const fallbackPool = matching.length > 0 ? matching : usable;
  const candidates: RouteCandidate[] = [];
  for (const connection of fallbackPool) {
    if (input.health.isUnhealthy(connection.providerId, input.failureThreshold)) {
      skipped.push({ providerId: connection.providerId, reason: 'unhealthy' });
      continue;
    }
    const waitMs = input.rateLimitWaitMs?.get(connection.id) ?? 0;
    if (waitMs > 0) {
      skipped.push({ providerId: connection.providerId, reason: 'rate-limited' });
      continue;
    }
    candidates.push(toCandidate(connection));
  }
  return { candidates, skipped };
}

function toCandidate(connection: ConnectionRecord): RouteCandidate {
  return {
    providerId: connection.providerId,
    connectionId: connection.id,
    priority: connection.priority,
    resilience: { ...connection.resilience },
  };
}

export const noCandidateMessage = 'No enabled provider connection can serve this model.';
