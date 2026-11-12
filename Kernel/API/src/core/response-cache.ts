/**
 * In-memory cache for deterministic chat responses.
 *
 * Only responses produced with a temperature of 0 (or no temperature) are cached, so
 * a caller that asks for variety never receives a stale answer. Entries expire after
 * `ttlMs` and the map is capped so a long-running gateway cannot grow without bound.
 */
export class ResponseCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly options: { ttlMs: number; maxEntries?: number } = { ttlMs: 0 }) {}

  get enabled(): boolean {
    return this.options.ttlMs > 0;
  }

  keyFor(request: { model: string; messages: unknown; temperature?: number; maxTokens?: number }): string {
    return JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
      maxTokens: request.maxTokens,
    });
  }

  get(key: string): unknown | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown): void {
    if (!this.enabled) return;
    if (this.entries.size >= (this.options.maxEntries ?? 256)) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.options.ttlMs });
  }
}
