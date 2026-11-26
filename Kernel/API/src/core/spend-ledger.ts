import { createStateDocument, type StateDocument } from './state-document.js';
import { defaultStateDirectory } from './secure-store.js';
import { budgetWindow, usdToMicros, type BudgetPeriod, type SpendSnapshot } from './budgets.js';

/**
 * Durable spend, kept apart from the usage log on purpose.
 *
 * `UsageStore` is bounded — it keeps the last thousand requests so the page stays a page. A monthly
 * or lifetime budget cannot be computed from a rolling window, and a budget that silently forgets
 * last week's spend is worse than no budget: it says "you have spent $3" to someone who has spent
 * $300. This ledger keeps one small bucket per (scope, id, UTC day), with its own retention, and is
 * written by coalesced flushes rather than one disk write per request.
 *
 * Holds are how concurrency is handled. A request reserves its worst-case dollar cost before it is
 * dispatched; the reservation is visible to every other request, and settlement replaces it with the
 * actual. A crash leaves a hold that expires, which is reported rather than forgotten.
 */

export type SpendScope = 'key' | 'workspace';

export type SpendBucket = {
  usdMicros: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  unpricedRequests: number;
};

type SpendHold = {
  scope: SpendScope;
  id: string;
  usdMicros: number;
  expiresAt: number;
};

type SpendDocument = {
  version: 1;
  buckets: Record<string, SpendBucket>;
  holds: Record<string, SpendHold>;
};

export type SpendLedgerOptions = {
  directory?: string;
  path?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** How long a bucket is kept. Long enough for a year-over-year question. */
  retentionDays?: number;
  /** Flush coalescing window. Zero flushes synchronously, which tests use. */
  flushDelayMs?: number;
  now?: () => number;
};

const emptyBucket = (): SpendBucket => ({ usdMicros: 0, inputTokens: 0, outputTokens: 0, requests: 0, unpricedRequests: 0 });
const dayKey = (at: Date): string => at.toISOString().slice(0, 10);
const bucketKey = (scope: SpendScope, id: string, day: string): string => `${scope}:${id}:${day}`;

export class SpendLedger {
  private readonly document: StateDocument;
  private readonly retentionDays: number;
  private readonly flushDelayMs: number;
  private readonly now: () => number;
  private state: SpendDocument = { version: 1, buckets: {}, holds: {} };
  private loaded?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private writing?: Promise<void>;
  private dirty = false;

  constructor(options: SpendLedgerOptions = {}) {
    this.document = createStateDocument({
      name: 'spend',
      directory: options.directory ?? defaultStateDirectory(options.env),
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    this.retentionDays = options.retentionDays ?? 400;
    this.flushDelayMs = options.flushDelayMs ?? 250;
    this.now = options.now ?? Date.now;
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      const text = await this.document.read(16 * 1024 * 1024).catch(() => undefined);
      if (!text) return;
      try {
        const parsed = JSON.parse(text) as SpendDocument;
        if (parsed?.version !== 1 || typeof parsed.buckets !== 'object' || parsed.buckets === null) return;
        this.state = { version: 1, buckets: parsed.buckets, holds: typeof parsed.holds === 'object' && parsed.holds !== null ? parsed.holds : {} };
        this.prune();
        this.expireHolds();
      } catch {
        // A corrupt ledger starts empty rather than refusing to start the gateway. The next flush
        // replaces it; the usage log remains the record of what happened.
      }
    })();
    await this.loaded;
  }

  private prune(): void {
    const cutoff = new Date(this.now() - this.retentionDays * 86_400_000).toISOString().slice(0, 10);
    for (const key of Object.keys(this.state.buckets)) {
      const day = key.slice(key.lastIndexOf(':') + 1);
      if (day < cutoff) delete this.state.buckets[key];
    }
  }

  private expireHolds(): void {
    const now = this.now();
    for (const [requestId, hold] of Object.entries(this.state.holds)) {
      if (hold.expiresAt <= now) delete this.state.holds[requestId];
    }
  }

  /** Adds one settled request, and releases the hold it carried. */
  async record(input: {
    scope: SpendScope;
    id: string;
    requestId?: string;
    at?: Date;
    usdMicros?: number;
    inputTokens?: number;
    outputTokens?: number;
    unpriced?: boolean;
  }): Promise<void> {
    await this.ensureLoaded();
    const at = input.at ?? new Date(this.now());
    const key = bucketKey(input.scope, input.id, dayKey(at));
    const bucket = this.state.buckets[key] ?? emptyBucket();
    bucket.usdMicros += Math.max(0, Math.round(input.usdMicros ?? 0));
    bucket.inputTokens += Math.max(0, Math.round(input.inputTokens ?? 0));
    bucket.outputTokens += Math.max(0, Math.round(input.outputTokens ?? 0));
    bucket.requests += 1;
    if (input.unpriced === true) bucket.unpricedRequests += 1;
    this.state.buckets[key] = bucket;
    if (input.requestId) delete this.state.holds[input.requestId];
    this.touch();
  }

