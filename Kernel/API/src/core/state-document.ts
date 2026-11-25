import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { atomicWrite, defaultStateDirectory, fileStamp, readOptionalText } from './secure-store.js';

/**
 * The durable document behind one local store.
 *
 * A store owns a JSON document today. This seam keeps that shape and lets the bytes live in a file or in
 * SQLite, so the eleven stores can adopt the state engine without each one inventing a schema. SQLite is
 * opt-in for the alpha line (`OMNIHILBRAS_STATE_BACKEND=sqlite`); JSON remains the default until the
 * migration has been exercised against every store.
 *
 * The document is deliberately opaque: the store still parses and validates its own shape. What the
 * backend adds is atomic replacement, a versioned container, and a durable event row per write. It does
 * **not** claim normalized tables or SQL analytics — that belongs to a later phase and to stores that
 * need it (usage already has one).
 */
export interface StateDocument {
  /** The bytes last written, or undefined when this store has never written. */
  read(maxBytes?: number): Promise<string | undefined>;
  /** Atomically replaces the document and appends a journal event. */
  write(value: string): Promise<void>;
  /** Identifies the current bytes, so a process can notice another process's write. */
  stamp(): Promise<string>;
}

export type StateBackend = 'json' | 'sqlite';

type SqliteStatement = {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Record<string, unknown>[];
};
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};
type DatabaseSyncCtor = new (path: string) => SqliteDatabase;

const requireNode = createRequire(import.meta.url);
const databases = new Map<string, SqliteStateDatabase>();

export function resolveStateBackend(env: Readonly<Record<string, string | undefined>> = process.env): StateBackend {
  return env.OMNIHILBRAS_STATE_BACKEND?.trim().toLowerCase() === 'sqlite' ? 'sqlite' : 'json';
}

/** A per-name JSON file, which is the shape every existing vault already has. */
class JsonStateDocument implements StateDocument {
  constructor(private readonly path: string) {}

  read(maxBytes = Number.POSITIVE_INFINITY) {
    return readOptionalText(this.path, maxBytes);
  }

  write(value: string) {
    return atomicWrite(this.path, value);
  }

  stamp() {
    return fileStamp(this.path);
  }
}

/**
 * One SQLite database per state directory, with one row per store document.
 *
 * `node:sqlite` is built into Node >=22.5 and is unavailable in some runtimes (including Electron
 * builds that do not expose it). The factory falls back to JSON rather than failing to start, which is
 * the same rule the usage store follows.
 */
class SqliteStateDatabase {
  private readonly db: SqliteDatabase;

