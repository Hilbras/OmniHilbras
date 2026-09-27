import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyModelFilters,
  blendedPrice,
  contextLabel,
  defaultModelFilters,
  filterAvailability,
  modelFacets,
  priceLabel,
} from '../dist/index.js';

/**
 * Filters read a provider's catalog, and the whole risk is in what they do with a field
 * the provider did not publish. A model with no price must never read as free, and a
 * provider that says nothing about images has not been shown to lack them. Both mistakes
 * are silent — the list just looks right — so they are pinned here.
 */

/** A model as the filter list holds it. */
const entry = (model, meta, extra = {}) => ({ model, facets: modelFacets(meta), testState: 'idle', ...extra });

test('a stated price of zero is free', () => {
  const facets = modelFacets({ p: [0, 0] });
  assert.equal(facets.hasPricing, true);
  assert.equal(facets.isFree, true);
  assert.equal(priceLabel(facets.prices, 'input'), 'Free');
});

test('a model with no price is unknown, never free', () => {
  // The failure this guards: a filter that treats "no quote" as "free" would offer a
  // whole catalog of paid models as though they cost nothing.
  const facets = modelFacets(undefined);
  assert.equal(facets.hasPricing, false);
  assert.equal(facets.isFree, undefined, 'unknown, not false and not true');
  assert.equal(priceLabel(facets.prices, 'input'), undefined);

  const emptyPrices = modelFacets({ p: [] });
  assert.equal(emptyPrices.hasPricing, false);
  assert.equal(emptyPrices.isFree, undefined);
});

test('one zero price and one paid price is not free', () => {
  const facets = modelFacets({ p: [0, 5] });
  assert.equal(facets.isFree, false, 'free cached input does not make a model free');
});

test('a free filter selects stated-free models and nothing else', () => {
  const models = [
    entry('free-one', { p: [0, 0] }),
    entry('paid-one', { p: [1, 5] }),
    entry('silent-one', undefined),
  ];
  const free = applyModelFilters(models, { ...defaultModelFilters, free: 'free' }).map((m) => m.model);
  assert.deepEqual(free, ['free-one']);

  const unpriced = applyModelFilters(models, { ...defaultModelFilters, free: 'unpriced' }).map((m) => m.model);
  assert.deepEqual(unpriced, ['silent-one'], 'the unpriced filter finds the ones nobody quoted');

  const priced = applyModelFilters(models, { ...defaultModelFilters, free: 'priced' }).map((m) => m.model);
  assert.deepEqual(priced, ['paid-one']);
});

test('an unstated modality cannot satisfy a modality filter', () => {
  const models = [
    entry('vision-model', { i: ['text', 'image'] }),
    entry('text-model', { i: ['text'], o: ['text'] }),
    entry('silent-model', undefined),
  ];
  const images = applyModelFilters(models, { ...defaultModelFilters, modality: 'image' }).map((m) => m.model);
  assert.deepEqual(images, ['vision-model'], 'a provider that said nothing is not assumed to lack images');

  const text = applyModelFilters(models, { ...defaultModelFilters, modality: 'text' }).map((m) => m.model);
  assert.deepEqual(text.sort(), ['text-model', 'vision-model'], 'text matches a model that also takes images');
});

test('the context filter is a floor, and an unknown context cannot pass it', () => {
  const models = [
    entry('wide', { c: 1_000_000 }),
    entry('narrow', { c: 32_000 }),
    entry('unstated', undefined),
  ];
  const wide = applyModelFilters(models, { ...defaultModelFilters, minContext: 200_000 }).map((m) => m.model);
  assert.deepEqual(wide, ['wide'], 'a model with no stated context does not satisfy a minimum');
});

test('a model being tested counts as untested, not as a result', () => {
  const models = [entry('busy', undefined, { testState: 'testing' }), entry('done', undefined, { testState: 'ok' })];
  assert.deepEqual(applyModelFilters(models, { ...defaultModelFilters, result: 'untested' }).map((m) => m.model), ['busy']);
  assert.deepEqual(applyModelFilters(models, { ...defaultModelFilters, result: 'passed' }).map((m) => m.model), ['done']);
});

