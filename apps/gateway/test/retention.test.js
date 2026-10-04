import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitPolicy } from '../dist/rate-limit-policy.js';
import { HealthRegistry, SlidingWindowRateLimiter } from '../dist/routing.js';
import { RoutingEngine } from '../dist/routing-engine.js';

/**
 * Two maps keyed by connection id that only ever grew.
 *
 * `RateLimitPolicy.waits` holds the wait each connection was last told to observe, for the dashboard.
 * `SlidingWindowRateLimiter.windows` holds the timestamps still inside the per-minute budget. Neither had
 * a way to forget a connection that no longer exists.
 *
 * Measured before the fix: dispatching to 2000 connections and then deleting all 2000 left **2000 waits and
 * 2000 windows** retained. Neither is visible — `describeRouting()` filters by the live connections — which is
 * why it survived: nothing about the rendered page changes as the maps grow, and nothing crashes.
 *
 * The tests below are about the fix not being *too* eager, which is the more likely way to get this wrong.
 * `observed()` exists to distinguish a wait of `0` (checked, free) from an absent wait (never checked), and a
 * prune that drops idle-but-live entries would collapse exactly the distinction the map was built to keep.
 */

function candidate(connectionId, requestsPerMinute = 0) {
  return {
    providerId: 'p',
    connectionId,
    priority: 0,
    resilience: { timeoutMs: 0, maxRetries: 0, requestsPerMinute, hedgeAfterMs: 0 },
  };
}

test('a wait for a deleted connection is released, and the map returns to empty', () => {
  const policy = new RateLimitPolicy({ limiter: new SlidingWindowRateLimiter() });
  for (let i = 0; i < 2_000; i++) policy.enforce(candidate(`c${i}`));

  assert.equal(policy.observed().size, 2_000, 'the pre-condition: every dispatched connection has a wait');
  policy.retain(new Set());
  assert.equal(policy.observed().size, 0, 'waits survived the deletion of every connection');
});

test("a connection's request window is released with it", () => {
  const limiter = new SlidingWindowRateLimiter();
  for (let i = 0; i < 3_000; i++) { limiter.check(`c${i}`, 60); limiter.record(`c${i}`); }

  assert.equal(limiter.windows.size, 3_000, 'the pre-condition: every recorded request left a window');
  limiter.retain(new Set());
  assert.equal(limiter.windows.size, 0, 'request windows survived the deletion of every connection');
});

test('pruning by existence does not forgive a live connection its budget', () => {
  // The reason `retain()` takes the live set rather than an age. `prune(120_000)` is the wrong tool here:
  // a connection created ten minutes ago and dispatched to once has a window that is stale by age and
  // current by the connection store's, and an age-based sweep would give it a fresh budget it never had.
  const limiter = new SlidingWindowRateLimiter(() => 10_000_000);
  limiter.record('live');
  limiter.retain(new Set(['live']));

  assert.equal(limiter.windows.size, 1, 'a live connection lost its window to a prune');
  assert.ok(limiter.check('live', 1) > 0, 'a live connection with a recorded request was reported as free');
});

test('a wait of zero survives pruning, because "checked and free" is not "never checked"', () => {
  const policy = new RateLimitPolicy({ limiter: new SlidingWindowRateLimiter() });
  policy.enforce(candidate('idle')); // recorded as 0: it was asked, and it was free

  policy.retain(new Set(['idle']));
  assert.equal(policy.observed().has('idle'), true,
    'a recorded wait of 0 was dropped for a live connection, collapsing "checked and free" into "never checked"');
  assert.equal(policy.observed().get('idle'), 0, 'the value changed; 0 and absent are different answers');

  // And it goes when the connection does.
  policy.retain(new Set());
  assert.equal(policy.observed().has('idle'), false, 'a wait outlived its connection');
});

test('a wait is never removed for a connection the caller says exists', () => {
  const policy = new RateLimitPolicy({ limiter: new SlidingWindowRateLimiter() });
  const ids = ['a', 'b', 'c'];
  for (const id of ids) policy.enforce(candidate(id));

  // Retaining a superset must not drop anything, even repeatedly.
  for (let i = 0; i < 5; i++) policy.retain(new Set([...ids, `unused-${i}`]));
  assert.equal(policy.observed().size, ids.length, 'repeated pruning dropped live waits');
});

