import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeStateDatabases,
  createStateDocument,
  readStateEvents,
} from '../dist/src/core/state-document.js';

/**
 * The state document is the seam the eleven stores move onto.
 *
 * It keeps each store's JSON shape, but the bytes can live in a file or in SQLite. These tests hold the
 * two properties the migration depends on: a JSON vault upgrades once and never reads the stale file
 * again, and every write leaves a journal row that names the document and a digest, never its payload.
 */

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omni-state-'));
  t.after(async () => {
    closeStateDatabases();
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('the JSON backend is still a plain file at the named path', async (t) => {
  const directory = await tempDir(t);
  const path = join(directory, 'custom.json');
  const document = createStateDocument({ directory, name: 'custom', path });
  await document.write('{"ok":true}\n');
  assert.equal(await document.read(), '{"ok":true}\n');
  assert.equal(await readFile(path, 'utf8'), '{"ok":true}\n');
  assert.deepEqual(readStateEvents(directory), [], 'the JSON backend does not open a SQLite journal');
});

test('a SQLite document reads back after the database is closed and reopened', async (t) => {
  const directory = await tempDir(t);
  const first = createStateDocument({ directory, name: 'workspaces', backend: 'sqlite' });
  assert.equal(await first.read(), undefined);
  await first.write('{"version":1,"workspaces":[]}\n');
  assert.equal(await first.read(), '{"version":1,"workspaces":[]}\n');

  closeStateDatabases();
  const reopened = createStateDocument({ directory, name: 'workspaces', backend: 'sqlite' });
  assert.equal(await reopened.read(), '{"version":1,"workspaces":[]}\n');
});

test('an existing JSON file is imported once, and cannot overwrite the migrated row later', async (t) => {
  const directory = await tempDir(t);
  const jsonPath = join(directory, 'workspaces.json');
  const original = '{"version":1,"workspaces":[{"id":"one"}]}\n';
  await writeFile(jsonPath, original, 'utf8');

  const first = createStateDocument({ directory, name: 'workspaces', backend: 'sqlite' });
  assert.equal(await first.read(), original, 'the first read imports the JSON file');
  closeStateDatabases();

  // A stale file is still on disk — an old process, a backup restore, a hand edit. The row wins.
  await writeFile(jsonPath, '{"version":1,"workspaces":[{"id":"stale"}]}\n', 'utf8');
  const second = createStateDocument({ directory, name: 'workspaces', backend: 'sqlite' });
  assert.equal(await second.read(), original);
});

test('every write appends a journal row with the document name, size and digest', async (t) => {
  const directory = await tempDir(t);
  const document = createStateDocument({ directory, name: 'skills', backend: 'sqlite' });
  const value = '{"version":1,"skills":[]}\n';
  await document.write(value);
  const events = readStateEvents(directory);
  assert.equal(events.length, 1);
  assert.equal(events[0].collection, 'skills');
  assert.equal(events[0].bytes, Buffer.byteLength(value, 'utf8'));
  assert.equal(events[0].digest, createHash('sha256').update(value).digest('hex'));
  assert.equal(JSON.stringify(events[0]).includes('skills":[]'), false, 'the journal must not carry the payload');
});

test('an explicit path always means a JSON file, even when SQLite is selected', async (t) => {
  const directory = await tempDir(t);
  const path = join(directory, 'fixture.json');
  const document = createStateDocument({ directory, name: 'fixture', path, backend: 'sqlite' });
  await document.write('fixture\n');
  assert.equal(await readFile(path, 'utf8'), 'fixture\n');
  assert.deepEqual(readStateEvents(directory), []);
});

test('the backend is opt-in by environment, so the default vault format is unchanged', async (t) => {
  const directory = await tempDir(t);
  const defaultDocument = createStateDocument({ directory, name: 'api-keys', env: {} });
  await defaultDocument.write('{}\n');
  assert.equal(await readFile(join(directory, 'api-keys.json'), 'utf8'), '{}\n');

  const sqliteDocument = createStateDocument({ directory, name: 'api-keys', env: { OMNIHILBRAS_STATE_BACKEND: 'sqlite' } });
  await sqliteDocument.write('{"sqlite":true}\n');
  assert.equal(await sqliteDocument.read(), '{"sqlite":true}\n');
  assert.ok(readStateEvents(directory).length >= 1);
});