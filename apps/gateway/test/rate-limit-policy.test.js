import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { RateLimitPolicy } from '../dist/rate-limit-policy.js';
import { SlidingWindowRateLimiter } from '../dist/routing.js';
import { providerIds } from './support/providerIds.js';

/**
 * `RateLimitPolicy`: what a request limit means, and when it is spent.
 *
 * The defect this file is the answer to was a limit of 60 per minute allowing 30, because the
 * query recorded the request *and* the dispatch recorded it again. So the tests here are about
 * counting: what costs budget, what does not, and how many requests a stated limit actually
 * admits.
 */

function policy({ limit = 3, now } = {}) {
  const clock = { value: 1_000_000 };
  const limiter = new SlidingWindowRateLimiter(now ? () => now() : () => clock.value);
  return { instance: new RateLimitPolicy({ limiter }), clock, limiter };
}

const candidate = (over = {}) => ({ providerId: 'p', connectionId: 'c1', priority: 0, resilience: { maxRetries: 0, timeoutMs: 1_000, requestsPerMinute: 3, hedgeAfterMs: 0, ...over }, ...over });

// ── what costs budget, and what does not ──────────────────────────────────

test('a stated limit admits exactly that many requests', () => {
  // The measurement that found the double count. Driving the policy the way the request path drives
  // it — check, then spend — is the only way the property means anything.
  const { instance } = policy({ limit: 3 });
  const one = candidate({ resilience: { requestsPerMinute: 3, maxRetries: 0, timeoutMs: 1, hedgeAfterMs: 0 } });
  let admitted = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { instance.enforce(one); admitted += 1; instance.spend(one.connectionId); } catch { /* refused */ }
  }
  assert.equal(admitted, 3, 'a limit of 3 is 3 requests, not 3 requests and then some');
});

test('asking costs nothing, however many times it is asked', () => {
  // A query that records makes the limit mean half of what it says, and makes a *refused* request
  // consume budget for a call that was never made.
  const { instance } = policy();
  const one = candidate();
  for (let query = 0; query < 50; query += 1) assert.doesNotThrow(() => instance.enforce(one));
  assert.equal(instance.observed().get('c1'), 0, 'asked fifty times, still ready — because nothing was sent');
});

test('a refused request spends no budget, because there was no request to spend', () => {
  const { instance } = policy({ limit: 1 });
  const one = candidate({ resilience: { requestsPerMinute: 1, maxRetries: 0, timeoutMs: 1, hedgeAfterMs: 0 } });
  instance.enforce(one);
  instance.spend(one.connectionId);
  assert.throws(() => instance.enforce(one), (error) => error.code === 'RATE_LIMITED');
  // And the budget it did not spend is still there for the next window.
  assert.ok(instance.observed().get('c1') > 0, 'the connection is recorded as waiting, so the dashboard can show it');
});

test('a zero limit means unlimited, and never blocks', () => {
  // This is a local, single-operator gateway on the user's own providers. A default limit would
  // refuse requests the user did not know was throttled, for no protection.
  const { instance } = policy();
  const unlimited = candidate({ resilience: { requestsPerMinute: 0, maxRetries: 0, timeoutMs: 1, hedgeAfterMs: 0 } });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.doesNotThrow(() => instance.enforce(unlimited));
    instance.spend(unlimited.connectionId);
  }
  assert.equal(instance.observed().get('c1'), 0);
});

test('the window slides, so a burst cannot straddle a minute and double the rate', () => {
  const { instance, clock } = policy({ limit: 2 });
  const one = candidate({ resilience: { requestsPerMinute: 2, maxRetries: 0, timeoutMs: 1, hedgeAfterMs: 0 } });
  const send = () => { instance.enforce(one); instance.spend(one.connectionId); };
  send(); send();
  assert.throws(() => instance.enforce(one), (error) => error.code === 'RATE_LIMITED');
  clock.value += 30_000;
  assert.throws(() => instance.enforce(one), 'still limited halfway through the window');
  clock.value += 31_000;
  assert.doesNotThrow(() => instance.enforce(one), 'and ready once the window has moved on');
});

// ── what the caller is told ───────────────────────────────────────────────

test('a refusal names the limit and is retryable elsewhere', () => {
  // `retryable` because it *is* retryable — elsewhere. The retry policy reads the code and hands
  // off to the next route, so a limited connection steps aside rather than being asked again.
  const { instance } = policy({ limit: 1 });
  const one = candidate({ resilience: { requestsPerMinute: 1, maxRetries: 0, timeoutMs: 1, hedgeAfterMs: 0 } });
  instance.enforce(one);
  instance.spend(one.connectionId);
  assert.throws(() => instance.enforce(one), (error) => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.retryable, true);
    assert.equal(error.providerId, 'p');
    assert.match(error.message, /limit of 1 requests per minute/);
    return true;
  });
});

test('a connection that is not waiting is recorded as zero rather than left unknown', () => {
  // *Never checked* and *not waiting* are different answers. A connection that refuses traffic
  // while looking ready to the dashboard is one an operator keeps sending to.
  const { instance } = policy();
  instance.enforce(candidate());
  assert.equal(instance.observed().get('c1'), 0);
  assert.equal(instance.observed().has('c1'), true);
});

test('waits are per connection, so one busy connection does not look like a busy gateway', () => {
  const { instance } = policy();
  const busy = candidate({ connectionId: 'busy', resilience: { requestsPerMinute: 1, maxRetries: 0, timeoutMs: 1, hedgeAfterMs: 0 } });
  const quiet = candidate({ connectionId: 'quiet' });
  instance.enforce(busy);
  instance.spend(busy.connectionId);
  // The refusal *and* the wait are both expected: the wait is recorded before the throw, which is
  // what lets the dashboard show a connection cooling down rather than simply missing.
  assert.throws(() => instance.enforce(busy), (error) => error.code === 'RATE_LIMITED');
  instance.enforce(quiet);
  assert.ok(instance.observed().get('busy') > 0, 'the busy connection is shown as waiting');
  assert.equal(instance.observed().get('quiet'), 0, 'and the quiet one is still ready');
});

test('the observed waits cannot be written through by a caller', () => {
  // The policy owns them; a caller that could `set` one could make a throttled connection look
  // ready, which is the exact confusion the map exists to prevent.
  const { instance } = policy();
  instance.enforce(candidate());
  const observed = instance.observed();
  assert.equal(typeof observed.set, 'undefined', 'the view cannot be written through');
  assert.equal(typeof observed.delete, 'undefined', 'nor cleared');
  assert.equal(observed instanceof Map, false, 'and it is not a bare Map that could be cast back');
  // And writing through the *internal* map is still possible by anyone holding the policy, so the
  // guarantee is only about the view — which is the only thing handed out.
  assert.equal(observed.get('c1'), 0, 'and reading still works');
});

// ── the invariant ──────────────────────────────────────────────────────────

test('THE INVARIANT: the policy names no provider', () => {
  const adapters = providerIds();
  const source = readFileSync(new URL('../src/rate-limit-policy.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const found = adapters.filter((id) => new RegExp("['\"`]" + id + "['\"`]").test(code));
  assert.deepEqual(found, [], `the policy must name no provider, found: ${found.join(', ')}`);
});
