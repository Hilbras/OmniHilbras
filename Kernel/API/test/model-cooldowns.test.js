import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HealthRegistry, LocalConnectionStore } from '../dist/src/index.js';

/**
 * Cooldowns survive a restart, and they grow while an account keeps refusing.
 *
 * Both halves were missing before this, and each caused a real symptom:
 *
 * - The cooldown lived in a `Map` inside the running process, and this process restarts on every
 *   release — so an account that had just been told to wait was eligible again immediately, and the
 *   first request after each restart re-hammered it. The reference implementation keeps its
 *   `modelLock_*` fields in the database for exactly this reason.
 * - The wait was a flat 60 s and the level never reset, so the ladder could not climb and a pair that
 *   had succeed since still waited out a cooldown it had already disproved.
 */

const connection = (id) => ({
  id,
  providerId: 'p',
  name: id,
  endpoint: 'https://p.example/v1',
  priority: 1,
  proxyPool: 'none',
});

const tempStore = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cooldowns-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new LocalConnectionStore({ directory }) };
};

test('a cooldown written before a restart is still in force after it', async (t) => {
  const { directory, store } = await tempStore(t);
  await store.save(connection('acct-1'), { type: 'api-key', value: 'k' });

  const before = new HealthRegistry(Date.now);
  before.recordModelRateLimit('acct-1', 'glm-5.3', {});
  const written = before.cooldowns();
  for (const [key, cooldown] of Object.entries(written)) await store.setCooldown(key, cooldown);
  assert.equal(Object.keys(written).length, 1, 'the refusal was recorded');

  // A second store over the same directory is what a restart looks like: no shared memory.
  const reopened = new LocalConnectionStore({ directory });
  const after = new HealthRegistry(Date.now);
  after.seedModelCooldowns(await reopened.listCooldowns());
  assert.equal(after.isModelCoolingDown('acct-1', 'glm-5.3'), true, 'the account is still stood down');
  assert.equal(after.isModelCoolingDown('acct-1', 'another-model'), false, 'and only for that model');
});

test('the wait grows with each consecutive refusal and stops when the account answers', () => {
  let now = 1_000_000;
  const registry = new HealthRegistry(() => now);
  const waits = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = now;
    registry.recordModelRateLimit('acct-1', 'm', {});
    const cooldown = registry.cooldowns()['acct-1:m'];
    waits.push(cooldown.until - before);
  }
  // 1 min, 2, 4, 8 — the reference implementation's ladder, on a 60 s base rather than their 2 s.
  assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000]);

  // A success ends the sequence: the next refusal starts the ladder again rather than continuing it.
  registry.clearModelCooldown('acct-1', 'm');
  assert.equal(registry.isModelCoolingDown('acct-1', 'm'), false, 'answering clears the cool-down');
  now += 60_000;
  registry.recordModelRateLimit('acct-1', 'm', {});
  assert.equal(registry.cooldowns()['acct-1:m'].until - now, 60_000, 'the ladder restarts at the base');
});

test('the ladder is capped, and a provider-stated reset time is believed instead', () => {
  let now = 1_000_000;
  const registry = new HealthRegistry(() => now);
  for (let attempt = 0; attempt < 20; attempt += 1) registry.recordModelRateLimit('acct-1', 'm', {});
  const capped = registry.cooldowns()['acct-1:m'];
  assert.equal(capped.until - now, 30 * 60_000, 'the ceiling holds however often it refuses');

  // `Retry-After` is better information than a guess about how often to retry.
  now += 1;
  registry.recordModelRateLimit('acct-2', 'm', { retryAfterMs: 5_000 });
  assert.equal(registry.cooldowns()['acct-2:m'].until - now, 5_000);
  // …and an absurd header cannot park a model for hours.
  registry.recordModelRateLimit('acct-3', 'm', { retryAfterMs: 24 * 60 * 60_000 });
  assert.equal(registry.cooldowns()['acct-3:m'].until - now, 30 * 60_000, 'capped');
});

test('an expired cooldown is dropped rather than accumulating in the vault', async (t) => {
  const { directory, store } = await tempStore(t);
  await store.setCooldown('acct-1:m', { until: Date.now() - 1, level: 1 });
  await store.setCooldown('acct-2:m', { until: Date.now() + 60_000, level: 1 });
  const live = await store.listCooldowns();
  assert.deepEqual(Object.keys(live), ['acct-2:m'], 'the expired one is not state, it is a line in a file');
});

test('a malformed cooldown does not make the vault unopenable', async (t) => {
  const { directory, store } = await tempStore(t);
  await store.save(connection('acct-1'), { type: 'api-key', value: 'k' });
  await store.setCooldown('acct-1:m', { until: Date.now() + 60_000, level: 1 });

  const { readFile, writeFile } = await import('node:fs/promises');
  const path = join(directory, 'connections.json');
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  // One entry of the wrong shape, as an older or hand-edited file might hold.
  parsed.cooldowns['acct-1:broken'] = 'not an object';
  parsed.cooldowns['acct-1:noUntil'] = { level: 3 };
  await writeFile(path, JSON.stringify(parsed));

  const reopened = new LocalConnectionStore({ directory });
  assert.deepEqual(Object.keys(await reopened.listCooldowns()), ['acct-1:m'], 'the good entry survives, the bad one is dropped');
  assert.equal((await reopened.list()).length, 1, 'and the connections are untouched');
});
