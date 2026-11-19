import assert from 'node:assert/strict';
import test from 'node:test';
import { CircuitBreaker, defaultBreakerConfig } from '../dist/src/core/circuit-breaker.js';

/**
 * The breaker's state machine, measured.
 *
 * Before it existed, a route that had failed five times in a row was asked again on the next request, and every user
 * paid the full timeout to relearn what the previous request already knew. The number this file is judged by is
 * `skipped`: how many attempts the breaker refused, which is how many timeouts nobody waited for.
 */

const config = { failureThreshold: 3, baseCooldownMs: 1_000, maxCooldownMs: 8_000 };

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test('the threshold opens it, and the next request is refused without a dispatch', () => {
  const time = clock();
  const breaker = new CircuitBreaker(config, time.now);

  assert.equal(breaker.recordFailure('c'), 'counted');
  assert.equal(breaker.recordFailure('c'), 'counted');
  assert.equal(breaker.allows('c'), true, 'it opened before the threshold');
  assert.equal(breaker.recordFailure('c'), 'opened');

  assert.equal(breaker.allows('c'), false, 'an open breaker still allowed a dispatch');
  assert.equal(breaker.allows('c'), false);
  const status = breaker.status('c');
  assert.equal(status.state, 'open');
  assert.equal(status.skipped, 2, 'the refusals are the measurement, and they were not counted');
});

test('a success resets the ladder, because one answered request is evidence the route works', () => {
  const time = clock();
  const breaker = new CircuitBreaker(config, time.now);
  breaker.recordFailure('c');
  breaker.recordFailure('c');
  breaker.recordSuccess('c');
  // The count restarts: two more failures are still below a threshold of three.
  assert.equal(breaker.recordFailure('c'), 'counted');
  assert.equal(breaker.recordFailure('c'), 'counted');
  assert.equal(breaker.status('c').state, 'closed');
});

test('the cooldown ends, one probe goes out, and a success closes it', () => {
  const time = clock();
  const breaker = new CircuitBreaker(config, time.now);
  for (let i = 0; i < 3; i += 1) breaker.recordFailure('c');
  assert.equal(breaker.status('c').retryAfterMs, 1_000);

  time.advance(1_000);
  assert.equal(breaker.allows('c'), true, 'the probe was never allowed, so the route could never recover');
  assert.equal(breaker.status('c').state, 'half-open');
  // Exactly one probe: a second request during the probe must not also go out, or a still-broken provider gets the
  // burst this exists to prevent.
  assert.equal(breaker.allows('c'), false, 'a second probe was allowed while the first was in flight');

  breaker.recordSuccess('c');
  assert.equal(breaker.status('c').state, 'closed');
  assert.equal(breaker.status('c').skipped, 1);
});

test('an inconclusive probe is released instead of latching the breaker forever', () => {
  const time = clock();
  const breaker = new CircuitBreaker(config, time.now);
  for (let i = 0; i < 3; i += 1) breaker.recordFailure('c');
  time.advance(1_000);

  assert.equal(breaker.allows('c'), true, 'the probe was not allowed');
  assert.equal(breaker.status('c').state, 'half-open');
  // A limiter refusal or a cancellation is not evidence about the provider.
  breaker.recordAbandoned('c');
  assert.equal(breaker.allows('c'), true, 'the probe stayed in flight, so the route is banned');
  breaker.recordSuccess('c');
  assert.equal(breaker.status('c').state, 'closed');
});

test('a failed probe re-opens it with double the wait, and the wait keeps doubling to the ceiling', () => {
  const time = clock();
  const breaker = new CircuitBreaker(config, time.now);
  for (let i = 0; i < 3; i += 1) breaker.recordFailure('c');
  assert.equal(breaker.status('c').retryAfterMs, 1_000, 'first trip waits the base');

  time.advance(1_000);
  breaker.allows('c');
  assert.equal(breaker.recordFailure('c'), 're-opened');
  assert.equal(breaker.status('c').retryAfterMs, 2_000, 'a failed probe did not double the cooldown');

  time.advance(2_000);
  breaker.allows('c');
  breaker.recordFailure('c');
  assert.equal(breaker.status('c').retryAfterMs, 4_000);
  time.advance(4_000);
  breaker.allows('c');
  breaker.recordFailure('c');
  assert.equal(breaker.status('c').retryAfterMs, 8_000);

  time.advance(8_000 * 4);
  breaker.allows('c');
  breaker.recordFailure('c');
  assert.ok(breaker.status('c').retryAfterMs <= 8_000, 'the doubling ran past the configured ceiling');
});

test('connections are independent, so one account does not silence its sibling', () => {
  const time = clock();
  const breaker = new CircuitBreaker(config, time.now);
  for (let i = 0; i < 3; i += 1) breaker.recordFailure('first');
  assert.equal(breaker.allows('first'), false);
  assert.equal(breaker.allows('second'), true, 'one account opened the breaker for another');
});

test('a threshold of zero disables it entirely', () => {
  const time = clock();
  const breaker = new CircuitBreaker({ failureThreshold: 0, baseCooldownMs: 1_000, maxCooldownMs: 8_000 }, time.now);
  for (let i = 0; i < 20; i += 1) breaker.recordFailure('c');
  assert.equal(breaker.allows('c'), true, 'the breaker was left on when it was configured off');
});

test('the defaults are a real policy, not a placeholder', () => {
  // Four consecutive failures is the point at which "the last four requests each waited out a timeout" is the honest
  // description; fifteen seconds is long enough to spare a burst and short enough that a blip does not hide a route.
  assert.equal(defaultBreakerConfig.failureThreshold, 4);
  assert.equal(defaultBreakerConfig.baseCooldownMs, 15_000);
  assert.ok(defaultBreakerConfig.maxCooldownMs >= defaultBreakerConfig.baseCooldownMs * 8);
});
