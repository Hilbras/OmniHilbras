import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdempotencyStore } from '../dist/src/core/idempotency.js';

test('a committed response survives a restart and replays by key', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-idem-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'idempotency.json');
  const first = new IdempotencyStore(path, () => 1_000);
  await first.commit('key-1', 'hash-a', { id: 'job-1' });
  assert.deepEqual(await first.lookup('key-1'), { hash: 'hash-a', value: { id: 'job-1' } });
  assert.equal((await stat(path)).mode & 0o077, 0, 'the replay ledger is owner-only');

  const restarted = new IdempotencyStore(path, () => 1_001);
  assert.deepEqual(await restarted.lookup('key-1'), { hash: 'hash-a', value: { id: 'job-1' } });
});

test('an expired entry is not replayed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-idem-exp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'idempotency.json');
  const store = new IdempotencyStore(path, () => 1_000, 100);
  await store.commit('old', 'hash', { id: 'job-old' });
  const later = new IdempotencyStore(path, () => 2_000, 100);
  assert.equal(await later.lookup('old'), undefined);
});