  /** Reserves a worst-case dollar cost until the request settles or the hold expires. */
  async hold(input: { scope: SpendScope; id: string; requestId: string; usdMicros: number; ttlMs?: number }): Promise<void> {
    await this.ensureLoaded();
    this.expireHolds();
    this.state.holds[input.requestId] = {
      scope: input.scope,
      id: input.id,
      usdMicros: Math.max(0, Math.round(input.usdMicros)),
      expiresAt: this.now() + (input.ttlMs ?? 10 * 60_000),
    };
    this.touch();
  }

  async release(requestId: string): Promise<void> {
    await this.ensureLoaded();
    if (this.state.holds[requestId]) {
      delete this.state.holds[requestId];
      this.touch();
    }
  }

  /** What a period has cost so far, including holds that have not expired. */
  async snapshot(scope: SpendScope, id: string, period: BudgetPeriod, at: Date = new Date(this.now())): Promise<SpendSnapshot> {
    await this.ensureLoaded();
    this.expireHolds();
    const { startMs, endMs } = budgetWindow(period, at);
    const totals = emptyBucket();
    let heldUsdMicros = 0;
    for (const [key, bucket] of Object.entries(this.state.buckets)) {
      if (!key.startsWith(`${scope}:${id}:`)) continue;
      const day = key.slice(key.lastIndexOf(':') + 1);
      const dayStart = Date.parse(`${day}T00:00:00.000Z`);
      if (Number.isNaN(dayStart) || dayStart < startMs || (endMs !== undefined && dayStart >= endMs)) continue;
      totals.usdMicros += bucket.usdMicros;
      totals.inputTokens += bucket.inputTokens;
      totals.outputTokens += bucket.outputTokens;
      totals.requests += bucket.requests;
      totals.unpricedRequests += bucket.unpricedRequests;
    }
    for (const hold of Object.values(this.state.holds)) {
      if (hold.scope === scope && hold.id === id) heldUsdMicros += hold.usdMicros;
    }
    return { usdMicros: totals.usdMicros, tokens: totals.inputTokens + totals.outputTokens, heldUsdMicros, requests: totals.requests, unpricedRequests: totals.unpricedRequests };
  }

  /** Remaining held amounts, for a diagnostic that must not pretend a crashed hold never existed. */
  async holds(): Promise<Array<{ requestId: string; scope: SpendScope; id: string; usdMicros: number; expiresAt: string }>> {
    await this.ensureLoaded();
    this.expireHolds();
    return Object.entries(this.state.holds).map(([requestId, hold]) => ({
      requestId,
      scope: hold.scope,
      id: hold.id,
      usdMicros: hold.usdMicros,
      expiresAt: new Date(hold.expiresAt).toISOString(),
    }));
  }

  private touch(): void {
    this.dirty = true;
    if (this.flushDelayMs <= 0) {
      void this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.flushDelayMs);
    this.timer.unref?.();
  }

  /** Writes the coalesced state now. Called by tests and by service shutdown. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.dirty) {
      await this.writing;
      return;
    }
    this.dirty = false;
    const body = JSON.stringify(this.state);
    this.writing = this.document.write(body).catch(() => { this.dirty = true; });
    await this.writing;
  }

  async clear(): Promise<void> {
    this.state = { version: 1, buckets: {}, holds: {} };
    this.dirty = true;
    await this.flush();
  }

  /** Test helper: the raw buckets, so a rollover assertion can name the day it expects. */
  async inspect(): Promise<{ buckets: Record<string, SpendBucket>; holds: number }> {
    await this.ensureLoaded();
    return { buckets: { ...this.state.buckets }, holds: Object.keys(this.state.holds).length };
  }
}

/** Converts a priced usage record to the ledger's units, keeping "unpriced" distinct from free. */
export function spendFromUsage(input: { usd?: number; inputTokens?: number; outputTokens?: number }): { usdMicros?: number; inputTokens?: number; outputTokens?: number; unpriced?: boolean } {
  return {
    ...(input.usd === undefined ? { unpriced: true } : { usdMicros: usdToMicros(input.usd) }),
    ...(input.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
    ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
  };
}
