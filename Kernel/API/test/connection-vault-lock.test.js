import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectionStore } from '../dist/src/core/connections.js';
import { withFileLock } from '../dist/src/core/secure-store.js';

/**
 * One vault, two gateways.
 *
 * The desktop app and the CLI can both hold a gateway open on the same state directory. Each process
 * keeps its own in-memory maps, so the defect is not a torn file — `atomicWrite` already prevented
 * that — it is a lost update: a second save rewrites the metadata from the copy it loaded before the
 * first save, and every connection it did not touch disappears.
 *
 * The store now takes an interprocess lock and reloads when the files changed since its last read or
 * write. These tests hold the sequence that failed: both stores load, then each saves a different
 * connection. Without the reload, the second save leaves one connection; with it, both survive.
 */

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omni-vault-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const save = (store, id) => store.save(
  { id, providerId: id, name: id, endpoint: `https://${id}.example/v1`, priority: 1, proxyPool: 'none' },
  { type: 'api-key', value: `key-${id}` },
);

test('a save from a second process does not erase the first process\'s connection', async (t) => {
  const directory = await tempDir(t);
  const desktop = new LocalConnectionStore({ directory });
  const cli = new LocalConnectionStore({ directory });

  // Both processes start with the same empty vault. This is the shape that lost the update: each has
  // its own maps, and neither knew the other was about to write.
  assert.deepEqual(await desktop.list(), []);
  assert.deepEqual(await cli.list(), []);

  await save(desktop, 'desktop-account');
  await save(cli, 'cli-account');

  const reopened = new LocalConnectionStore({ directory });
  const ids = (await reopened.list()).map((connection) => connection.id).sort();
  assert.deepEqual(ids, ['cli-account', 'desktop-account'], 'one save overwrote the other process\'s connection');
});

test('concurrent saves through two stores both reach disk', async (t) => {
  const directory = await tempDir(t);
  const first = new LocalConnectionStore({ directory });
  const second = new LocalConnectionStore({ directory });
  await first.list();
  await second.list();

  await Promise.all([save(first, 'one'), save(second, 'two')]);

  const reopened = new LocalConnectionStore({ directory });
  assert.deepEqual((await reopened.list()).map((connection) => connection.id).sort(), ['one', 'two']);
});

test('a read in another process sees a save without a restart', async (t) => {
  const directory = await tempDir(t);
  const writer = new LocalConnectionStore({ directory });
  const reader = new LocalConnectionStore({ directory });
  await reader.list();

  await save(writer, 'fresh');

  assert.deepEqual((await reader.list()).map((connection) => connection.id), ['fresh'], 'the reader stayed on its startup copy');
});

test('a save waits for a lock another holder has not released', async (t) => {
  const directory = await tempDir(t);
  const store = new LocalConnectionStore({ directory });
  let release;
  const held = withFileLock(join(directory, 'vault.lock'), () => new Promise((resolve) => { release = resolve; }));
  // Give the holder a turn to create the file before starting the save.
  await new Promise((resolve) => setTimeout(resolve, 50));

  let settled = false;
  const pending = save(store, 'waiting').finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(settled, false, 'the save ran while another holder had the lock');

  release();
  await held;
  await pending;
  assert.deepEqual((await store.list()).map((connection) => connection.id), ['waiting']);
});

test('the lock is removed after a mutation, and is not left for the next save', async (t) => {
  const directory = await tempDir(t);
  const store = new LocalConnectionStore({ directory });
  await save(store, 'acct');
  await assert.rejects(access(join(directory, 'vault.lock')), (error) => error.code === 'ENOENT', 'the lock file survived a completed save');
});

test('an abandoned lock is broken once its holder is gone or its age is past the limit', async (t) => {
  const directory = await tempDir(t);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, 'vault.lock');
  // A live pid with an old mtime: the age backstop is what stops a recycled pid from holding a vault
  // forever. Two minutes is far longer than any vault write, and this is three.
  await writeFile(lockPath, `${process.pid} deadbeef\n`, { mode: 0o600 });
  const old = new Date(Date.now() - 180_000);
  await utimes(lockPath, old, old);

  const store = new LocalConnectionStore({ directory });
  await save(store, 'after-stale-lock');

  assert.deepEqual((await store.list()).map((connection) => connection.id), ['after-stale-lock']);
  await assert.rejects(access(lockPath), (error) => error.code === 'ENOENT');
});

test('the lock belongs to the vault directory, not the whole state directory', async (t) => {
  const root = await tempDir(t);
  const one = new LocalConnectionStore({ directory: join(root, 'one') });
  const two = new LocalConnectionStore({ directory: join(root, 'two') });
  await Promise.all([save(one, 'a'), save(two, 'b')]);

  assert.equal((await readFile(join(root, 'one', 'vault.lock'), 'utf8').catch(() => 'missing')), 'missing');
  assert.deepEqual((await one.list()).map((connection) => connection.id), ['a']);
  assert.deepEqual((await two.list()).map((connection) => connection.id), ['b']);
});