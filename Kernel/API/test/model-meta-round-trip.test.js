import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LocalConnectionStore } from '../dist/src/index.js';
import { modelMetaFor } from '../dist/src/core/connection-manager.js';

/**
 * Everything a catalog told us survives a save, a restart and a refresh. The old store kept five keys
 * (`n/c/i/o/p`) and dropped descriptions, max output, reasoning, aliases and the extra prices; a sparse
 * price array was also compacted from the left, so an output-only price became an input price.
 */

const connection = (modelMeta) => ({
  id: 'rich',
  providerId: 'fake',
  name: 'Rich catalog',
  endpoint: 'https://fake.example/v1',
  priority: 1,
  enabled: true,
  proxyPool: 'none',
  modelPolicy: 'all',
  modelIds: ['vendor/model'],
  customModelIds: [],
  ...(modelMeta ? { modelMeta } : {}),
  resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 },
});

async function roundTrip(t, modelMeta) {
  const dir = mkdtempSync(join(tmpdir(), 'oh-model-meta-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory: dir });
  await store.save(connection(modelMeta), { type: 'none' });
  const loaded = await store.list();
  return loaded.find((record) => record.id === 'rich')?.modelMeta?.['vendor/model'];
}

test('every catalog field survives the store round trip', async (t) => {
  const full = modelMetaFor([{
    id: 'vendor/model',
    providerId: 'fake',
    displayName: 'Vendor Model',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    description: 'A richly described model.',
    aliases: ['vendor/model-1', 'vm'],
    createdAt: '2026-01-02T00:00:00.000Z',
    knowledgeCutoff: '2025-06',
    expiresAt: '2027-01-01T00:00:00.000Z',
    status: 'active',
    canonicalSlug: 'vendor/model',
    tokenizer: 'o200k',
    supportedParameters: ['tools', 'temperature'],
    reasoning: { defaultEnabled: true, mandatory: false, defaultEffort: 'medium', supportedEfforts: ['low', 'high'] },
    source: 'provider',
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    pricing: { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5, cacheWritePer1M: 4 },
  }]);
  const meta = await roundTrip(t, full);
  assert.equal(meta.n, 'Vendor Model');
  assert.equal(meta.c, 1_000_000);
  assert.equal(meta.mo, 128_000);
  assert.equal(meta.d, 'A richly described model.');
  assert.deepEqual(meta.a, ['vendor/model-1', 'vm']);
  assert.equal(meta.cr, '2026-01-02T00:00:00.000Z');
  assert.equal(meta.kc, '2025-06');
  assert.equal(meta.ex, '2027-01-01T00:00:00.000Z');
  assert.equal(meta.st, 'active');
  assert.equal(meta.cs, 'vendor/model');
  assert.equal(meta.tk, 'o200k');
  assert.deepEqual(meta.sp, ['tools', 'temperature']);
  assert.deepEqual(meta.rs, { de: true, ma: false, eff: 'medium', efforts: ['low', 'high'] });
  assert.equal(meta.src, 'provider');
  assert.deepEqual(meta.i, ['text', 'image']);
  assert.deepEqual(meta.o, ['text']);
  assert.deepEqual(meta.p, [2, 8, 0.5, 4]);
});

test('a stated zero price is kept, and a sparse price never shifts dimensions', async (t) => {
  const free = await roundTrip(t, modelMetaFor([{
    id: 'vendor/model', providerId: 'fake',
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  }]));
  assert.deepEqual(free.p, [0, 0, null, null], 'zero is a stated price; absent slots stay null');

  const outputOnly = await roundTrip(t, {
    'vendor/model': { p: [null, 5, null, null] },
  });
  assert.deepEqual(outputOnly.p, [null, 5, null, null], 'an output-only price must not become an input price');
});

test('a missing field stays missing; nothing is invented', async (t) => {
  const meta = await roundTrip(t, modelMetaFor([{ id: 'vendor/model', providerId: 'fake' }]));
  assert.equal(meta, undefined, 'an empty catalog entry writes no metadata at all');
});