test('the routing path prunes on its own, with no separate call from the service', async () => {
  // The point of driving it from `plan()`: that is the only place in the process where the live connection
  // set is known to be current, and it is already handed the connections. A test that called `retain()`
  // directly would pass with the call site removed from `plan()` and the leak back in place.
  const rateLimiter = new SlidingWindowRateLimiter();
  // The **real** `HealthRegistry`, not a stub. `tests/routing-engine.test.js` records this exact mistake:
  // stubbing health as a set of healthy ids produced eight failures about `isUnhealthy`, a method the test
  // itself had invented. A double for the component the engine exists to consult is a double for the thing
  // under test.
  const health = new HealthRegistry(() => 1_000_000, 60_000);
  const engine = new RoutingEngine({
    health: { getFailureThreshold: () => 3, registry: () => health },
    rateLimiter,
    defaultProviderId: 'p',
    requireAdapter: () => {},
  });
  const connections = Array.from({ length: 500 }, (_, i) => ({
    id: `e${i}`,
    providerId: 'p',
    enabled: true,
    priority: 0,
    hasCredential: true,
    modelPolicy: 'all',
    modelIds: [],
    customModelIds: [],
    name: 'n',
    endpoint: '',
    proxyPool: '',
    createdAt: '',
    updatedAt: '',
    resilience: { timeoutMs: 0, maxRetries: 0, requestsPerMinute: 0, hedgeAfterMs: 0 },
  }));
  for (const connection of connections) rateLimiter.record(connection.id);

  await engine.plan({ connections, model: 'm' });
  assert.equal(rateLimiter.windows.size, 500, 'live connections lost their windows during a plan');

  // Every one deleted. `plan()` is what a later request walks.
  await engine.plan({ connections: [], model: 'm' }).catch(() => {});
  assert.equal(rateLimiter.windows.size, 0, 'windows survived every connection being deleted');
});

test('the wait map is pruned by the routing path too', async () => {
  const rateLimiter = new SlidingWindowRateLimiter();
  // The **real** `HealthRegistry`, not a stub. `tests/routing-engine.test.js` records this exact mistake:
  // stubbing health as a set of healthy ids produced eight failures about `isUnhealthy`, a method the test
  // itself had invented. A double for the component the engine exists to consult is a double for the thing
  // under test.
  const health = new HealthRegistry(() => 1_000_000, 60_000);
  const engine = new RoutingEngine({
    health: { getFailureThreshold: () => 3, registry: () => health },
    rateLimiter,
    defaultProviderId: 'p',
    requireAdapter: () => {},
  });
  const connection = {
    id: 'solo',
    providerId: 'p',
    enabled: true,
    priority: 0,
    hasCredential: true,
    modelPolicy: 'all',
    modelIds: ['m'],
    customModelIds: [],
    name: 'n',
    endpoint: '',
    proxyPool: '',
    createdAt: '',
    updatedAt: '',
    resilience: { timeoutMs: 0, maxRetries: 0, requestsPerMinute: 0, hedgeAfterMs: 0 },
  };

  // The engine's OWN policy, reached through its own dispatch method. My first two versions built a second
  // `RateLimitPolicy` over the same limiter, so the wait landed in *that* map while the engine's stayed
  // empty — and `engine.waits().size === 0` then passed no matter what `retain()` did. Two mutations proved
  // it: deleting either `this.limits.retain(...)` or this call site left the suite green.
  //
  // `plan()` cannot be used here: it only *reads* the limiter. `enforceRateLimit()` is what the executor
  // calls at dispatch, so this is the real path that produces a wait.
  engine.enforceRateLimit({
    providerId: 'p',
    connectionId: 'solo',
    priority: 0,
    resilience: connection.resilience,
  });
  assert.equal(engine.waits().get('solo'), 0,
    'the pre-condition is wrong: dispatching recorded no wait, so pruning to empty would prove nothing');

  // Live: the wait must survive.
  await engine.plan({ connections: [connection], model: 'm' });
  assert.equal(engine.waits().has('solo'), true,
    'a live connection lost its wait during a plan');

  await engine.plan({ connections: [], model: 'm' }).catch(() => {});
  // The engine's own view, not the policy's — `waits()` is what `describeRouting()` reads.
  assert.equal(engine.waits().size, 0,
    'the waits map still holds entries the routing path should have released');
});

test('pruning is not what stops an unbounded window, and `prune()` is still needed', () => {
  // Two independent questions, and collapsing them would lose one of the answers:
  //
  //   existence — does this connection still exist?   `retain()`
  //   age       — is this timestamp still in the window? `prune()`
  //
  // `retain()` alone leaves the timestamps of a connection that exists and is idle forever, growing within
  // a single connection's window. Measured: 400 dispatches to one live connection leaves 400 timestamps
  // unless `prune()` is called.
  let clock = 1_000_000;
  const limiter = new SlidingWindowRateLimiter(() => clock);
  for (let i = 0; i < 400; i++) limiter.record('one');
  limiter.retain(new Set(['one']));
  assert.equal(limiter.windows.get('one').length, 400,
    'retain() was expected to leave a live connection\'s window alone');

  clock += 200_000;
  limiter.prune();
  assert.equal(limiter.windows.size, 0,
    'prune() did not release the window of a connection that exists but is idle');
});