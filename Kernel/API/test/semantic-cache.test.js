import assert from 'node:assert/strict';
import test from 'node:test';
import { SemanticCache, cosine, embedLocally } from '../dist/src/core/semantic-cache.js';

test('local embeddings are normalized and similar text scores higher than unrelated text', () => {
  const a = embedLocally('summarize the quarterly revenue report');
  const close = embedLocally('summarize the quarterly revenue report please');
  const far = embedLocally('write a poem about the sea');
  assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-9);
  assert.ok(cosine(a, close) > cosine(a, far));
});

test('the threshold decides a hit, and the entry expires', async () => {
  let now = 1_000;
  const cache = new SemanticCache({ threshold: 0.99, ttlMs: 100, now: () => now });
  await cache.set('summarize the quarterly revenue report', { answer: 'x' });
  assert.ok(await cache.get('summarize the quarterly revenue report'));
  assert.equal(await cache.get('write a poem about the sea'), undefined);
  now += 200;
  assert.equal(await cache.get('summarize the quarterly revenue report'), undefined);
});
