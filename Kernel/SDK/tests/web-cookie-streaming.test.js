import assert from 'node:assert/strict';
import test from 'node:test';
import { DeepSeekWebAdapter } from '../deepseek-web/dist/adapter/index.js';
import { GrokWebAdapter } from '../grok-web/dist/adapter/index.js';
import { PerplexityWebAdapter } from '../perplexity-web/dist/adapter/index.js';
import { TokenHarborWebAdapter } from '../tokenharbor-web/dist/adapter/index.js';

/**
 * The capability rule the gateway actually reads.
 *
 * A web-cookie provider does not stream just because its transport is SSE. Token Harbor
 * reads an SSE body whole; DeepSeek returns one answer. Grok and Perplexity forward real
 * events. The flag has to agree with what the adapter does, because the gateway refuses a
 * streamed request before it ever calls `streamChat`.
 */

test('the two ported adapters declare streaming and implement it', () => {
  assert.equal(new GrokWebAdapter().capabilities.streaming, true);
  assert.equal(new PerplexityWebAdapter().capabilities.streaming, true);
  assert.equal(typeof new GrokWebAdapter().streamChat, 'function');
  assert.equal(typeof new PerplexityWebAdapter().streamChat, 'function');
});

test('the existing web-cookie adapters that assemble the answer keep streaming false', () => {
  // Token Harbor's upstream is SSE, but the adapter reads the whole body before returning.
  // Declaring true would make the gateway call a stream that has no chunk boundaries.
  // Token Harbor omits the key entirely; the gateway treats anything but `true` as not streamable.
  assert.notEqual(new TokenHarborWebAdapter().capabilities.streaming, true);
  assert.equal(new DeepSeekWebAdapter().capabilities.streaming, false);
});
