import assert from 'node:assert/strict';
import test from 'node:test';
import { isProviderError } from '../dist/src/core/provider-error.js';
import { toErrorEnvelope } from '../dist/src/core/http.js';

/**
 * A provider's error must survive the gateway's own error handling.
 *
 * Every provider is its own package with its own copy of `errors.ts`, so the class a provider throws is
 * **not** the class the gateway imported. `instanceof` answers `false` for it, and the envelope builder
 * fell through to its catch-all: measured on a refused Token Harbor cookie, the user was told
 * "The gateway encountered an unexpected error" instead of the actual reason, with no code, no status and
 * no provider named.
 *
 * These tests pin the property — not the class — so they keep holding however many copies exist.
 */

/** An error from a *different* copy of ProviderError, exactly as a provider package throws it. */
function foreignProviderError() {
  const error = new Error('That Cookie header carries no "sb-auth-auth-token" cookie.');
  error.name = 'ProviderError';
  error.code = 'INVALID_REQUEST';
  return error;
}

test('an error from another package copy is recognised as a provider error', () => {
  assert.equal(isProviderError(foreignProviderError()), true);
});

test('a plain Error that merely looks similar is not', () => {
  const plain = new Error('boom');
  assert.equal(isProviderError(plain), false, 'no name and code: not a provider error');
  const namedOnly = new Error('boom');
  namedOnly.name = 'ProviderError';
  assert.equal(isProviderError(namedOnly), false, 'a name without a code is not enough');
});

test('the envelope names the reason instead of "unexpected error"', () => {
  const envelope = toErrorEnvelope(foreignProviderError());
  assert.notEqual(envelope.error.code, 'INTERNAL_ERROR', 'a provider failure must not be reported as a gateway fault');
  assert.equal(envelope.error.code, 'INVALID_REQUEST');
  // The *code* is what the user-facing mapping keys on, and it is now right. A foreign copy carries no
  // `publicMessage`, so the text falls back to the message registered for that code — which is still a
  // truthful sentence about the request, and infinitely better than "the gateway encountered an
  // unexpected error". Providers that want a specific sentence set `publicMessage` explicitly.
  assert.ok(envelope.error.message && envelope.error.message !== 'The gateway encountered an unexpected error.');
});
