import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * An inbound limit on the LLM surface.
 *
 * ## Why this exists
 *
 * The gateway had a ceiling on what it *sends* to a provider (`requestsPerMinute`, per connection) and
 * none on what arrives. The client this gateway is built for is an agent that retries, and the audit
 * showed the consequence: a runaway loop spends the operator's paid quota at line speed, and the
 * provider's own limiter becomes the thing that stops it — which reads as the gateway being broken.
 *
 * ## Shape
 *
 * A fixed window per caller, one minute wide, counted in memory. In-memory is honest here because the
 * gateway is a single process bound to loopback; a second instance would need a shared store, and the
 * file says so rather than pretending the counter is global.
 *
 * The caller is the presented key when there is one, and the literal `local` otherwise — with
 * enforcement off, everything that arrives is the same trust class anyway, and the window still bounds
 * a loop.
 */

export type RateLimitDecision = {
  allowed: boolean;
  /** How long the caller should wait before trying again, when it is not allowed. */
  retryAfterMs: number;
  /** The configured ceiling, for the response body and the header. */
  limit: number;
  remaining: number;
};

export type RateLimiterOptions = {
  /** Requests per minute per caller. `0` disables the limit. */
  perMinute: number;
  now?: () => number;
  /**
   * Optional shared window store. Two limiters over the same store coordinate their counts — the bounded
   * foundation for a multi-instance gateway. In-memory (the default) stays process-local and is honest about it.
   */
  store?: RateLimitWindowStore;
};

/** A window for one caller, as stored. */
export type RateWindow = { count: number; startedAt: number };

/**
 * Shared state for rate-limit windows. Deliberately tiny: read one caller, write one caller, and list for pruning.
 * A file-backed implementation gives independent processes a common counter; an in-memory one is the default.
 */
export interface RateLimitWindowStore {
  get(caller: string): RateWindow | undefined;
  set(caller: string, window: RateWindow): void;
  entries(): Array<[string, RateWindow]>;
  delete(caller: string): void;
}

/** In-memory store: the current, process-local behaviour, extracted so both modes share one contract. */
export class MemoryRateLimitWindowStore implements RateLimitWindowStore {
  private readonly windows = new Map<string, RateWindow>();
  get(caller: string) { return this.windows.get(caller); }
  set(caller: string, window: RateWindow) { this.windows.set(caller, window); }
  entries() { return [...this.windows.entries()]; }
  delete(caller: string) { this.windows.delete(caller); }
}

/**
 * File-backed window store. Each process holds a snapshot; a write re-reads from disk before mutating so two
 * limiters over the same file share a counter. Writes are atomic (temp file + rename) so a crash cannot leave a
 * half-written ledger. This coordinates counts, not lock-free concurrency — a burst from several processes can
 * still race between the read and the write; the gateway documents that as a bound, not a guarantee.
 */
export class FileRateLimitWindowStore implements RateLimitWindowStore {
  private readonly path: string;
  private cache = new Map<string, RateWindow>();
  private loadedAt = 0;
  constructor(filePath: string) { this.path = filePath; }
  private reload() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, RateWindow>;
      this.cache = new Map(Object.entries(parsed));
    } catch {
      this.cache = new Map();
    }
    this.loadedAt = Date.now();
  }
  private persist() {
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(this.cache))}
`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
  get(caller: string) {
    if (Date.now() - this.loadedAt > 250) this.reload();
    return this.cache.get(caller);
  }
  set(caller: string, window: RateWindow) { this.reload(); this.cache.set(caller, window); this.persist(); }
  entries() { this.reload(); return [...this.cache.entries()]; }
  delete(caller: string) { this.reload(); this.cache.delete(caller); this.persist(); }
}

const windowMs = 60_000;

/** The default ceiling: ten requests a second sustained, which no interactive client needs to exceed. */
export const defaultRequestsPerMinute = 600;

export class RateLimiter {
  private readonly store: RateLimitWindowStore;
  private readonly perMinute: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.perMinute = Math.max(0, Math.floor(options.perMinute));
    this.now = options.now ?? (() => Date.now());
    this.store = options.store ?? new MemoryRateLimitWindowStore();
  }

  get enabled() {
    return this.perMinute > 0;
  }

  /** Counts one request for `caller`, rolling the window when it has expired. */
  check(caller: string): RateLimitDecision {
    if (!this.enabled) return { allowed: true, retryAfterMs: 0, limit: 0, remaining: 0 };
    const at = this.now();
    const window = this.store.get(caller);
    if (!window || at - window.startedAt >= windowMs) {
      this.store.set(caller, { count: 1, startedAt: at });
      return { allowed: true, retryAfterMs: 0, limit: this.perMinute, remaining: this.perMinute - 1 };
    }
    if (window.count >= this.perMinute) {
      return { allowed: false, retryAfterMs: Math.max(0, window.startedAt + windowMs - at), limit: this.perMinute, remaining: 0 };
    }
    const updated = { ...window, count: window.count + 1 };
    this.store.set(caller, updated);
    return { allowed: true, retryAfterMs: 0, limit: this.perMinute, remaining: this.perMinute - updated.count };
  }

  /** Drops expired windows, so a long-lived gateway does not accumulate one entry per key ever seen. */
  prune() {
    const at = this.now();
    for (const [caller, window] of this.store.entries()) {
      if (at - window.startedAt >= windowMs) this.store.delete(caller);
    }
  }

  get trackedCallers() {
    return this.store.entries().length;
  }
}

/**
 * The ceiling from the environment.
 *
 * A value that is not a non-negative integer is ignored and the default kept: a typo in an environment
 * variable must not leave a gateway that refuses every request. `0` is a deliberate "off", which is why
 * the check accepts it explicitly rather than treating it as missing.
 */
export function resolveRequestsPerMinute(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.OMNIHILBRAS_REQUESTS_PER_MINUTE?.trim();
  if (raw === undefined || raw === '') return defaultRequestsPerMinute;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return defaultRequestsPerMinute;
  return parsed;
}
