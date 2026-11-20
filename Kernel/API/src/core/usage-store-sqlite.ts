import { createRequire } from 'node:module';
import { join } from 'node:path';
import { defaultConnectionDirectory } from './connections.js';
import { readOptionalText } from './secure-store.js';
import {
  LocalUsageStore,
  selectUsageRecords,
  summarizeUsage,
  normalizeRecord,
  isUsageRecord,
  highestSequence,
  parseUsageState,
  defaultMaxUsageRecords,
  type UsageStore,
  type UsageRecord,
  type UsageQuery,
  type UsageSummary,
  type UsageBackupState,
} from './usage-store.js';

/**
 * An optional SQLite-backed usage store (Phase 3 of the full-system upgrade).
 *
 * ## Why optional, and why JSON stays the default
 *
 * The gateway's ten stores are JSON files, which is the right default for a local-first, zero-dependency
 * install. A database is the ceiling for analytics at scale and concurrent access, so this adds one
 * **behind the same `UsageStore` interface**, selected by config, without changing the default or breaking
 * an existing vault. `node:sqlite` is built into Node ≥22.5; on an older runtime it is absent, so the
 * factory falls back to the JSON store rather than failing to start. The driver is loaded through
 * `createRequire` at construction, never as a top-level import, so the module loads on any Node and the
 * esbuild CLI bundle keeps `node:sqlite` external.
 *
 * ## Contract parity by construction
 *
 * The record/list/summary/size/clear/export/import logic mirrors `LocalUsageStore` and reuses the **same**
 * shared helpers (`selectUsageRecords`, `summarizeUsage`, `normalizeRecord`, `isUsageRecord`,
 * `highestSequence`, `parseUsageState`), so the two stores cannot answer a query differently. SQLite is the
 * durable layer: the whole bounded set is written in one transaction on flush, and read back on load. A
 * shared contract test runs the same assertions against both implementations.
 */

type SqliteStatement = {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Record<string, unknown>[];
};
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};
export type DatabaseSyncCtor = new (path: string) => SqliteDatabase;

const maxUsageFileBytes = 4 * 1024 * 1024;
const usageFileVersion = 1;

export type SqliteUsageStoreOptions = {
  path?: string;
  directory?: string;
  maxRecords?: number;
  /** An existing `usage.json` to import once, when the database is empty. */
  migrateFrom?: string;
};

export class SqliteUsageStore implements UsageStore {
  private readonly db: SqliteDatabase;
  private readonly maxRecords: number;
  private readonly migrateFrom?: string;
  private records: UsageRecord[] = [];
  private sequence = 0;
  private loaded = false;
  private dirty = false;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(DatabaseSync: DatabaseSyncCtor, options: SqliteUsageStoreOptions = {}) {
    const path = options.path ?? join(options.directory ?? defaultConnectionDirectory(), 'usage.db');
    const max = options.maxRecords ?? defaultMaxUsageRecords;
    if (!Number.isInteger(max) || max < 1) throw new Error('maxRecords must be a positive integer.');
    this.maxRecords = max;
    this.migrateFrom = options.migrateFrom;
    this.db = new DatabaseSync(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, json TEXT NOT NULL)');
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const rows = this.db.prepare('SELECT json FROM records ORDER BY seq DESC').all();
    this.records = rows
      .map((row) => {
        try {
          return JSON.parse(String(row.json)) as unknown;
        } catch {
          return undefined;
        }
      })
      .filter(isUsageRecord)
      .slice(0, this.maxRecords)
      .map(normalizeRecord);
    this.sequence = highestSequence(this.records);

    // One-time migration from the JSON store, only when the database has nothing yet.
    if (this.records.length === 0 && this.migrateFrom) {
      const text = await readOptionalText(this.migrateFrom, maxUsageFileBytes);
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { records?: unknown }).records)) {
            this.records = (parsed as { records: unknown[] }).records
              .filter(isUsageRecord)
              .slice(0, this.maxRecords)
              .map(normalizeRecord);
            this.sequence = highestSequence(this.records);
            if (this.records.length > 0) this.persist();
          }
        } catch {
          // A corrupt JSON file must not stop the gateway; the database stays empty and is written on demand.
        }
      }
    }
    this.loaded = true;
  }

  /** Writes the whole bounded set in one transaction — the durable equivalent of the JSON store's atomicWrite. */
  private persist(): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM records');
      const insert = this.db.prepare('INSERT INTO records (seq, id, json) VALUES (?, ?, ?)');
      // Newest first in memory; give the newest the highest seq so ORDER BY seq DESC reproduces that order.
      this.records.forEach((record, index) => {
        insert.run(this.records.length - index, record.id, JSON.stringify(record));
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async record(entry: Omit<UsageRecord, 'id'>): Promise<UsageRecord> {
    return this.withMutation(async () => {
      await this.ensureLoaded();
      this.sequence += 1;
      const record = normalizeRecord({ ...entry, id: `req_${this.sequence.toString(36)}` });
      this.records.unshift(record);
      if (this.records.length > this.maxRecords) this.records.length = this.maxRecords;
      this.dirty = true;
      this.scheduleFlush();
      return record;
    });
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch(() => { this.dirty = true; });
    }, 250);
    this.flushTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await this.withMutation(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      try {
        this.persist();
      } catch (error) {
        this.dirty = true;
        throw error;
      }
    });
  }

  async list(query: UsageQuery = {}): Promise<UsageRecord[]> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return selectUsageRecords(this.records, query);
  }

  async summary(query: UsageQuery = {}): Promise<UsageSummary> {
    await this.mutationQueue;
    await this.ensureLoaded();
    const records = selectUsageRecords(this.records, { ...query, limit: this.maxRecords });
    return { totals: summarizeUsage(records), records };
  }

  async size(): Promise<number> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return this.records.length;
  }

  async clear(): Promise<void> {
    await this.withMutation(async () => {
      await this.ensureLoaded();
      this.records = [];
      this.sequence = 0;
      this.dirty = false;
      this.persist();
    });
  }

  async exportState(): Promise<UsageBackupState> {
    await this.mutationQueue;
    await this.ensureLoaded();
    return { version: usageFileVersion, records: this.records.map((record) => ({ ...record })) };
  }

  async importState(state: UsageBackupState): Promise<void> {
    const next = parseUsageState(state);
    return this.withMutation(async () => {
      await this.ensureLoaded();
      this.records = next.records.slice(0, this.maxRecords);
      this.sequence = highestSequence(this.records);
      this.persist();
    });
  }

  /** Releases the database handle. The JSON store has no equivalent; the gateway calls it on close if present. */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

export type UsageBackend = 'json' | 'sqlite';

/**
 * Builds the usage store for the configured backend. SQLite is attempted only when asked for, and any
 * failure to load the driver (an older Node, a restricted runtime) falls back to the JSON store — the
 * gateway must always start. The JSON file is passed as the migration source so an existing history is
 * carried into the database on first run.
 */
export function createUsageStore(options: { directory?: string; backend?: UsageBackend; maxRecords?: number } = {}): UsageStore {
  const directory = options.directory ?? defaultConnectionDirectory();
  const maxRecords = options.maxRecords;
  if (options.backend === 'sqlite') {
    try {
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
      return new SqliteUsageStore(DatabaseSync, {
        directory,
        maxRecords,
        migrateFrom: join(directory, 'usage.json'),
      });
    } catch {
      // node:sqlite absent or unavailable — fall through to the JSON default rather than fail to start.
    }
  }
  return new LocalUsageStore({ directory, maxRecords });
}
