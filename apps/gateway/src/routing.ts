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

  /** Returns the wait in ms before the next request is allowed, or 0 when allowed. */
  check(key: string, limitPerMinute: number): number {
    if (limitPerMinute <= 0) return 0;
    const now = this.now();
    const cutoff = now - 60_000;
    const recent = (this.windows.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length < limitPerMinute) {
      recent.push(now);
      this.windows.set(key, recent);
      return 0;
    }
    this.windows.set(key, recent);
    return Math.max(0, recent[0]! + 60_000 - now);
  }

  /** Records a request that was allowed without going through `check`. */
  record(key: string) {
    const now = this.now();
    const recent = (this.windows.get(key) ?? []).filter((timestamp) => timestamp > now - 60_000);
    recent.push(now);
    this.windows.set(key, recent);
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
  return error.retryable || error.code === 'PROVIDER_TIMEOUT' || error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'RATE_LIMITED' || error.code === 'PROVIDER_REQUEST_FAILED';
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
