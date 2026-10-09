import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { RetryPolicy } from '../dist/retry-policy.js';
import { ProviderError } from '@hilbras/omnihilbras';
import { providerIds } from './support/providerIds.js';

/**
 * `RetryPolicy`: retry this route, move to the next one, or stop.
 *
 * This decision was inline at two places and had already diverged — the chat path asked a
 * connection that had just said "you have reached your limit" a second time, because its rule was
 * gated on the *global* attempt count rather than this connection's own retry budget. So the tests
 * are a table over every error code, because the interesting property is not any single answer but
 * that the answer is total and does not depend on where the request came from.
 */

const policy = new RetryPolicy();

const candidate = (over = {}) => ({
  providerId: 'p',
  connectionId: 'c1',
  priority: 0,
  resilience: { maxRetries: 1, timeoutMs: 30_000, requestsPerMinute: 60, hedgeAfterMs: 0, ...over },
});

const ask = (over = {}) => policy.afterFailure({ error: new Error('boom'), candidate: candidate(), attemptsOnThisRoute: 1, aborted: false, canRetry: true, ...over });

// ── the three answers ─────────────────────────────────────────────────────

test('a permanent failure stops, because another connection refuses it identically', () => {
  // The whole cost this avoids: an upstream request spent confirming what the first one already
  // said, and the user waits N times as long for the same refusal.
  for (const code of ['INVALID_REQUEST', 'AUTHENTICATION_FAILED', 'NOT_SUPPORTED', 'NOT_FOUND']) {
    assert.equal(ask({ error: new ProviderError(code, 'no') }), 'stop', code);
  }
});

test('a cancellation stops, whatever the error says', () => {
  // A timeout arriving as the request is torn down is the deadline firing on something the caller
  // has already abandoned; retrying it spends a request nobody is waiting for.
  assert.equal(ask({ error: new ProviderError('PROVIDER_TIMEOUT', 'slow', { retryable: true }), aborted: true }), 'stop');
  assert.equal(ask({ error: new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true }), aborted: true }), 'stop');
  assert.equal(ask({ error: new Error('anything'), aborted: true }), 'stop', 'even an unattributable failure stops a cancelled request');
});

test('a per-connection limit hands off, on the first attempt as much as any other', () => {
  // **The bug this file exists for.** The old rule was gated on the *global* attempt count, so a
  // connection limited on a fresh request — global count of one — read as "not the first attempt"
  // and was asked again. A provider that has said "you have reached your limit" has said it about
  // the connection, so the next request is one it has already refused: paying twice for the same
  // answer is not optimism.
  const limited = new ProviderError('RATE_LIMITED', 'This connection reached its limit of 60 requests per minute.', { retryable: true });
  assert.equal(ask({ error: limited, attemptsOnThisRoute: 1 }), 'next-route', 'the first attempt must hand off too');
  assert.equal(ask({ error: limited, attemptsOnThisRoute: 2 }), 'next-route');
  // The ledger the client sees, so the refusal is visible rather than silent.
  assert.equal(ask({ error: limited, attemptsOnThisRoute: 9, canRetry: false }), 'next-route', 'however many attempts have happened');
});

test('a limit with a budget left still hands off rather than retrying', () => {
  // The budget is not a licence to retry a refusal the provider has already given.
  const limited = new ProviderError('RATE_LIMITED', 'limit', { retryable: true });
  assert.equal(ask({ error: limited, candidate: candidate({ maxRetries: 5 }), attemptsOnThisRoute: 1 }), 'next-route');
});

test('a transient failure retries while there is budget, then hands off', () => {
  const transient = new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true });
  const generous = candidate({ maxRetries: 3 });
  assert.equal(ask({ error: transient, candidate: generous, attemptsOnThisRoute: 1 }), 'retry');
  assert.equal(ask({ error: transient, candidate: generous, attemptsOnThisRoute: 3 }), 'retry', 'three retries means four attempts, so the fourth is still its own');
  assert.equal(ask({ error: transient, candidate: generous, attemptsOnThisRoute: 4 }), 'next-route', 'and the budget is spent');
});

