import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectionStore } from '../dist/src/core/connections.js';
import { closeStateDatabases, readStateEvents } from '../dist/src/core/state-document.js';

/**
 * The vault on the SQLite state backend.
 *
 * The lock and the refresh path are the parts that could quietly stop working when the bytes moved out
 * of `connections.json`: two stores still have to notice each other's save, and an existing JSON vault
 * still has to open. This exercises both against the real store rather than the document seam alone.
 */

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omni-vault-sqlite-'));
  t.after(async () => {
    closeStateDatabases();
    delete process.env.OMNIHILBRAS_STATE_BACKEND;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

const save = (store, id) => store.save(
  { id, providerId: id, name: id, endpoint: `https://${id}.example/v1`, priority: 1, proxyPool: 'none' },
  { type: 'api-key', value: `key-${id}` },
);

test('two stores on SQLite still see each other\'s save', async (t) => {
  const directory = await tempDir(t);
  process.env.OMNIHILBRAS_STATE_BACKEND = 'sqlite';
  const first = new LocalConnectionStore({ directory });
  const second = new LocalConnectionStore({ directory });
  await first.list();
  await second.list();

  await save(first, 'one');
  await save(second, 'two');

  assert.deepEqual((await first.list()).map((connection) => connection.id).sort(), ['one', 'two']);
  assert.deepEqual((await second.list()).map((connection) => connection.id).sort(), ['one', 'two']);
  assert.ok(readStateEvents(directory).some((event) => event.collection === 'connections'), 'the metadata write is journaled');
  assert.ok(readStateEvents(directory).some((event) => event.collection === 'secrets.enc'), 'the encrypted secrets write is journaled');
});

test('an existing JSON vault opens through the SQLite backend and keeps its credential', async (t) => {
  const directory = await tempDir(t);
  // First run on the default JSON backend, which is what a 3.x or early-4.x vault is.
  const jsonStore = new LocalConnectionStore({ directory });
  await save(jsonStore, 'legacy');
  const before = await jsonStore.get('legacy', 'legacy');
  assert.equal(before?.type, 'api-key');

  // The same directory, now with SQLite selected: the documents import on first read.
  closeStateDatabases();
  process.env.OMNIHILBRAS_STATE_BACKEND = 'sqlite';
  const sqliteStore = new LocalConnectionStore({ directory });
  const record = (await sqliteStore.list()).find((connection) => connection.id === 'legacy');
  assert.equal(record?.hasCredential, true, 'the migrated metadata still says it has a credential');
  const credential = await sqliteStore.get('legacy', 'legacy');
  assert.deepEqual(credential, before, 'the encrypted credential survived the move');
});

test('the credential is still unreadable from the SQLite row', async (t) => {
  const directory = await tempDir(t);
  process.env.OMNIHILBRAS_STATE_BACKEND = 'sqlite';
  const store = new LocalConnectionStore({ directory });
  await save(store, 'secret');
  closeStateDatabases();

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(directory, 'state.db'));
  const rows = db.prepare('SELECT value FROM documents WHERE name = ?').all('secrets.enc');
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].value).includes('key-secret'), false, 'the plaintext key reached the database row');
});