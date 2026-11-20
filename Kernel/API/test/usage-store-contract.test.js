import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalUsageStore, FORBIDDEN_RECORD_FIELDS } from '../dist/src/core/usage-store.js';
import { SqliteUsageStore, createUsageStore } from '../dist/src/core/usage-store-sqlite.js';

/**
 * One contract, two backends (Phase 3 of the full-system upgrade).
 *
 * The SQLite usage store is optional and JSON stays the default, so the guarantee that matters is that the
 * two answer **identically**: the same ids, ordering, query results, totals, bound, and backup round-trip.
 * This runs the same assertions against both implementations. SQLite is exercised only when `node:sqlite`
 * is present (Node ≥22.5); on an older runtime the factory falls back to JSON, which is itself asserted.
 */

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = undefined;
}

const entry = (overrides = {}) => ({
  at: '2026-10-04T10:00:00.000Z',
  model: 'claude-sonnet-4',
  providerId: 'anthropic',
  connectionId: 'conn-1',
  outcome: 'success',
  attempts: 1,
  latencyMs: 420,
  inputTokens: 1200,
  outputTokens: 340,
  ...overrides,
});

const backends = [
  { name: 'json', make: (dir) => new LocalUsageStore({ directory: dir }) },
  ...(DatabaseSync ? [{ name: 'sqlite', make: (dir) => new SqliteUsageStore(DatabaseSync, { directory: dir }) }] : []),
];

for (const backend of backends) {
  test(`[${backend.name}] records get unique monotonic ids and list newest-first`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `usage-${backend.name}-`));
    try {
      const store = backend.make(dir);
      const a = await store.record(entry({ model: 'first' }));
      const b = await store.record(entry({ model: 'second' }));
      assert.notEqual(a.id, b.id);
      const listed = await store.list();
      assert.equal(listed[0].model, 'second', 'newest first');
      assert.equal(listed[1].model, 'first');
      await store.flush?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`[${backend.name}] query filters by provider, model, outcome and limit`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `usage-${backend.name}-`));
    try {
      const store = backend.make(dir);
      await store.record(entry({ providerId: 'anthropic', model: 'a', outcome: 'success' }));
      await store.record(entry({ providerId: 'openai', model: 'b', outcome: 'failure', errorCode: 'RATE_LIMITED' }));
      await store.record(entry({ providerId: 'anthropic', model: 'a', outcome: 'cancelled' }));
      assert.equal((await store.list({ providerId: 'anthropic' })).length, 2);
      assert.equal((await store.list({ model: 'b' })).length, 1);
      assert.equal((await store.list({ outcome: 'failure' })).length, 1);
      assert.equal((await store.list({ limit: 1 })).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`[${backend.name}] summary totals match the records and mark unmeasured tokens`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `usage-${backend.name}-`));
    try {
      const store = backend.make(dir);
      await store.record(entry({ inputTokens: 100, outputTokens: 50 }));
      await store.record(entry({ outcome: 'failure', errorCode: 'X', inputTokens: undefined, outputTokens: undefined }));
      const summary = await store.summary();
      assert.equal(summary.totals.requests, 2);
      assert.equal(summary.totals.succeeded, 1);
      assert.equal(summary.totals.failed, 1);
      assert.equal(summary.totals.inputTokens, 100);
      assert.equal(summary.totals.outputTokens, 50);
      assert.equal(summary.totals.tokensUnmeasured, false, 'one record measured tokens');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`[${backend.name}] the store is bounded by maxRecords`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `usage-${backend.name}-`));
    try {
      const store = backend.name === 'json' ? new LocalUsageStore({ directory: dir, maxRecords: 3 }) : new SqliteUsageStore(DatabaseSync, { directory: dir, maxRecords: 3 });
      for (let index = 0; index < 6; index += 1) await store.record(entry({ model: `m${index}` }));
      await store.flush?.();
      assert.equal(await store.size(), 3);
      const listed = await store.list();
      assert.equal(listed[0].model, 'm5', 'the newest records are the ones kept');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`[${backend.name}] no forbidden field is ever stored`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `usage-${backend.name}-`));
    try {
      const store = backend.make(dir);
      const record = await store.record(entry());
      for (const forbidden of FORBIDDEN_RECORD_FIELDS) assert.ok(!Object.keys(record).includes(forbidden));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`[${backend.name}] export then import round-trips the records`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `usage-${backend.name}-`));
    try {
      const store = backend.make(dir);
      await store.record(entry({ model: 'a' }));
      await store.record(entry({ model: 'b' }));
      const state = await store.exportState();
      await store.clear();
      assert.equal(await store.size(), 0);
      await store.importState(state);
      const listed = await store.list();
      assert.equal(listed.length, 2);
      assert.equal(listed[0].model, 'b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`[${backend.name}] records survive a reopen`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `usage-${backend.name}-`));
    try {
      const first = backend.make(dir);
      await first.record(entry({ model: 'persisted' }));
      await first.flush?.();
      first.close?.();
      const second = backend.make(dir);
      const listed = await second.list();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].model, 'persisted');
      // ids continue past the highest seen, rather than restarting at 1
      const next = await second.record(entry({ model: 'after-reopen' }));
      assert.notEqual(next.id, listed[0].id);
      second.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('the factory defaults to JSON and only uses SQLite when asked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-factory-'));
  try {
    const json = createUsageStore({ directory: dir });
    assert.ok(json instanceof LocalUsageStore, 'the default backend is JSON');
    assert.ok(!existsSync(join(dir, 'usage.db')), 'no database file for the JSON default');
    if (DatabaseSync) {
      const sqlite = createUsageStore({ directory: dir, backend: 'sqlite' });
      assert.ok(sqlite instanceof SqliteUsageStore, 'sqlite backend selected when available');
      assert.ok(existsSync(join(dir, 'usage.db')), 'a database file is created');
      sqlite.close?.();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite imports an existing usage.json on first run', async (t) => {
  if (!DatabaseSync) return t.skip('node:sqlite unavailable');
  const dir = mkdtempSync(join(tmpdir(), 'usage-migrate-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'usage.json'), JSON.stringify({ version: 1, records: [{ ...entry(), id: 'req_1', model: 'from-json' }] }));
    const store = new SqliteUsageStore(DatabaseSync, { directory: dir, migrateFrom: join(dir, 'usage.json') });
    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].model, 'from-json');
    assert.equal(listed[0].id, 'req_1', 'the imported id is preserved');
    store.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