test('a connection with no retry budget hands off on the first transient failure', () => {
  const transient = new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true });
  assert.equal(ask({ error: transient, candidate: candidate({ maxRetries: 0 }), attemptsOnThisRoute: 1 }), 'next-route');
});

test('a stream never retries, however much budget is left', () => {
  // A stream walks the chain once: once the first chunk has not been sent there is still a chain
  // to walk, and once it has, the client already holds a partial answer a second provider would
  // not match.
  const transient = new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true });
  assert.equal(ask({ error: transient, candidate: candidate({ maxRetries: 5 }), attemptsOnThisRoute: 1, canRetry: false }), 'next-route');
});

test('a failure we cannot attribute is not retried', () => {
  // A bare `Error` is a gateway-side fault. Retrying it across a provider is spending an upstream
  // request on our own bug.
  assert.equal(ask({ error: new Error('socket hang up') }), 'stop');
  assert.equal(ask({ error: 'a thrown string' }), 'stop');
  assert.equal(ask({ error: undefined }), 'stop');
});

// ── totality: every code has an answer, and it does not depend on the caller ──

test('every error code the SDK can raise gets an answer, and the two paths differ in one way only', () => {
  const codes = ['INVALID_REQUEST', 'AUTHENTICATION_FAILED', 'NOT_SUPPORTED', 'NOT_FOUND', 'CANCELLED', 'INVALID_RESPONSE', 'RATE_LIMITED', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_REQUEST_FAILED', 'CONFIGURATION_ERROR'];
  for (const code of codes) {
    for (const retryable of [true, false]) {
      const error = new ProviderError(code, code, { retryable });
      const shared = { error, candidate: candidate({ maxRetries: 2 }), attemptsOnThisRoute: 1, aborted: false };
      const chat = policy.afterFailure({ ...shared, canRetry: true });
      const stream = policy.afterFailure({ ...shared, canRetry: false });
      assert.ok(['retry', 'next-route', 'stop'].includes(chat), `${code} retryable=${retryable} produced ${chat}`);

      // A stream never retries. A stream walks the route chain once, so `retry` would mean "try
      // this connection again", which is the one thing it cannot do.
      assert.notEqual(stream, 'retry', `a stream must never retry, but ${code} retryable=${retryable} produced retry`);
      // And the two differ in that, and only that. Anything else means the paths have drifted,
      // which is the defect that made this file necessary.
      if (chat === 'retry') assert.equal(stream, 'next-route', `${code} may be retried by chat but a stream still walks the chain`);
      else assert.equal(chat, stream, `${code} retryable=${retryable}: chat and stream must agree, got ${chat} and ${stream}`);
    }
  }
});

test('the four terminal codes stop on both paths, whatever the error claims about itself', () => {
  // A provider marking its own refusal `retryable` does not make it retryable: the codes below
  // describe the request or the credential, and another connection refuses them identically. Trust
  // the flag here and a mistyped code fans out across every route.
  for (const code of ['INVALID_REQUEST', 'AUTHENTICATION_FAILED', 'NOT_SUPPORTED', 'NOT_FOUND']) {
    const error = new ProviderError(code, code, { retryable: true });
    assert.equal(ask({ error, attemptsOnThisRoute: 1 }), 'stop', `${code} with retryable: true`);
  }
});

test('the decision depends on the connection’s own budget, not on how much has been tried elsewhere', () => {
  // The shape of the original bug. A global count made a fresh request on a limited connection
  // behave differently from the second request on the same connection, which is not a property of
  // anything.
  const limited = new ProviderError('RATE_LIMITED', 'limit', { retryable: true });
  const first = ask({ error: limited, attemptsOnThisRoute: 1 });
  const later = ask({ error: limited, attemptsOnThisRoute: 5 });
  assert.equal(first, later, 'the same answer whichever request this was');
});

// ── the invariant ──────────────────────────────────────────────────────────

test('THE INVARIANT: the policy names no provider', () => {
  const files = providerIds();
  const source = readFileSync(new URL('../src/retry-policy.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const found = files.filter((id) => new RegExp("['\"`]" + id + "['\"`]").test(code));
  assert.deepEqual(found, [], `the policy must name no provider, found: ${found.join(', ')}`);
});
