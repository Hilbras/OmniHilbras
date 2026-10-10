import assert from 'node:assert/strict';
import test from 'node:test';
import { describeConsoleModel } from '../dist/index.js';
import { compactPricing, normalizeContextWindow, normalizeModalities, perMillionPrice, perTokenPrice, tokensPerMillion } from '../dist/index.js';

/**
 * Prices are compared per 1M tokens because that is the unit a person thinks in, but
 * providers quote in incompatible units: OpenRouter in per-token strings, OpenCode Zen in
 * per-1M numbers. A converter that guesses is a converter that eventually renders a
 * price a million times out, so the two are kept distinct and both are tested against the
 * real shapes those APIs return.
 */

test("OpenRouter's per-token strings become per-1M", () => {
  // $2.50 per 1M, quoted as a per-token string.
  assert.equal(perTokenPrice('0.0000025'), 2.5);
  assert.equal(perTokenPrice('0.00001'), 10);
  assert.equal(perTokenPrice(0.0000025), 2.5);
  assert.equal(tokensPerMillion, 1_000_000);
});

test("Zen's per-1M numbers are taken as they are", () => {
  // 2.5 per 1M. Reading this as per-token would be 2,500,000 per 1M.
  assert.equal(perMillionPrice(2.5), 2.5);
  assert.equal(perMillionPrice(0.1), 0.1);
  assert.equal(perMillionPrice(10), 10);
});

test('zero is a price, and every spelling of it is', () => {
  // Free models are the reason this filter matters, so "0" must never read as "unknown".
  for (const value of [0, '0', '0.0', '0.000', '.0', 0.0]) {
    assert.equal(perTokenPrice(value), 0, `per-token ${JSON.stringify(value)}`);
    assert.equal(perMillionPrice(value), 0, `per-1M ${JSON.stringify(value)}`);
  }
});

test('a missing or nonsensical price is absent, not zero', () => {
  // The dangerous failure is a model with no quote rendering as free.
  for (const value of [undefined, null, '', '  ', 'free', 'contact us', {}, [], NaN, -1, -0.5]) {
    assert.equal(perTokenPrice(value), undefined, `per-token ${JSON.stringify(value)}`);
    assert.equal(perMillionPrice(value), undefined, `per-1M ${JSON.stringify(value)}`);
  }
});

test('an implausible price is rejected rather than rendered', () => {
  // Above a million per 1M is a provider bug. Showing it would be worse than hiding it.
  assert.equal(perTokenPrice('2'), undefined, 'a per-token price of 2 is not credible');
  assert.equal(perMillionPrice(5_000_000), undefined);
  assert.equal(perMillionPrice(999_999), 999_999, 'just inside the bound is kept');
});

test('prices keep four decimals, which is finer than any of these figures', () => {
  assert.equal(perTokenPrice('0.00000012345'), 0.1235);
  assert.equal(perMillionPrice(1.23456789), 1.2346);
});

test('a price that is not zero does not round to zero, so it is never shown as free', () => {
  // $0.00004 per 1M tokens is a real charge. Rounding it to 0 made the model read as "Free".
  assert.ok(Math.abs(perMillionPrice('0.00004') - 0.00004) < 1e-12, 'the real charge is kept, within float error');
  assert.ok(Math.abs(perTokenPrice('0.00000000004') - 0.00004) < 1e-12);
  assert.equal(perMillionPrice(0), 0, 'a true zero is still free');
});

test('an empty pricing object is dropped so it cannot read as free', () => {
  assert.equal(compactPricing({}), undefined);
  assert.deepEqual(compactPricing({ inputPer1M: 0 }), { inputPer1M: 0 });
  assert.deepEqual(compactPricing({ inputPer1M: 1, outputPer1M: undefined }), { inputPer1M: 1 });
});

test('modalities are lowercased, deduped, and absent when unstated', () => {
  assert.deepEqual(normalizeModalities(['Text', 'IMAGE', 'text']), ['text', 'image']);
  // "not stated" and "text only" are different facts, and a vision filter must not
  // conflate them, so an absent list stays absent.
  assert.equal(normalizeModalities(undefined), undefined);
  assert.equal(normalizeModalities([]), undefined);
  assert.equal(normalizeModalities('text'), undefined);
  assert.deepEqual(normalizeModalities(['text', 'image', 'pdf']), ['text', 'image', 'pdf']);
});

test('a context window is kept only when it is a plausible integer', () => {
  assert.equal(normalizeContextWindow(262144), 262144);
  assert.equal(normalizeContextWindow(1_000_000), 1_000_000);
  assert.equal(normalizeContextWindow(0), undefined);
  assert.equal(normalizeContextWindow(-5), undefined);
  assert.equal(normalizeContextWindow(1.5), undefined);
  assert.equal(normalizeContextWindow(50_000_000), undefined, 'a typo is not a context window');
  assert.equal(normalizeContextWindow('262144'), undefined, 'a string is not a number');
});

test('a Console entry becomes a full model record', () => {
  // The real shape, as console.opencode.ai returns it.
  const model = describeConsoleModel(
    'longcat-2.5-preview-free',
    {
      name: 'LongCat 2.5 Preview Free',
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 1_000_000, output: 131_072 },
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    },
    'opencode-console',
  );
  assert.equal(model.displayName, 'LongCat 2.5 Preview Free');
  assert.equal(model.contextWindow, 1_000_000);
  assert.deepEqual(model.inputModalities, ['text', 'image']);
  assert.deepEqual(model.outputModalities, ['text']);
  // Free, and free must be visible as a price of zero rather than as no price.
  assert.deepEqual(model.pricing, { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0, cacheWritePer1M: 0 });
});

test('a priced Console entry is not mistaken for a free one', () => {
  const model = describeConsoleModel(
    'claude-haiku-4-5',
    { name: 'Claude Haiku 4.5', modalities: { input: ['text'], output: ['text'] }, limit: { context: 200_000 }, cost: { input: 1, output: 5, cache_read: 0.1 } },
    'opencode-console',
  );
  assert.deepEqual(model.pricing, { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1 });
  assert.equal(model.pricing.cacheWritePer1M, undefined, 'an unquoted field stays absent');
});

test('a bare Console entry describes only its id', () => {
  const model = describeConsoleModel('mystery', undefined, 'opencode-console');
  assert.deepEqual(model, { id: 'mystery', providerId: 'opencode-console' });
  assert.equal(model.pricing, undefined, 'no price is invented');
  assert.equal(model.inputModalities, undefined, 'no modality is invented');
});
