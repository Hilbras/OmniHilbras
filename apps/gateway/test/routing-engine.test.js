import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { RoutingEngine } from '../dist/routing-engine.js';
import { HealthRegistry, SlidingWindowRateLimiter } from '../dist/routing.js';
import { ProviderError } from '@hilbras/omnihilbras';

/**
 * `RoutingEngine`: which routes a request may take, given what is currently true.
 *
 * The behaviour here was already covered end-to-end through the service. These tests are for the
 * decisions that are easy to get subtly wrong and invisible when they are: when the unmanaged
 * fallback applies and — more importantly — when it must not, and whether a refused connection
 * records the wait that made it refuse.
 */

const resilience = (over = {}) => ({ maxRetries: 0, timeoutMs: 30_000, requestsPerMinute: 60, hedgeAfterMs: 0, ...over });

const connection = (over = {}) => ({
  id: 'c1',
  providerId: 'p',
  name: 'P',
  endpoint: 'https://p.invalid',
  enabled: true,
  hasCredential: true,
  modelIds: ['m'],
  priority: 1,
  resilience: resilience(),
  ...over,
});

/**
 * An engine over the *real* `HealthRegistry` and rate limiter.
 *
 * My first version stubbed health as a set of healthy ids, and the stub was the wrong shape —
 * `resolveRoute` asks `isUnhealthy(providerId, threshold)`. A double for the component the engine
 * exists to consult is a double for the thing under test, and the mismatch showed up as eight
 * failures about a method the test itself had invented.
 */
function engine({ failures = 0, threshold = 3, known = ['p', 'openai'], now } = {}) {
  const clock = { value: 1_000_000 };
  const readClock = () => clock.value;
  const health = new HealthRegistry(readClock, 60_000);
  for (let index = 0; index < failures; index += 1) health.recordFailure('p', 'PROVIDER_UNAVAILABLE', 'down');
  const limiter = new SlidingWindowRateLimiter(now ? () => now() : readClock);
  const instance = new RoutingEngine({
    health: { getFailureThreshold: () => threshold, registry: () => health },
    rateLimiter: limiter,
    defaultProviderId: 'openai',
    requireAdapter: (providerId) => { if (!known.includes(providerId)) throw new ProviderError('NOT_FOUND', `Provider adapter is not registered: ${providerId}.`); },
  });
  return { instance, health, clock };
}

test('a healthy connection that owns the model is the route', async () => {
  const { instance } = engine();
  const decision = await instance.plan({ connections: [connection()], model: 'm' });
  assert.deepEqual(decision.candidates.map((candidate) => candidate.providerId), ['p']);
});

test('an unhealthy connection is skipped, and the reason says why', async () => {
  // The reason is the answer the operator needs. Returning an empty candidate list with no reason
  // makes "your provider is down" and "you have not connected a provider" look identical.
  const { instance } = engine({ failures: 3, threshold: 3 });
  const decision = await instance.plan({ connections: [connection()], model: 'm' });
  assert.deepEqual(decision.candidates, []);
  assert.deepEqual(decision.skipped, [{ providerId: 'p', reason: 'unhealthy' }]);
});

test('a model no connection lists still routes, because a provider can serve a model its catalog omits', async () => {
  // I assumed the opposite when I wrote this, and the code was right. A saved catalog is what the
  // provider told us *when we connected*; a model added to the account afterwards, or served under
  // an id the catalog spells differently, would otherwise be unroutable forever. Falling back to any
  // usable connection is what makes a manually added model work.
  const { instance } = engine();
  const decision = await instance.plan({ connections: [connection()], model: 'other' });
  assert.deepEqual(decision.candidates.map((candidate) => candidate.providerId), ['p']);
  assert.deepEqual(decision.skipped, [], 'and nothing is reported as skipped, because nothing was');
});

test('with no connections at all, the requested provider is served directly', async () => {
  // An embedded service — a registry and a secret store, no connection store — has nothing to route
  // on. An empty route list would be a confusing way of saying *you have not configured anything
  // yet*.
  const { instance } = engine();
  const decision = await instance.plan({ connections: [], model: 'm', explicitProviderId: 'p' });
  assert.equal(decision.candidates.length, 1);
  assert.equal(decision.candidates[0].providerId, 'p');
  assert.equal(decision.candidates[0].connectionId, 'unmanaged:p');
});