test('a query matches the display name as well as the id, ignoring case and separators', () => {
  const models = [entry('anthropic/claude-sonnet-5', { n: 'Claude Sonnet 5' }), entry('openai/gpt-5.5', { n: 'GPT 5.5' })];
  assert.deepEqual(applyModelFilters(models, { ...defaultModelFilters, query: 'claude sonnet' }).map((m) => m.model), ['anthropic/claude-sonnet-5']);
  assert.deepEqual(applyModelFilters(models, { ...defaultModelFilters, query: 'GPT5.5' }).map((m) => m.model), ['openai/gpt-5.5']);
  assert.deepEqual(applyModelFilters(models, { ...defaultModelFilters, query: 'sonnet-5' }).map((m) => m.model), ['anthropic/claude-sonnet-5']);
});

test('cheapest sort puts unpriced models last rather than first', () => {
  const models = [entry('unknown', undefined), entry('cheap', { p: [0.1, 0.3] }), entry('dear', { p: [10, 30] })];
  assert.deepEqual(applyModelFilters(models, { ...defaultModelFilters, sort: 'cheapest' }).map((m) => m.model), [
    'cheap',
    'dear',
    'unknown',
  ]);
});

test('latency sorts put untested models last in both directions', () => {
  // A column of blanks at the top reads as a broken sort.
  const models = [
    entry('slow', undefined, { latencyMs: 900 }),
    entry('fast', undefined, { latencyMs: 120 }),
    entry('unknown', undefined),
  ];
  assert.deepEqual(applyModelFilters(models, { ...defaultModelFilters, sort: 'fastest' }).map((m) => m.model), ['fast', 'slow', 'unknown']);
  assert.deepEqual(applyModelFilters(models, { ...defaultModelFilters, sort: 'slowest' }).map((m) => m.model), ['slow', 'fast', 'unknown']);
});

test('a blended price needs both sides, and weights output above input', () => {
  assert.equal(blendedPrice({ input: 1, output: 2 }), 7);
  assert.equal(blendedPrice({ input: 1 }), undefined, 'input alone cannot rank a model');
  assert.equal(blendedPrice({}), undefined);
});

test('a sub-cent price is not rounded to a price of zero', () => {
  // $0.0002 per 1M is not free, and rendering it as "$0.00" would say it was.
  assert.equal(priceLabel({ input: 0.0002 }, 'input'), '$0.0002');
  assert.equal(priceLabel({ input: 0.009 }, 'input'), '$0.0090');
  assert.equal(priceLabel({ input: 2.5 }, 'input'), '$2.50');
});

test('context is labelled in the units a person uses', () => {
  assert.equal(contextLabel(1_000_000), '1M');
  assert.equal(contextLabel(262_144), '262K');
  assert.equal(contextLabel(512), '512');
  assert.equal(contextLabel(undefined), undefined);
});

test('availability reports what this provider actually published', () => {
  const rich = [entry('a', { p: [1, 2], c: 1000, i: ['text'] })];
  assert.deepEqual(filterAvailability(rich), { pricing: true, context: true, modalities: true, free: true });

  // A minimal catalog states nothing, so no filter is offered rather than one that
  // silently matches nothing.
  const bare = [entry('a', undefined), entry('b', undefined)];
  assert.deepEqual(filterAvailability(bare), { pricing: false, context: false, modalities: false, free: false });
});

test('filters compose rather than overriding each other', () => {
  const models = [
    entry('free-vision', { p: [0, 0], c: 1_000_000, i: ['text', 'image'] }),
    entry('free-text', { p: [0, 0], c: 8_000, i: ['text'] }),
    entry('paid-vision', { p: [2, 6], c: 1_000_000, i: ['text', 'image'] }),
  ];
  const result = applyModelFilters(models, {
    ...defaultModelFilters,
    free: 'free',
    modality: 'image',
    minContext: 200_000,
  }).map((m) => m.model);
  assert.deepEqual(result, ['free-vision']);
});
