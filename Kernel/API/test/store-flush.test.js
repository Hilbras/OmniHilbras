import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectionStore, LocalUsageStore } from '../dist/src/index.js';

/**
 * Coalesced counters still reach disk when flushed.
 *
 * The per-request write was replaced by an in-memory counter plus a debounced flush. The failure this
 * guards is the one that would make the change invisible: counters that look right for the life of
 * the process and vanish on restart.
 */

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omni-flush-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('connection usage counters survive a restart after a flush', async (t) => {
  const directory = await tempDir(t);
  const store = new LocalConnectionStore({ directory });
  await store.save({
    id: 'acct-1', providerId: 'p', name: 'Account', endpoint: 'https://p.example/v1',
    priority: 1, proxyPool: 'none', enabled: true, modelIds: ['m'],
  }, { type: 'api-key', value: 'key' });

  for (let index = 0; index < 25; index += 1) await store.recordUsage('acct-1');
  await store.flushUsage();

  const reopened = new LocalConnectionStore({ directory });
  const [record] = await reopened.list();
  assert.equal(record?.requestCount, 25, 'the coalesced counter was lost');
  assert.ok(record?.lastUsed, 'the last-used stamp was lost');
});

test('usage records survive a restart after a flush', async (t) => {
  const directory = await tempDir(t);
  const store = new LocalUsageStore({ directory });
  await store.record({ at: new Date().toISOString(), model: 'm', providerId: 'p', outcome: 'success', attempts: 1, latencyMs: 10 });
  await store.flush();

  const reopened = new LocalUsageStore({ directory });
  assert.equal((await reopened.list()).length, 1, 'the coalesced usage record was lost');
});
