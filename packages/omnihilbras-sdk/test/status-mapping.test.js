import assert from 'node:assert/strict';
import test from 'node:test';
import { FetchHttpTransport, ProviderError } from '../dist/index.js';

/**
 * How a provider's HTTP status is classified decides two things a user feels: the words
 * they read, and whether the connection is ejected.
 *
 * `AUTHENTICATION_FAILED` is terminal for routing, so mapping every 403 onto it meant a
 * single refused request took down a connection that was otherwise serving dozens of
 * models. A 403 is a refusal; a 401 is a credential failure.
 */

/**
 * Answers one status with one body. A fresh `Response` per call, because a body can only
 * be read once and the transport retries some statuses.
 */
function respond(status, body) {
  return async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

/** The transport captures `fetch` at construction, so the stub is injected. */
async function call(status, body = {}) {
  const transport = new FetchHttpTransport({ fetch: respond(status, body) });
  try {
    await transport.request({
      method: 'POST',
      providerId: 'probe',
      url: 'https://example.invalid/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

test('a 401 is an authentication failure', async () => {
  const error = await call(401, { error: { message: 'Invalid key' } });
  assert.equal(error.code, 'AUTHENTICATION_FAILED');
  assert.equal(error.message, 'Provider authentication failed.');
});

test('a 403 is a refusal, not an authentication failure', async () => {
  // The distinction that matters: this code is terminal for routing.
  const error = await call(403, { error: { message: 'FreeTierError' } });
  assert.equal(error.code, 'PROVIDER_REQUEST_FAILED', 'a 403 must not be terminal');
  assert.equal(error.message, 'The provider refused the request.');
  assert.equal(error.statusCode, 403, 'the status is still reported');
});

test("a provider's own words survive a 403 when it gives any", async () => {
  const error = await call(403, { error: { message: 'Workspace access denied' } });
  assert.equal(error.details?.providerMessage, 'Workspace access denied');
});

test('a bare 403 with no body still says the body was empty', async () => {
  const error = await call(403, '');
  assert.equal(error.code, 'PROVIDER_REQUEST_FAILED');
  assert.match(error.details?.providerMessage ?? '', /empty response body/);
});

test('the rest of the status mapping is unchanged', async () => {
  assert.equal((await call(429)).code, 'RATE_LIMITED');
  assert.equal((await call(408)).code, 'PROVIDER_TIMEOUT');
  assert.equal((await call(504)).code, 'PROVIDER_TIMEOUT');
  assert.equal((await call(500)).code, 'PROVIDER_UNAVAILABLE');
  assert.equal((await call(503)).code, 'PROVIDER_UNAVAILABLE');
  assert.equal((await call(400)).code, 'PROVIDER_REQUEST_FAILED');
  assert.equal((await call(404)).code, 'PROVIDER_REQUEST_FAILED');
  assert.equal((await call(422)).code, 'PROVIDER_REQUEST_FAILED');
});

test('a 403 is not retried, and a 401 is not retried either', async () => {
  // Both are terminal. What changed is that a 403 no longer *ejects* a connection.
  assert.equal((await call(403)).retryable, false);
  assert.equal((await call(401)).retryable, false);
  assert.equal((await call(429)).retryable, true);
  assert.equal((await call(503)).retryable, true);
});

test('ProviderError keeps a distinct message for a refusal', () => {
  const error = new ProviderError('PROVIDER_REQUEST_FAILED', 'The provider refused the request.', { providerId: 'p' });
  assert.equal(error.publicMessage ?? error.message, 'The provider refused the request.');
});
