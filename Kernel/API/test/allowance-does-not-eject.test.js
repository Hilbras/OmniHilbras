import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * A spent account must not eject the account that is working.
 *
 * This is the failure as it was reported, reproduced from the live gateway: ZCode, two accounts, the
 * first out of quota and the second answering normally. The request failed with
 *
 *     PROVIDER_REQUEST_FAILED: ZCode refused the turn: exceed quota limit Tried: zcode.
 *
 * — **one** account tried, while the second one answered when it was asked directly. Three mechanisms
 * had to line up for that, and each is pinned below:
 *
 * 1. The first account of a provider is saved **under the provider id** (`zcode`, and the same shape
 *    for every card whose first sign-in writes `providerId` as the connection id). So
 *    `recordFailure(connectionId: 'zcode')` and `recordFailure(providerId: 'zcode')` are the *same
 *    counter* — and `isUnhealthy(connection.providerId)` made the sibling read the first account's
 *    failures. Reading "the provider is unhealthy" from a counter that belongs to one connection is the
 *    aliasing this pins: `providerKeyIsAConnection`.
 * 2. Ejection **escalates** (`30 s × 2^(failures - threshold)`), so the live gateway held both
 *    accounts — including the working one — out for about half an hour once nine failures had piled up.
 * 3. A quota refusal arrives as `PROVIDER_REQUEST_FAILED`, not `RATE_LIMITED`, so it was charged to the
 *    failure counter at all. It is an allowance fact about one credential; it must not count as
 *    ill-health, and the per-account-per-model cooldown is what should carry it.
 */

const answer = (key, request) => ({
  id: 'r',
  providerId: 'p',
  model: request.model,
  createdAt: new Date().toISOString(),
  message: { role: 'assistant', content: `by ${key}` },
  finishReason: 'stop',
});

/** The refusal ZCode actually sends: a `200`-shaped business envelope, no HTTP status, wording only. */
const quotaRefusal = () => new ProviderError('PROVIDER_REQUEST_FAILED', 'ZCode refused the turn: exceed quota limit', {
  providerId: 'p',
  publicMessage: 'ZCode refused the turn: exceed quota limit',
  details: { providerMessage: 'exceed quota limit' },
});

/**
 * Two accounts, the first saved **under the provider id** exactly as the gateway saves it.
 */
async function twoAccounts(providerId = 'p', behaviour) {
  const seen = [];
  const registry = new ProviderRegistry();
  registry.register({
    id: providerId,
    name: 'P',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'm', providerId }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
    async chat(request, context) {
      const key = context?.credential?.value;
      seen.push(key);
      return behaviour(key, request);
    },
    async *streamChat() {},
  });
  const store = new InMemoryConnectionStore();
  const connection = (id, priority) => ({
    id,
    providerId,
    name: id,
    endpoint: 'https://p.example/v1',
    priority,
    proxyPool: 'none',
    modelIds: ['m'],
    resilience: { maxRetries: 0 },
  });
  // `providerId` as the first account's id is the whole point: it is what the live vault holds.
  await store.save(connection(providerId, 1), { type: 'api-key', value: 'spent' });
  await store.save(connection(`${providerId}-second`, 2), { type: 'api-key', value: 'working' });
  return { seen, store, service: new GatewayService(registry, store, store, new InMemoryApiKeyStore(), { failureThreshold: 2 }) };
}

const chat = (extra = {}) => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra });
const signal = () => new AbortController().signal;

test('the working sibling keeps serving no matter how often the spent account refuses', async () => {
  const { seen, service } = await twoAccounts('p', (key, request) => {
    if (key === 'spent') throw quotaRefusal();
    return answer(key, request);
  });

  // Well past the failure threshold, and past the point where the live gateway had ejected both.
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    seen.length = 0;
    const outcome = await service.chatWithFailover(chat(), undefined, signal());
    assert.match(outcome.response.message.content, /working/, `request ${attempt} was served by the healthy account`);
    assert.deepEqual(seen, ['spent', 'working'], `request ${attempt}: the spent account is tried first, then the sibling`);
  }
});

test('a spent account does not eject its sibling through the provider id', async () => {
  const { service } = await twoAccounts('p', (key, request) => {
    if (key === 'spent') throw quotaRefusal();
    return answer(key, request);
  });

  // Drive the first account well past the threshold.
  for (let attempt = 0; attempt < 5; attempt += 1) await service.chatWithFailover(chat(), undefined, signal());

  // The sibling must still be a candidate. Before the fix the provider-level read saw the first
  // account's counter and skipped it as `unhealthy`.
  const plan = await service.planRoute('m');
  assert.deepEqual(plan.candidates.map((c) => c.connectionId), ['p', 'p-second'], 'both accounts remain routable');
  assert.deepEqual(plan.skipped, [], 'and neither is skipped as unhealthy');
});

test('an exhausted allowance is not charged to provider health at all', async () => {
  const { service } = await twoAccounts('p', (key, request) => {
    if (key === 'spent') throw quotaRefusal();
    return answer(key, request);
  });
  for (let attempt = 0; attempt < 5; attempt += 1) await service.chatWithFailover(chat(), undefined, signal());

  const health = service.healthManager;
  const snapshot = health.snapshot('p') ?? {};
  assert.equal(snapshot.ejected, undefined, 'the provider is not ejected over a spent credential');
  assert.ok((snapshot.failures ?? 0) === 0, `failures stay at zero, saw ${snapshot.failures}`);
});

test('the sweep does not eject a provider because a credential has no allowance', async () => {
  const providerId = 'p';
  const seen = [];
  const registry = new ProviderRegistry();
  registry.register({
    id: providerId,
    name: 'P',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'm', providerId }]; },
    // The sweep spends a real turn for this provider, and an out-of-quota account refuses it.
    async healthCheck() { return { status: 'unavailable', checkedAt: new Date().toISOString(), message: 'ZCode refused the turn: exceed quota limit' }; },
    async chat(request, context) {
      const key = context?.credential?.value;
      seen.push(key);
      if (key === 'spent') throw quotaRefusal();
      return answer(key, request);
    },
    async *streamChat() {},
  });
  const store = new InMemoryConnectionStore();
  const connection = (id, priority) => ({ id, providerId, name: id, endpoint: 'https://p.example/v1', priority, proxyPool: 'none', modelIds: ['m'], resilience: { maxRetries: 0 } });
  await store.save(connection(providerId, 1), { type: 'api-key', value: 'spent' });
  await store.save(connection(`${providerId}-second`, 2), { type: 'api-key', value: 'working' });
  const service = new GatewayService(registry, store, store, new InMemoryApiKeyStore(), { failureThreshold: 2 });

  // Three sweeps: enough to cross a threshold of two, which is what the live gateway had done nine times.
  for (let sweep = 0; sweep < 3; sweep += 1) await service.refreshHealth();

  const plan = await service.planRoute('m');
  assert.deepEqual(plan.candidates.map((c) => c.connectionId), ['p', 'p-second'], 'a spent credential does not eject the provider');

  seen.length = 0;
  const outcome = await service.chatWithFailover(chat(), undefined, signal());
  assert.match(outcome.response.message.content, /working/, 'and the working account still serves');
});
