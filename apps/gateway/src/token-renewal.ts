/**
 * Renews OAuth tokens before they expire, on a timer of its own, so an idle connection is still live when the next
 * burst of requests arrives.
 *
 * It owns no connection or provider knowledge. The service supplies the connections that carry an expiry and a
 * function that refreshes one; this file decides only which connections are due and runs the pass. A connection
 * that fails to renew is skipped for this pass and the others still renew.
 */

export type RenewableConnection = {
  id: string;
  providerId: string;
  /** ISO time the token expires. A connection without one is never renewed by this pass. */
  expiresAt?: string;
};

export type TokenRenewalSource = {
  connections(): Promise<readonly RenewableConnection[]>;
  renew(connection: RenewableConnection): Promise<void>;
};

export type TokenRenewalOptions = {
  now?: () => number;
  /** A token expiring within this window is renewed. */
  windowMs?: number;
  /** How often a pass runs. */
  intervalMs?: number;
  onError?: (connection: RenewableConnection, error: unknown) => void;
};

const defaultWindowMs = 30 * 60_000;
const defaultIntervalMs = 5 * 60_000;

export class TokenRenewal {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly intervalMs: number;

  constructor(private readonly source: TokenRenewalSource, private readonly options: TokenRenewalOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.windowMs = options.windowMs ?? defaultWindowMs;
    this.intervalMs = options.intervalMs ?? defaultIntervalMs;
  }

  /** One pass over the connections that expire within the window. */
  async pass(): Promise<void> {
    const connections = await this.source.connections();
    const horizon = this.now() + this.windowMs;
    for (const connection of connections) {
      if (!connection.expiresAt) continue;
      const expires = Date.parse(connection.expiresAt);
      if (!Number.isFinite(expires) || expires > horizon) continue;
      try {
        await this.source.renew(connection);
      } catch (error) {
        this.options.onError?.(connection, error);
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pass().catch(() => undefined); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  running(): boolean {
    return this.timer !== undefined;
  }
}
