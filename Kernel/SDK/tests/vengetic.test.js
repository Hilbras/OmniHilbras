import assert from 'node:assert/strict';
import test from 'node:test';

import { VengeticAdapter } from '../vengetic/dist/adapter/index.js';
import { ProviderError } from '../_shared/dist/errors.js';

/**
 * Vengetic is a thin OpenAI-wire adapter with two provider-specific facts worth pinning: its model
 * catalog is authenticated (so it can validate a candidate key), and its usage endpoint has no
 * published response shape (so a quota is only shown when the fields are recognizable).
 */

function transport(handler) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      const answer = await handler(request);
      if (answer.throw) throw answer.throw;
      return { status: 200, headers: new Headers(), data: answer.data };
    },
    async *stream() { throw new Error('not used'); },
  };
}

const credential = { type: 'api-key', value: 'aiapi_test_key' };
const catalog = { data: [{ id: 'gemini-2.0-flash', object: 'model', created: 1, owned_by: 'google' }] };

test('a candidate key is checked by an authenticated catalog read, not a public one', async () => {
  const fake = transport(() => ({ data: catalog }));
  const adapter = new VengeticAdapter({ transport: fake });
  const result = await adapter.validateCredential(credential);
  assert.equal(result.status, 'valid');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].method, 'GET');
  assert.equal(fake.calls[0].url, 'https://api.vengetic.biz.id/v1/models');
  assert.equal(fake.calls[0].headers.Authorization, 'Bearer aiapi_test_key');
});

test('a refused key is a credential failure, and a missing key is refused locally', async () => {
  const refused = transport(() => ({ throw: new ProviderError('AUTHENTICATION_FAILED', 'Invalid or expired access token', { statusCode: 401 }) }));
  await assert.rejects(
    () => new VengeticAdapter({ transport: refused }).validateCredential(credential),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /Invalid or expired/.test(error.message),
  );
  const noKey = transport(() => ({ data: catalog }));
  await assert.rejects(
    () => new VengeticAdapter({ transport: noKey }).validateCredential(undefined),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /Enter a Vengetic API key/.test(error.message),
  );
  assert.equal(noKey.calls.length, 0, 'a missing key spends no request');
});

test('quota reports only fields the provider actually stated', async () => {
  const fake = transport(() => ({ data: {
    plan: 'Free',
    usage: {
      rpm: { used: 5, limit: 15, resets_at: '2026-11-22T00:00:00Z' },
      tpm: { used: 1000, limit: 1000000 },
      rpd: { used: 12, limit: 100 },
      concurrency: { used: 1, limit: 1 },
    },
  } }));
  const quota = await new VengeticAdapter({ transport: fake }).quota({ credential });
  assert.equal(quota.plan, 'Free');
  assert.equal(quota.resources['Requests / minute'].used, 5);
  assert.equal(quota.resources['Requests / minute'].limit, 15);
  assert.equal(quota.resources['Requests / minute'].remaining, 10);
  assert.equal(quota.resources['Requests / minute'].resetsAt, '2026-11-22T00:00:00.000Z');
  assert.equal(quota.resources['Tokens / minute'].remaining, 999000);
  assert.equal(quota.resources['Requests / day'].used, 12);
  assert.equal(quota.resources['Concurrency'].used, 1);
  assert.equal(fake.calls[0].url, 'https://api.vengetic.biz.id/v1/usage');
});

test('an unrecognized usage shape is refused rather than shown as zero', async () => {
  const fake = transport(() => ({ data: { something_else: 42 } }));
  await assert.rejects(
    () => new VengeticAdapter({ transport: fake }).quota({ credential }),
    (error) => error.code === 'NOT_SUPPORTED' && /No quota is shown rather than a guessed one/.test(error.publicMessage ?? ''),
  );
});

test('a quota read without a credential is refused before any request', async () => {
  const fake = transport(() => ({ data: {} }));
  await assert.rejects(
    () => new VengeticAdapter({ transport: fake }).quota(),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
  assert.equal(fake.calls.length, 0);
});
