import assert from 'node:assert/strict';
import test from 'node:test';
import { FetchHttpTransport, ProviderError, retryAfterMs } from '../dist/index.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');

test('Retry-After as delay-seconds becomes milliseconds', () => {
  assert.equal(retryAfterMs('30', NOW), 30_000);
  assert.equal(retryAfterMs(' 5 ', NOW), 5_000);
  assert.equal(retryAfterMs('0', NOW), 0, 'an explicit zero is advice to retry now, and is kept as zero');
});

test('Retry-After as an HTTP date becomes the time until that date', () => {
  assert.equal(retryAfterMs('Sat, 10 Oct 2026 12:01:00 GMT', NOW), 60_000);
});

test('a date already past, a negative value, and a malformed value give no advice', () => {
  assert.equal(retryAfterMs('Sat, 10 Oct 2026 11:00:00 GMT', NOW), undefined, 'a past date is not a zero wait');
  assert.equal(retryAfterMs('-5', NOW), undefined);
  assert.equal(retryAfterMs('soon', NOW), undefined);
  assert.equal(retryAfterMs('', NOW), undefined);
  assert.equal(retryAfterMs(null, NOW), undefined, 'no header is no advice');
});

const rateLimited = (headers) => new FetchHttpTransport({
  fetch: async () => new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'content-type': 'application/json', ...headers } }),
});

test('a 429 carries the provider\'s wait in details, and stays a retryable rate limit', async () => {
  const transport = rateLimited({ 'retry-after': '12' });
  await assert.rejects(
    () => transport.request({ method: 'GET', url: 'https://api.example.com/x', providerId: 'p' }),
    (error) => error instanceof ProviderError && error.code === 'RATE_LIMITED' && error.retryable === true
      && error.details.retryAfterMs === 12_000,
  );
});

test('a 429 without Retry-After carries no wait, so nothing is invented', async () => {
  const transport = rateLimited({});
  await assert.rejects(
    () => transport.request({ method: 'GET', url: 'https://api.example.com/x', providerId: 'p' }),
    (error) => error.code === 'RATE_LIMITED' && error.details.retryAfterMs === undefined,
  );
});

test('Retry-After is read only for a 429, not for a 503 that also sends it', async () => {
  const transport = new FetchHttpTransport({
    fetch: async () => new Response('{"error":{"message":"down"}}', { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '9' } }),
  });
  await assert.rejects(
    () => transport.request({ method: 'GET', url: 'https://api.example.com/x', providerId: 'p' }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.details.retryAfterMs === undefined,
  );
});
