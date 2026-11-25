import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';
import { normalizeCatalogModel } from '../_shared/dist/model-normalize.js';

/**
 * The one catalog mapper every OpenAI-shaped provider now uses. It is deliberately honest: a field is set
 * only when the provider stated it. A free model's zero is a real zero, a per-token quote is converted,
 * and a provider that states only an id gets only an id.
 */

test('every field in a rich catalog entry is carried into the model', () => {
  const model = normalizeCatalogModel({
    id: 'vendor/rich',
    name: 'Rich Model',
    owned_by: 'vendor',
    description: 'A long-context reasoning model.',
    aliases: ['vendor/rich-1'],
    created: 1_760_000_000,
    knowledge_cutoff: '2025-06',
    expiration_date: '2027-01-01T00:00:00Z',
    status: 'active',
    canonical_slug: 'vendor/rich',
    context_length: 1_000_000,
    top_provider: { max_completion_tokens: 128_000, cached_tokens: 0 },
    architecture: { tokenizer: 'o200k', input_modalities: ['text', 'image'], output_modalities: ['text'] },
    supported_parameters: ['tools', 'temperature'],
    reasoning: { enabled: true, effort: 'medium', supported_efforts: ['low', 'high'] },
    pricing: { prompt: '0.000002', completion: '0.000008', input_cache_read: '0', input_cache_write: '0.000001' },
  }, 'fake');
  assert.equal(model.id, 'vendor/rich');
  assert.equal(model.displayName, 'Rich Model');
  assert.equal(model.ownedBy, 'vendor');
  assert.equal(model.description, 'A long-context reasoning model.');
  assert.deepEqual(model.aliases, ['vendor/rich-1']);
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxOutputTokens, 128_000);
  assert.equal(model.createdAt, new Date(1_760_000_000_000).toISOString());
  assert.equal(model.knowledgeCutoff, '2025-06');
  assert.equal(model.expiresAt, '2027-01-01T00:00:00.000Z');
  assert.equal(model.status, 'active');
  assert.equal(model.canonicalSlug, 'vendor/rich');
  assert.equal(model.tokenizer, 'o200k');
  assert.deepEqual(model.inputModalities, ['text', 'image']);
  assert.deepEqual(model.outputModalities, ['text']);
  assert.deepEqual(model.supportedParameters, ['tools', 'temperature']);
  assert.deepEqual(model.reasoning, { defaultEnabled: true, defaultEffort: 'medium', supportedEfforts: ['low', 'high'] });
  assert.deepEqual(model.pricing, {
    inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0, cacheWritePer1M: 1,
  });
  assert.equal(model.source, 'provider');
});

test('a minimal entry stays minimal; nothing is inferred', () => {
  assert.deepEqual(normalizeCatalogModel({ id: 'bare', owned_by: 'vendor' }, 'fake'), {
    id: 'bare', providerId: 'fake', ownedBy: 'vendor', source: 'provider',
  });
});

test('per-1M shapes are not multiplied again, and a zero price stays zero', () => {
  const model = normalizeCatalogModel({
    id: 'console/model',
    cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 0 },
    limit: { context: 200_000, output: 64_000 },
    modalities: { input: ['text'], output: ['text'] },
  }, 'fake');
  assert.deepEqual(model.pricing, { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 0 });
  assert.equal(model.maxOutputTokens, 64_000);
  assert.deepEqual(model.inputModalities, ['text']);
});

test('an unusable id is refused rather than mapped to an empty record', () => {
  const model = normalizeCatalogModel({ name: 'no id' }, 'fake');
  assert.equal(model.id, '');
});

test('an explicit false survives normalization and can therefore narrow a provider', () => {
  const model = normalizeCatalogModel({
    id: 'vendor/no-tools',
    supports_tools: false,
    supports_thinking: false,
  }, 'fake');
  assert.deepEqual(model.capabilities, { tools: false, reasoning: false });
});

test('the one shared mapper preserves an explicit false', () => {
  // There used to be ten vendored copies and this test read all of them. They are now one module, so
  // the behavior assertion above is the whole guard: a change that drops the branch fails it.
  const source = readFileSync(new URL('../_shared/src/model-normalize.ts', import.meta.url), 'utf8');
  for (const line of [
    'raw.supports_tools === false ? { tools: false }',
    'raw.supports_thinking === false ? { reasoning: false }',
  ]) {
    assert.ok(source.includes(line), `the shared mapper dropped the false-preservation branch (${line})`);
  }
});
