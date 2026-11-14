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
};

const windowMs = 60_000;

/** The default ceiling: ten requests a second sustained, which no interactive client needs to exceed. */
export const defaultRequestsPerMinute = 600;

export class RateLimiter {
  private readonly windows = new Map<string, { count: number; startedAt: number }>();
  private readonly perMinute: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.perMinute = Math.max(0, Math.floor(options.perMinute));
    this.now = options.now ?? (() => Date.now());
  }

  get enabled() {
    return this.perMinute > 0;
  }

  /** Counts one request for `caller`, rolling the window when it has expired. */
  check(caller: string): RateLimitDecision {
    if (!this.enabled) return { allowed: true, retryAfterMs: 0, limit: 0, remaining: 0 };
    const at = this.now();
    const window = this.windows.get(caller);
    if (!window || at - window.startedAt >= windowMs) {
      this.windows.set(caller, { count: 1, startedAt: at });
      return { allowed: true, retryAfterMs: 0, limit: this.perMinute, remaining: this.perMinute - 1 };
    }
    if (window.count >= this.perMinute) {
      return { allowed: false, retryAfterMs: Math.max(0, window.startedAt + windowMs - at), limit: this.perMinute, remaining: 0 };
    }
    window.count += 1;
    return { allowed: true, retryAfterMs: 0, limit: this.perMinute, remaining: this.perMinute - window.count };
  }

  /** Drops expired windows, so a long-lived gateway does not accumulate one entry per key ever seen. */
  prune() {
    const at = this.now();
    for (const [caller, window] of this.windows) {
      if (at - window.startedAt >= windowMs) this.windows.delete(caller);
    }
  }

  get trackedCallers() {
    return this.windows.size;
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
