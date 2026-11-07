/**
 * How fast each **connection** has been, measured from the requests it served.
 *
 * ## Why this is not the health registry
 *
 * Health answers "who is ejected?" and is keyed by **provider** — one verdict per card, which is the
 * right shape for a badge. Latency answers a different question, "which account of this provider is
 * quickest?", and a provider with two accounts has two answers. Recording it under the provider id
 * would average two accounts into one number that describes neither, which is why this ledger is
 * keyed by `connectionId` and kept apart from health.
 *
 * ## What it measures, and what it refuses to claim
 *
 * A sample is recorded when a request **succeeds**, so the number is a real round trip through that
 * account rather than a probe. Failures are not samples: a request that timed out at 30 s says the
 * account was unreachable, not slow, and folding it into the average would make an outage look like a
 * latency problem. An account with no samples has **no reading at all** — callers see `undefined`, not
 * `0`, and the ordering below puts it after measured ones. Unknown is not fast.
 *
 * The average is an EWMA rather than a mean: an account that was slow once and has been quick since
 * should read quick, and a plain mean would carry the old outlier for as many requests as it takes to
 * dilute it. `samples` is reported beside the value so a caller can refuse to trust a single reading.
 *
 * ## Bounded, because a dashboard deletes connections
 *
 * Entries are pruned on every write: an id that has not been seen for a while is dropped, and the map
 * is capped. This is the same lesson the routing maps learned — two maps keyed by connection id only
 * ever grew, and a dashboard that deleted connections left 2000 stale entries behind.
 */
const DEFAULT_MAX_ENTRIES = 256;
/** How much of the new sample replaces the old reading. A quarter settles in a few requests without whipping. */
const DEFAULT_ALPHA = 0.25;

export type ConnectionLatency = {
  /** The smoothed round trip, in milliseconds. */
  latencyMs: number;
  /** How many successful requests produced it. A caller decides how many it needs to trust it. */
  samples: number;
  /** When the last sample landed, ISO 8601. */
  measuredAt: string;
};

type Entry = ConnectionLatency & { lastSeenMs: number };

export class ConnectionLatencyLedger {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly options: { maxEntries?: number; alpha?: number; now?: () => number } = {},
  ) {}

  /** Records one successful round trip for a connection. */
  record(connectionId: string, latencyMs: number): void {
    if (!connectionId || !Number.isFinite(latencyMs) || latencyMs < 0) return;
    const alpha = this.options.alpha ?? DEFAULT_ALPHA;
    const nowMs = this.now();
    const previous = this.entries.get(connectionId);
    const smoothed = previous ? previous.latencyMs * (1 - alpha) + latencyMs * alpha : latencyMs;
    this.entries.delete(connectionId);
    this.entries.set(connectionId, {
      latencyMs: Math.round(smoothed),
      samples: (previous?.samples ?? 0) + 1,
      measuredAt: new Date(nowMs).toISOString(),
      lastSeenMs: nowMs,
    });
    this.prune();
  }

  /** The reading for one connection, or `undefined` when it has never served a request. */
  get(connectionId: string): ConnectionLatency | undefined {
    const entry = this.entries.get(connectionId);
    if (!entry) return undefined;
    const { lastSeenMs: _ignored, ...reading } = entry;
    return reading;
  }

  /** Every reading, for a dashboard or a test. */
  snapshot(): Record<string, ConnectionLatency> {
    return Object.fromEntries([...this.entries].map(([id, entry]) => {
      const { lastSeenMs: _ignored, ...reading } = entry;
      return [id, reading];
    }));
  }

  /** Forgets a connection — called when one is deleted, so a reused id cannot inherit a reading. */
  forget(connectionId: string): void {
    this.entries.delete(connectionId);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Drops the least-recently-seen entries once the cap is passed. Insertion order is not enough on its
   * own — a reading that keeps being refreshed should survive — so the map is re-inserted on every
   * write and the oldest key is the first out.
   */
  private prune(): void {
    const max = this.options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}
