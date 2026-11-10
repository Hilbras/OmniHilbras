import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeUsage } from '../dist/src/core/usage-canonical.js';
import { requestCostUsd } from '../dist/src/core/usage-pricing.js';
import { summarizeUsage } from '../dist/src/core/usage-store.js';

/**
 * One convention: input includes cache; cache read/write are subsets.
 *
 * Claude's prompt excludes cache, so it has to be folded. OpenAI/Gemini include it already, so folding again
 * would double-count. Re-running a canonical object must not add it a second time.
 */

test('Claude cache read/write are folded into input once', () => {
  const usage = canonicalizeUsage({
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 50,
  });
  assert.deepEqual(usage, {
    inputTokens: 1050,
    outputTokens: 20,
    totalTokens: 1070,
    cacheReadTokens: 900,
    cacheWriteTokens: 50,
  });
  assert.deepEqual(canonicalizeUsage(usage), usage, 'canonical input was folded twice');
});

test('OpenAI/Gemini cached tokens pass through inside the prompt', () => {
  assert.deepEqual(canonicalizeUsage({ prompt_tokens: 1000, completion_tokens: 10, cached_tokens: 600 }), {
    inputTokens: 1000,
    outputTokens: 10,
    totalTokens: 1010,
    cacheReadTokens: 600,
    cacheWriteTokens: 0,
  });
  assert.deepEqual(canonicalizeUsage({ promptTokenCount: 500, candidatesTokenCount: 25, cachedContentTokenCount: 200, thoughtsTokenCount: 7 }), {
    inputTokens: 500,
    outputTokens: 25,
    totalTokens: 525,
    cacheReadTokens: 200,
    cacheWriteTokens: 0,
    reasoningTokens: 7,
  });
});

test('Responses nested details are read without double counting', () => {
  const usage = canonicalizeUsage({
    input_tokens: 300,
    output_tokens: 40,
    input_tokens_details: { cached_tokens: 100, reasoning_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 11 },
  });
  assert.equal(usage.inputTokens, 300);
  assert.equal(usage.cacheReadTokens, 100);
  assert.equal(usage.reasoningTokens, 11);
});

test('a normalized Claude adapter can mark that input excludes cache', () => {
  assert.deepEqual(canonicalizeUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 50, cacheTokensIncluded: false }), {
    inputTokens: 1050,
    outputTokens: 20,
    totalTokens: 1070,
    cacheReadTokens: 900,
    cacheWriteTokens: 50,
    cacheTokensIncluded: false,
  });
});

test('no reported tokens is an absence, not a zero', () => {
  assert.equal(canonicalizeUsage(undefined), undefined);
  assert.equal(canonicalizeUsage({}), undefined);
  assert.equal(canonicalizeUsage({ estimated: true }), undefined);
});

test('cache tokens are priced at their own rates', () => {
  const cost = requestCostUsd({
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 10_000,
    cacheWriteTokens: 2_000,
    pricing: { inputPer1M: 10, outputPer1M: 30, cacheReadPer1M: 1, cacheWritePer1M: 5 },
  });
  // 0.01 + 0.003 + 0.01 + 0.01
  assert.equal(cost, 0.033);
});

test('summaries carry cache and reasoning totals', () => {
  const totals = summarizeUsage([
    { id: '1', at: new Date().toISOString(), model: 'm', outcome: 'success', attempts: 1, latencyMs: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5, reasoningTokens: 3 },
  ]);
  assert.equal(totals.cacheReadTokens, 80);
  assert.equal(totals.cacheWriteTokens, 5);
  assert.equal(totals.reasoningTokens, 3);
});

test('an estimate is preserved as a label', () => {
  assert.equal(canonicalizeUsage({ input_tokens: 10, output_tokens: 2, estimated: true })?.estimated, true);
});
