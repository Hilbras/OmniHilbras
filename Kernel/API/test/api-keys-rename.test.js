import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { LocalApiKeyStore } from '../dist/src/index.js';

/**
 * Two things a key could not say about itself before 3.63.0: what it is called when the name turns out to be wrong,
 * and how much it has actually been used.
 *
 * The page showed "Last used" from a real field, and nothing else. A rename had no route at all — the only way to
 * change a name was to mint a new key and revoke the old one, which invalidates every client using it. And "how many
 * requests did this key serve" was unanswerable, the same gap that made provider cards claim `requests: 0` forever.
 */

async function temporaryKeyStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-rename-'));
  const opened = [];
  t.after(async () => {
    for (const store of opened) await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    open: (options = {}) => {
      const store = new LocalApiKeyStore({ directory, ...options });
      opened.push(store);
      return store;
    },
  };
}

test('a rename changes the name and nothing a client depends on', async (t) => {
  const { directory, open } = await temporaryKeyStore(t);
  const store = open({ lastUsedFlushIntervalMs: 0 });
  const created = await store.create('Prod Cli');

  const renamed = await store.rename(created.record.id, '  Cline on the laptop  ');

  assert.equal(renamed.name, 'Cline on the laptop', 'the name was not trimmed, or not changed');
  assert.equal(renamed.prefix, created.record.prefix, 'the prefix moved, which means the secret did');
  assert.equal(renamed.enabled, created.record.enabled, 'a rename changed whether the key works');
  assert.equal(renamed.updatedAt >= created.record.updatedAt, true, 'updatedAt did not move');

  // The secret still authenticates, which is the whole point of renaming instead of re-minting.
  assert.equal((await store.authenticate(created.key))?.name, 'Cline on the laptop', 'the key stopped working after the rename');
  const file = await readFile(join(directory, 'api-keys.json'), 'utf8');
  assert.equal(file.includes(created.key), false, 'the rename wrote the secret to disk');
});

test('renaming a key that is not there is not silently a success', async (t) => {
  const { open } = await temporaryKeyStore(t);
  const store = open({ lastUsedFlushIntervalMs: 0 });
  assert.equal(await store.rename('key_missing', 'Anything'), undefined, 'an unknown id produced a record');
});

test('every authenticated call counts, and the count survives a restart', async (t) => {
  const { open } = await temporaryKeyStore(t);
  const first = open({ lastUsedFlushIntervalMs: 0 });
  const created = await first.create('Metered');

  assert.equal(created.record.requests, 0, 'a new key already claims traffic');

  for (let i = 0; i < 3; i += 1) {
    const matched = await first.authenticate(created.key);
    assert.equal(matched.requests, i + 1, 'the counter did not move with the call it counted');
  }
  // A key that does not match must not count against one that does.
  await first.authenticate('ohk_not-a-real-key');
  await first.close();

  const reopened = open({ lastUsedFlushIntervalMs: 0 });
  const [after] = await reopened.list();
  assert.equal(after.requests, 3, 'the count did not reach the file');
});

test('a key file written before the counter existed still loads, at zero', async (t) => {
  const { directory, open } = await temporaryKeyStore(t);
  const store = open({ lastUsedFlushIntervalMs: 0 });
  const created = await store.create('Older file');
  await store.close();

  // Rewrite the file the way the previous version wrote it: no `requests` field at all.
  const path = join(directory, 'api-keys.json');
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  for (const key of parsed.keys) delete key.requests;
  await writeFile(path, JSON.stringify(parsed));

  const reopened = open({ lastUsedFlushIntervalMs: 0 });
  const [record] = await reopened.list();
  assert.equal(record.id, created.record.id);
  assert.equal(record.requests, 0, 'an absent counter was not read as zero');
});
