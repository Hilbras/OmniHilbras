import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResponseCache, stableStringify } from '../dist/src/core/response-cache.js';
import { createStateDocument } from '../dist/src/core/state-document.js';

test('the key is canonical and covers the whole request', () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }));
  const cache = new ResponseCache({ ttlMs: 1_000 });
  const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0 };
  assert.notEqual(cache.keyFor(base), cache.keyFor({ ...base, tools: [{ name: 't' }] }), 'tools are not part of the key');
  assert.notEqual(cache.keyFor(base), cache.keyFor({ ...base, responseFormat: { type: 'json_object' } }));
  assert.notEqual(cache.keyFor(base), cache.keyFor({ ...base, seed: 1 }));
});

test('a hit expires and a miss is counted', async () => {
  let now = 1_000;
  const cache = new ResponseCache({ ttlMs: 500, now: () => now });
  cache.set('k', { answer: 42 });
  assert.deepEqual(cache.get('k'), { answer: 42 });
  assert.equal(cache.stats.hits, 1);
  now += 600;
  assert.equal(cache.get('k'), undefined);
  assert.equal(cache.stats.misses, 1);
});

test('a persisted cache survives a restart, and cleared entries do not', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omni-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const document = createStateDocument({ directory, name: 'cache-test' });
  const first = new ResponseCache({ ttlMs: 60_000, document, flushDelayMs: 0 });
  await first.ready();
  first.set('k', { answer: 'kept' });
  await first.flush();

  const reopened = new ResponseCache({ ttlMs: 60_000, document, flushDelayMs: 0 });
  await reopened.ready();
  assert.deepEqual(reopened.get('k'), { answer: 'kept' });
  await reopened.clear();
  const third = new ResponseCache({ ttlMs: 60_000, document, flushDelayMs: 0 });
  await third.ready();
  assert.equal(third.get('k'), undefined);
});
