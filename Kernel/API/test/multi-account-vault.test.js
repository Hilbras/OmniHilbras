import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryConnectionStore, LocalConnectionStore } from '../dist/src/index.js';

/**
 * Two accounts of one provider, and the three ways the vault used to destroy the wrong one.
 *
 * Credentials are keyed by **connection id**, but three operations still keyed them by `providerId`:
 * `remove()`, the `save()` rollback, and `load()`. For a single connection the two strings are the
 * same, which is why every existing test passed. The moment a second account exists they diverge, and
 * each defect deleted a credential belonging to an account the user did not touch.
 */

const primary = {
  id: 'opencode',
  providerId: 'opencode',
  name: 'Primary',
  endpoint: 'https://opencode.ai/zen/v1',
  priority: 1,
  proxyPool: 'none',
};
const secondary = {
  id: 'opencode-backup',
  providerId: 'opencode',
  name: 'Backup',
  endpoint: 'https://opencode.ai/zen/v1',
  priority: 2,
  proxyPool: 'none',
};

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-multi-account-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('removing a secondary account keeps the primary credential, in both stores', async (t) => {
  for (const [label, makeStore] of [
    ['InMemoryConnectionStore', () => new InMemoryConnectionStore()],
    ['LocalConnectionStore', (directory) => new LocalConnectionStore({ directory })],
  ]) {
    await withDirectory(async (directory) => {
      t.diagnostic(label);
      const store = makeStore(directory);
      await store.save(primary, { type: 'api-key', value: 'key-A' });
      await store.save(secondary, { type: 'api-key', value: 'key-B' });

      assert.equal(await store.remove('opencode-backup'), true);
      assert.deepEqual(await store.get('opencode'), { type: 'api-key', value: 'key-A' }, `${label}: primary survived`);
      assert.equal(await store.get('opencode-backup'), undefined, `${label}: removed account is gone`);

      if (label === 'LocalConnectionStore') {
        const reopened = new LocalConnectionStore({ directory });
        assert.deepEqual(await reopened.get('opencode'), { type: 'api-key', value: 'key-A' }, `${label}: and survived a restart`);
      }
    });
  }
});

test('a failed save of a secondary account rolls back by connection id', async () => {
  await withDirectory(async (directory) => {
    const store = new LocalConnectionStore({ directory });
    await store.save(primary, { type: 'api-key', value: 'key-A' });

    // The metadata write is the second half of `save`; failing it exercises the rollback without
    // needing a real disk fault.
    store.persistMetadata = async () => {
      throw new Error('simulated metadata failure');
    };
    await assert.rejects(() => store.save(secondary, { type: 'api-key', value: 'key-B' }));
    assert.deepEqual(await store.get('opencode'), { type: 'api-key', value: 'key-A' }, 'the primary credential is untouched');
  });
});

test('a secondary connection keeps hasCredential across a metadata write and two restarts', async () => {
  await withDirectory(async (directory) => {
    const first = new LocalConnectionStore({ directory });
    await first.save(primary, { type: 'api-key', value: 'key-A' });
    await first.save(secondary, { type: 'api-key', value: 'key-B' });

    const second = new LocalConnectionStore({ directory });
    const before = (await second.list()).find((connection) => connection.id === 'opencode-backup');
    assert.equal(before?.hasCredential, true, 'load resolves the credential by connection id');

    // Any metadata write persisted the record. When the flag was derived from the provider id this
    // wrote `hasCredential: false`, and the following load pruned the credential as an orphan.
    await second.setEnabled('opencode-backup', false);

    const third = new LocalConnectionStore({ directory });
    assert.deepEqual(await third.get('opencode-backup'), { type: 'api-key', value: 'key-B' }, 'the secondary credential survived');
    assert.deepEqual(await third.get('opencode'), { type: 'api-key', value: 'key-A' }, 'the primary credential survived');
  });
});
