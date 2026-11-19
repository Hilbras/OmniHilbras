/**
 * Whether a connection should be asked at all.
 *
 * The gateway had cooldowns and quotas, but nothing that said *"this route has failed five times in a row; stop
 * spending timeout on it"*. A provider that is timing out was asked on every request, so every user paid the full
 * timeout to learn what the previous request had already learned. That is what a breaker is for.
 *
 * ## The three states, and why the middle one exists
 *
 * - **closed** — ask normally. Consecutive failures are counted; one success resets the count.
 * - **open** — refuse immediately until a cooldown passes. Requests fail over to the next route *without a network
 *   round trip*, which is the whole saving.
 * - **half-open** — the cooldown has passed, so exactly **one** probe may go out. Its outcome decides: a success
 *   closes the breaker, a failure re-opens it with a doubled cooldown.
 *
 * Half-open is not decoration. Without it the only way back is a timer, and a route that has recovered stays unused
 * until somebody notices; without the single-probe rule, the moment a cooldown expires every queued request probes at
 * once and a still-broken provider gets a burst — the thundering herd this exists to prevent.
 *
 * ## What this is not
 *
 * Not health checking. `HealthManager` asks the provider whether it is well on a schedule; this answers a narrower
 * question per **request**: given what happened in the last few seconds, is spending this request's timeout on this
 * route a good idea? A breaker that opens says nothing about the provider's health and must never be reported as
 * one — it reports *its own* state, in `status()`, and the dashboard shows both.
 *
 * Keyed by **connection**, not provider: one account's outage says nothing about its sibling, and this file exists next
 * to three earlier bugs that confused the two.
 */

export type BreakerConfig = {
  /** Consecutive failures that open the breaker. 0 disables it entirely. */
  failureThreshold: number;
  /** The first cooldown. Each re-trip doubles it. */
  baseCooldownMs: number;
  /** The ceiling the doubling stops at, so a long outage does not create an unbounded wait. */
  maxCooldownMs: number;
};

export const defaultBreakerConfig: BreakerConfig = {
  failureThreshold: 4,
  baseCooldownMs: 15_000,
  maxCooldownMs: 5 * 60_000,
};

export type BreakerState = 'closed' | 'open' | 'half-open';

type Entry = {
  state: BreakerState;
  failures: number;
  /** Consecutive trips, so the cooldown doubles and a recovery resets it. */
  trips: number;
  /** Epoch ms at which the cooldown ends. Only meaningful while open. */
  openUntil: number;
  /** True while the single half-open probe is in flight. */
  probing: boolean;
};

export type BreakerStatus = {
  state: BreakerState;
  failures: number;
  trips: number;
  /** How long until the next probe may be sent, when open. */
  retryAfterMs?: number;
  /** How many attempts this breaker has refused. The measurement this feature is judged by. */
  skipped: number;
};

export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();
  private readonly skipped = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly config: BreakerConfig = defaultBreakerConfig, now: () => number = () => Date.now()) {
    this.now = now;
  }

  /**
   * Whether one attempt may be dispatched for this connection.
   *
   * `false` is the whole point: the caller must fail over **without waiting**, because the timeout it would otherwise
   * spend is the cost this exists to remove. The side effect is deliberate — a refusal is counted here, so
   * `status().skipped` is the number of attempts the breaker saved rather than a number computed somewhere else.
   */
  allows(key: string): boolean {
    if (this.config.failureThreshold <= 0) return true;
    const entry = this.entries.get(key);
    if (!entry || entry.state === 'closed') return true;
    if (entry.state === 'open') {
      if (this.now() < entry.openUntil) {
        this.skipped.set(key, (this.skipped.get(key) ?? 0) + 1);
        return false;
      }
      // The cooldown elapsed: this attempt becomes the probe. A second concurrent request must not also probe.
      entry.state = 'half-open';
      entry.probing = true;
      return true;
    }
    if (entry.probing) {
      this.skipped.set(key, (this.skipped.get(key) ?? 0) + 1);
      return false;
    }
    entry.probing = true;
    return true;
  }

  /**
   * Releases a probe without judging the connection.
   *
   * A granted half-open probe can end in a limiter refusal, a cancellation, or an allowance
   * refusal. None of those is evidence about the provider. Without this, `probing` stays true and
   * the next `allows()` refuses forever — a permanent ban from one inconclusive probe.
   */
  recordAbandoned(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.state === 'half-open') entry.probing = false;
  }

  /** A success closes the breaker and resets the ladder: a recovered route starts from the base cooldown again. */
  recordSuccess(key: string) {    const entry = this.entries.get(key);
    if (!entry) return;
    entry.state = 'closed';
    entry.failures = 0;
    entry.trips = 0;
    entry.probing = false;
    entry.openUntil = 0;
  }

  /**
   * A failure, and what it did: `counted` while still closed, `opened` when the threshold was reached, and
   * `re-opened` when a half-open probe failed — the case that doubles the cooldown.
   */
  recordFailure(key: string): 'counted' | 'opened' | 're-opened' {
    if (this.config.failureThreshold <= 0) return 'counted';
    const entry = this.entries.get(key) ?? { state: 'closed' as BreakerState, failures: 0, trips: 0, openUntil: 0, probing: false };
    if (entry.state === 'half-open') {
      entry.probing = false;
      entry.trips += 1;
      entry.state = 'open';
      entry.openUntil = this.now() + this.cooldown(entry.trips);
      this.entries.set(key, entry);
      return 're-opened';
    }
    entry.failures += 1;
    entry.probing = false;
    if (entry.failures >= this.config.failureThreshold) {
      entry.trips += 1;
      entry.state = 'open';
      entry.openUntil = this.now() + this.cooldown(entry.trips);
      this.entries.set(key, entry);
      return 'opened';
    }
    this.entries.set(key, entry);
    return 'counted';
  }

  status(key: string): BreakerStatus {
    const entry = this.entries.get(key);
    const skipped = this.skipped.get(key) ?? 0;
    if (!entry) return { state: 'closed', failures: 0, trips: 0, skipped };
    const retryAfterMs = entry.state === 'open' ? Math.max(0, entry.openUntil - this.now()) : undefined;
    return {
      state: entry.state,
      failures: entry.failures,
      trips: entry.trips,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      skipped,
    };
  }

  /** Every connection this breaker is holding state for, for the routing view and the metrics endpoint. */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  reset(key?: string) {
    if (key === undefined) {
      this.entries.clear();
      this.skipped.clear();
      return;
    }
    this.entries.delete(key);
    this.skipped.delete(key);
  }

  /** `base * 2^(trips-1)`, capped. Trip 1 waits the base; trip 4 waits eight times as long. */
  private cooldown(trips: number): number {
    const factor = 2 ** Math.max(0, trips - 1);
    return Math.min(this.config.baseCooldownMs * factor, this.config.maxCooldownMs);
  }
}
