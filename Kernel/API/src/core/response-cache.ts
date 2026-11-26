import type { StateDocument } from './state-document.js';

/**
 * Deterministic response caching.
 *
 * The first version was a 30-second in-memory map keyed on `{model, messages, temperature, maxTokens}`
 * and only for temperature 0. That answered "is this the same conversation" and nothing else: tools,
 * response format, seed and a pinned provider all change the answer, and a restart forgot every
 * entry. This version keys on the whole request, can persist, honours `no-store`, and reports hits.
 *
 * Two rules are stated rather than assumed:
 *
 * - **A hit is only a hit for the same canonical request.** The key is a stable serialization with
 *   sorted object keys, so two property orders hash alike and two different tool lists do not.
 * - **`Cache-Control: no-store` always wins**, even for a temperature-0 request, because the caller
 *   said so and the cache is a convenience, not an authority.
 */

export type CacheStats = {
  hits: number;
  misses: number;
  bypasses: number;
  refreshes: number;
  evictions: number;
  entries: number;
};

type CacheEntry = { value: unknown; expiresAt: number };

export type ResponseCacheOptions = {
  ttlMs: number;
  maxEntries?: number;
  /** When present, entries survive a restart. The document is written on a coalesced delay. */
  document?: StateDocument;
  now?: () => number;
  flushDelayMs?: number;
};

export type CacheKeyInput = {
  model: string;
  messages: unknown;
  temperature?: number;
  maxOutputTokens?: number;
  tools?: unknown;
  toolChoice?: string;
  responseFormat?: unknown;
  seed?: number;
  connectionId?: string;
  providerId?: string;
};

/** Sorted-key JSON, so `{a:1,b:2}` and `{b:2,a:1}` are one key. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export class ResponseCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly flushDelayMs: number;
  private loaded?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private dirty = false;
  private writing?: Promise<void>;
  readonly stats: CacheStats = { hits: 0, misses: 0, bypasses: 0, refreshes: 0, evictions: 0, entries: 0 };

  constructor(private readonly options: ResponseCacheOptions) {
    this.maxEntries = options.maxEntries ?? 256;
    this.now = options.now ?? Date.now;
    this.flushDelayMs = options.flushDelayMs ?? 250;
  }

  get enabled(): boolean {
    return this.options.ttlMs > 0;
  }

  /** Loads a persisted cache once. A corrupt document starts empty rather than failing a request. */
  async ready(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.options.document) return;
      const text = await this.options.document.read(32 * 1024 * 1024).catch(() => undefined);
      if (!text) return;
      try {
        const parsed = JSON.parse(text) as { version?: number; entries?: Record<string, CacheEntry> };
        if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) return;
        for (const [key, entry] of Object.entries(parsed.entries)) {
          if (typeof entry?.expiresAt === 'number' && entry.expiresAt > this.now()) this.entries.set(key, entry);
        }
        this.stats.entries = this.entries.size;
      } catch {
        // An unreadable cache is a cache miss, not a failed gateway.
      }
    })();
    await this.loaded;
  }

  keyFor(request: CacheKeyInput): string {
    return stableStringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
      maxOutputTokens: request.maxOutputTokens ?? null,
      tools: request.tools ?? null,
      toolChoice: request.toolChoice ?? null,
      responseFormat: request.responseFormat ?? null,
      seed: request.seed ?? null,
      connectionId: request.connectionId ?? null,
      providerId: request.providerId ?? null,
    });
  }

  get(key: string): unknown | undefined {
    if (!this.enabled) {
      this.stats.bypasses += 1;
      return undefined;
    }
    const entry = this.entries.get(key);
    if (!entry) { this.stats.misses += 1; return undefined; }
    if (this.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.stats.entries = this.entries.size;
      this.stats.misses += 1;
      this.touch();
      return undefined;
    }
    this.stats.hits += 1;
    return entry.value;
  }

  set(key: string, value: unknown): void {
    if (!this.enabled) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
        this.stats.evictions += 1;
      }
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.options.ttlMs });
    this.stats.entries = this.entries.size;
    this.touch();
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.stats.entries = 0;
    this.dirty = true;
    await this.flush();
  }

  private touch(): void {
    if (!this.options.document) return;
    this.dirty = true;
    if (this.flushDelayMs <= 0) { void this.flush(); return; }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.flushDelayMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.dirty || !this.options.document) { if (this.writing) await this.writing; return; }
    this.dirty = false;
    const entries = Object.fromEntries([...this.entries.entries()].filter(([, entry]) => entry.expiresAt > this.now()));
    this.writing = this.options.document.write(JSON.stringify({ version: 1, entries })).catch(() => { this.dirty = true; });
    await this.writing;
  }
}