  constructor(DatabaseSync: DatabaseSyncCtor, path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, digest TEXT NOT NULL DEFAULT \'\')');
    // A database opened by an earlier build has the table without the digest column. Adding it here is
    // the cheapest migration that keeps the stamp meaningful for every existing row.
    const columns = this.db.prepare('PRAGMA table_info(documents)').all();
    if (!columns.some((column) => column.name === 'digest')) {
      this.db.exec("ALTER TABLE documents ADD COLUMN digest TEXT NOT NULL DEFAULT ''");
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, collection TEXT NOT NULL, bytes INTEGER NOT NULL, digest TEXT NOT NULL)');
  }

  read(name: string, maxBytes: number): string | undefined {
    const rows = this.db.prepare('SELECT value FROM documents WHERE name = ?').all(name);
    const value = rows[0]?.value;
    if (typeof value !== 'string') return undefined;
    if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error('Local credential file is too large.');
    return value;
  }

  write(name: string, value: string) {
    const at = new Date().toISOString();
    const bytes = Buffer.byteLength(value, 'utf8');
    const digest = createHash('sha256').update(value).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO documents (name, value, updated_at, digest) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, digest = excluded.digest').run(name, value, at, digest);
      this.db.prepare('INSERT INTO events (at, collection, bytes, digest) VALUES (?, ?, ?, ?)').run(at, name, bytes, digest);
      // The journal is a replay window, not an audit archive. Ten thousand writes is days of ordinary
      // use and keeps a long-lived gateway from growing a second unbounded file beside the documents.
      this.db.exec('DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT 10000)');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  stamp(name: string) {
    const rows = this.db.prepare('SELECT updated_at, digest FROM documents WHERE name = ?').all(name);
    const row = rows[0];
    return row ? `${String(row.updated_at)}:${String(row.digest)}` : 'missing';
  }

  events(limit: number) {
    return this.db.prepare('SELECT seq, at, collection, bytes, digest FROM events ORDER BY seq DESC LIMIT ?').all(limit).reverse();
  }

  eventsSince(afterSeq: number, limit: number) {
    return this.db.prepare('SELECT seq, at, collection, bytes, digest FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(afterSeq, limit);
  }

  close() {
    this.db.close();
  }
}

function openDatabase(directory: string): SqliteStateDatabase | undefined {
  const path = join(directory, 'state.db');
  const existing = databases.get(path);
  if (existing) return existing;
  try {
    const { DatabaseSync } = requireNode('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
    const database = new SqliteStateDatabase(DatabaseSync, path);
    databases.set(path, database);
    return database;
  } catch {
    return undefined;
  }
}

class SqliteStateDocument implements StateDocument {
  constructor(
    private readonly database: SqliteStateDatabase,
    private readonly name: string,
    private readonly migrateFrom?: string,
  ) {}

  async read(maxBytes = Number.POSITIVE_INFINITY) {
    const current = this.database.read(this.name, maxBytes);
    if (current !== undefined) return current;
    if (!this.migrateFrom) return undefined;
    // One-time import of the JSON file this store wrote before the backend existed. A row already in
    // `documents` wins forever, so a stale file cannot overwrite a migrated store on a later start.
    const text = await readOptionalText(this.migrateFrom, maxBytes);
    if (text === undefined) return undefined;
    this.database.write(this.name, text);
    return text;
  }

  write(value: string) {
    this.database.write(this.name, value);
    return Promise.resolve();
  }

  stamp() {
    return Promise.resolve(this.database.stamp(this.name));
  }
}

export type StateDocumentOptions = {
  directory?: string;
  /** The document name, also the SQLite row key. The JSON filename is `<name>.json`. */
  name: string;
  /** An explicit JSON path, used by tests and by stores with a non-standard filename. */
  path?: string;
  backend?: StateBackend;
  env?: Readonly<Record<string, string | undefined>>;
};

/**
 * The document for one store.
 *
 * An explicit `path` always means a JSON file: tests and callers that name a file are asking for that
 * file, and silently moving their bytes into a database would make the fixture lie.
 */
export function createStateDocument(options: StateDocumentOptions): StateDocument {
  const directory = options.directory ?? defaultStateDirectory(options.env);
  const jsonPath = options.path ?? join(directory, `${options.name}.json`);
  const backend = options.backend ?? resolveStateBackend(options.env);
  if (backend === 'sqlite' && !options.path) {
    const database = openDatabase(directory);
    if (database) return new SqliteStateDocument(database, options.name, jsonPath);
  }
  return new JsonStateDocument(jsonPath);
}

/** Test and diagnostic view of the journal. The route that replays it lands with the event phase. */
export function readStateEvents(directory: string, limit = 50): Array<{ seq: number; at: string; collection: string; bytes: number; digest: string }> {
  const database = openDatabase(directory);
  if (!database) return [];
  const rows = database.events(limit);
  return rows.map((row) => ({
    seq: Number(row.seq),
    at: String(row.at),
    collection: String(row.collection),
    bytes: Number(row.bytes),
    digest: String(row.digest),
  }));
}

export function readStateEventsSince(directory: string, afterSeq: number, limit = 100): Array<{ seq: number; at: string; collection: string; bytes: number; digest: string }> {
  const database = openDatabase(directory);
  if (!database) return [];
  return database.eventsSince(afterSeq, limit).map((row) => ({
    seq: Number(row.seq),
    at: String(row.at),
    collection: String(row.collection),
    bytes: Number(row.bytes),
    digest: String(row.digest),
  }));
}

export function closeStateDatabases() {
  for (const database of databases.values()) database.close();
  databases.clear();
}