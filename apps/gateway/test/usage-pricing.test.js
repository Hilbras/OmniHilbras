import test from 'node:test';
import assert from 'node:assert/strict';
import { priceUsage, pricingCaveat, requestCostUsd } from '../dist/usage-pricing.js';

// Pricing is the phase where a dashboard most easily starts lying, because every figure on the page wants to
// be a number. These tests are almost entirely about the cases where the honest answer is *not* a number.

test('a priced request costs tokens times the per-1M rate', () => {
  // 1000 input at $3/1M and 500 output at $15/1M = 0.003 + 0.0075 = $0.0105.
  const cost = requestCostUsd({ inputTokens: 1_000, outputTokens: 500, pricing: { inputPer1M: 3, outputPer1M: 15 } });
  assert.equal(cost, 0.0105);
});

test('a request with no price is undefined, not zero', () => {
  // The whole point. A free tier costs 0; a model with no published price cannot be said to cost anything,
  // and reporting 0 for it puts an invented figure in the same column as a measured one.
  assert.equal(requestCostUsd({ inputTokens: 1_000, outputTokens: 500 }), undefined);
  assert.equal(requestCostUsd({ inputTokens: 1_000, outputTokens: 500, pricing: {} }), undefined);
  assert.notEqual(requestCostUsd({ inputTokens: 1_000, pricing: { inputPer1M: 0 } }), undefined,
    'an explicit zero price IS a measurement, and must not be confused with a missing one');
  assert.equal(requestCostUsd({ inputTokens: 1_000, pricing: { inputPer1M: 0 } }), 0);
});

test('a price with no matching tokens is not zero cost', () => {
  // The provider quoted both rates; this request reported neither. Reporting $0 would claim the request was
  // free, when in fact it was unmeasurable.
  assert.equal(requestCostUsd({ pricing: { inputPer1M: 3, outputPer1M: 15 } }), undefined);
});

test('a partial quote prices only the half it covers', () => {
  // No output rate quoted. Halving the input rate would be an invention, so the input is priced and the
  // output is simply absent -- which makes the total a floor, not an estimate.
  const cost = requestCostUsd({ inputTokens: 1_000, outputTokens: 500, pricing: { inputPer1M: 3 } });
  assert.equal(cost, 0.003, 'the output tokens were priced at a rate nobody published');
});

test('cache tokens bill at their own rates and are not folded into input', () => {
  const cost = requestCostUsd({
    inputTokens: 1_000,
    cacheReadTokens: 10_000,
    pricing: { inputPer1M: 3, cacheReadPer1M: 0.3 },
  });
  // 0.003 input + 0.003 cache read = 0.006. Folding 11,000 tokens into the $3 rate would give 0.033.
  assert.equal(cost, 0.006);
});

test('a nonsense token count is ignored rather than producing a nonsense cost', () => {
  assert.equal(requestCostUsd({ inputTokens: -5, pricing: { inputPer1M: 3 } }), undefined);
  assert.equal(requestCostUsd({ inputTokens: Number.NaN, pricing: { inputPer1M: 3 } }), undefined);
  assert.equal(requestCostUsd({ inputTokens: Number.POSITIVE_INFINITY, pricing: { inputPer1M: 3 } }), undefined);
});

test('totals count priced and unpriced separately', () => {
  const priced = priceUsage([
    { inputTokens: 1_000, outputTokens: 500, pricing: { inputPer1M: 3, outputPer1M: 15 } },
    { inputTokens: 1_000, outputTokens: 500, pricing: { inputPer1M: 3, outputPer1M: 15 } },
    { inputTokens: 2_000 },                                   // no price
    { inputTokens: 500, pricing: { inputPer1M: 0 } },         // measured free
  ]);
  assert.equal(priced.costUsd, 0.021, 'the unpriced request contributed a figure to the total');
  assert.equal(priced.pricedRequests, 3);
  assert.equal(priced.unpricedRequests, 1);
  assert.equal(priced.unpricedEntirely, false);
});

test('nothing priceable says so, rather than reporting zero', () => {
  // A dashboard that shows "$0.00" on a page with three real requests is the exact failure this whole module
  // is written to prevent, and `unpricedEntirely` is what lets the page say "no cost available" instead.
  const none = priceUsage([{ inputTokens: 1_000 }, { inputTokens: 2_000 }]);
  assert.equal(none.costUsd, 0);
  assert.equal(none.pricedRequests, 0);
  assert.equal(none.unpricedEntirely, true);

  const empty = priceUsage([]);
  assert.equal(empty.unpricedEntirely, true, 'an empty page is not a page of free requests');
  assert.equal(empty.unpricedRequests, 0);
});

test('the caveat names how much of the page it covers', () => {
  assert.equal(pricingCaveat(priceUsage([{ inputTokens: 1, pricing: { inputPer1M: 1 } }])), null,
    'a caveat shown every time is a caveat nobody reads');

  const partial = pricingCaveat(priceUsage([
    { inputTokens: 1, pricing: { inputPer1M: 1 } },
    { inputTokens: 1 },
  ]));
  assert.match(partial ?? '', /covers 1 of 2 requests/);
  assert.match(partial ?? '', /no published price/);

  const none = pricingCaveat(priceUsage([{ inputTokens: 1 }]));
  assert.match(none ?? '', /^No cost shown/);
  assert.match(none ?? '', /none of the 1 recorded request had a price/);
});

test('the caveat pluralises one request correctly', () => {
  const single = pricingCaveat(priceUsage([{ inputTokens: 1 }]));
  assert.match(single ?? '', /none of the 1 recorded request had a price/, 'a "1 recorded requests" is sloppy on a page');
  // Also assert the absence of the plural, so a future refactor cannot make both forms appear at once.
  assert.ok(!single?.includes('1 recorded requests'), 'the singular form leaked a plural');
  const many = pricingCaveat(priceUsage([{ inputTokens: 1 }, { inputTokens: 1 }]));
  assert.match(many ?? '', /none of the 2 recorded requests had a price/);
});

test('sub-cent totals are not rounded away to nothing', () => {
  // A cheap model over a few hundred requests: a naive 2-decimal round shows $0.00 forever, which reads as
  // "free" and is worse than a long decimal.
  const records = Array.from({ length: 300 }, () => ({ inputTokens: 100, pricing: { inputPer1M: 0.5 } }));
  const total = priceUsage(records);
  assert.equal(total.costUsd, 0.015);
  assert.notEqual(total.costUsd, 0, 'a real total rounded to zero reads as free');
});

test('an empty pricing object on a record is treated as no price, not as free', () => {
  const totals = priceUsage([{ inputTokens: 1_000, pricing: {} }]);
  assert.equal(totals.pricedRequests, 0);
  assert.equal(totals.unpricedEntirely, true);
});
