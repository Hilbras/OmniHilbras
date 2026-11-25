import { atomicWrite, readOptionalText } from './secure-store.js';

/**
 * A small durable replay ledger for billable creates.
 *
 * A retried request is the ordinary case, not an exotic one: a client times out after the provider
 * accepted a job, retries, and is charged twice. The ledger binds one caller-supplied key to one
 * request hash and one terminal response. The same key with a different body is a conflict; the same
 * key with the same body returns the first answer without touching the provider again.
 *
 * This deliberately stores no credentials: a one-time key secret must never be persisted just to
 * make an API-key retry idempotent. It is for responses that are safe to replay.
 */

type Entry = { hash: string; at: number; value: unknown };
type FileShape = { version: 1; entries: Record<string, Entry> };

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 512;

export class IdempotencyStore {
  private loaded = false;
  private entries: Record<string, Entry> = {};
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const text = await readOptionalText(this.path, MAX_BYTES);
      if (!text) return;
      const parsed = JSON.parse(text) as Partial<FileShape>;
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') return;
      this.entries = parsed.entries;
    } catch {
      // A corrupt ledger must not stop the gateway. The worst case is a duplicate billable create,
      // which is still better than refusing every new request until someone deletes a file.
      this.entries = {};
    }
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of Object.entries(this.entries)) {
      if (!entry || entry.at < cutoff) delete this.entries[key];
    }
    const keys = Object.keys(this.entries);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((left, right) => this.entries[left]!.at - this.entries[right]!.at)
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((key) => delete this.entries[key]);
    }
  }

  async lookup(key: string): Promise<{ hash: string; value: unknown } | undefined> {
    await this.load();
    this.prune();
    const entry = this.entries[key];
    return entry ? { hash: entry.hash, value: entry.value } : undefined;
  }

  async commit(key: string, hash: string, value: unknown): Promise<void> {
    await this.load();
    this.entries[key] = { hash, at: this.now(), value };
    this.prune();
    const payload = `${JSON.stringify({ version: 1, entries: this.entries } satisfies FileShape)}\n`;
    // Serialize writes so two concurrent creates cannot rename over one another's snapshots.
    this.writing = this.writing.then(() => atomicWrite(this.path, payload));
    await this.writing;
  }
}