test('unmanaged is a last resort, not a fallback: skipped connections still explain themselves', async () => {
  // With connections present and every one skipped, the decision must come back as-is. Falling
  // through to unmanaged would serve a provider the operator has not connected and hide the reason
  // every real route was refused.
  const { instance } = engine({ failures: 3, threshold: 3 });
  const decision = await instance.plan({ connections: [connection()], model: 'm' });
  assert.deepEqual(decision.candidates, [], 'no route is invented');
  assert.deepEqual(decision.skipped, [{ providerId: 'p', reason: 'unhealthy' }], 'and the reason survives');
});

test('an unmanaged route is labelled so nothing later mistakes it for a connection', async () => {
  // Later code reads this id to look up a credential and to record health. An id that looked like a
  // real connection would be read against a connection that does not exist.
  const { instance } = engine();
  const decision = await instance.plan({ connections: [], model: 'm' });
  assert.match(decision.candidates[0].connectionId, /^unmanaged:/);
});

test('an unregistered provider is named rather than served', async () => {
  // Falling through to unmanaged for a provider nobody registered would start building an adapter
  // for it and fail later, somewhere less informative.
  const { instance } = engine({ known: ['openai'] });
  await assert.rejects(
    () => instance.plan({ connections: [], model: 'm', explicitProviderId: 'imaginary' }),
    (error) => error instanceof ProviderError && /not registered: imaginary/.test(error.message),
  );
});

test('an unconfigured gateway defaults to the provider it was told to default to', async () => {
  const { instance } = engine();
  const decision = await instance.plan({ connections: [], model: 'm' });
  assert.equal(decision.candidates[0].providerId, 'openai', 'and the default is a parameter, so the Core carries no provider name');
});

test('an unmanaged route carries a real deadline, not an empty one', async () => {
  // `withDeadline` treats a non-positive timeout as *no deadline at all*, so a default of zero meant
  // a provider that stopped responding held the request open forever — while `withDeadline` and the
  // SPEC both promised the opposite. This is the assertion that caught it.
  const { instance } = engine();
  const decision = await instance.plan({ connections: [], model: 'm' });
  const [candidate] = decision.candidates;
  assert.ok(candidate.resilience.timeoutMs > 0, 'a request that can never time out is not a default');
  assert.equal(candidate.resilience.requestsPerMinute, 0, 'and no rate limit is right for a local single-user gateway');
});

test('a rate-limited connection refuses by name and records the wait', async () => {
  // Both halves matter. The refusal has to name the limit so the user knows what they hit, and the
  // wait has to be recorded — a connection that refuses traffic while looking ready to the
  // dashboard is a connection an operator will keep sending to.
  let clock = 1_000_000;
  const { instance } = engine({ now: () => clock });
  const candidate = { providerId: 'p', connectionId: 'c1', priority: 0, resilience: resilience({ requestsPerMinute: 1 }) };
  // The request path checks, then records when the request is dispatched. Asking costs nothing, so
  // the first check allows and only that first dispatch spends the budget.
  assert.doesNotThrow(() => instance.enforceRateLimit(candidate));
  instance.recordRequest('c1');
  assert.throws(() => instance.enforceRateLimit(candidate), (error) => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.match(error.message, /limit of 1 requests per minute/);
    assert.equal(error.retryable, true, 'a limited connection hands off to the next route rather than retrying');
    return true;
  });
  assert.ok(instance.waits().get('c1') > 0, 'the wait is recorded, so the dashboard can show the connection cooling down');
  clock += 61_000;
  assert.doesNotThrow(() => instance.enforceRateLimit(candidate), 'and the window slides');
});

test('a connection that is not over its limit records a wait of zero rather than nothing', async () => {
  // Absent and zero are different answers: absent means "never checked", which the dashboard reads
  // as unknown rather than ready.
  const { instance } = engine();
  const candidate = { providerId: 'p', connectionId: 'fresh', priority: 0, resilience: resilience() };
  instance.enforceRateLimit(candidate);
  assert.equal(instance.waits().get('fresh'), 0);
});

test('the waits are readable, and a sent request is not a wait', async () => {
  // A request that went out is not a wait. Collapsing the two would leave a connection that has
  // been busy looking like one that is cooling down.
  const { instance } = engine();
  assert.equal(instance.waits().size, 0);
  instance.recordRequest('c1');
  assert.equal(instance.waits().size, 0);
});

test('THE INVARIANT: the engine names no provider', () => {
  // `defaultProviderId` is a constructor parameter for exactly this reason. If a provider name ever
  // appears in this file, a routing change has gone back to needing a Core edit.
  const source = readFileSync(new URL('../src/routing-engine.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const offenders = [...code.matchAll(/['"]([a-z0-9]+(?:-[a-z0-9]+)+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(offenders, [], `the engine must contain no provider id, found: ${offenders.join(', ')}`);
});
