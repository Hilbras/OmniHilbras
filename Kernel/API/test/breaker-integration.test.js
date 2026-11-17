import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * The breaker, in the request path.
 *
 * An honest note about what this is worth, measured rather than assumed. `HealthManager` already ejects a failing
 * connection **between** requests — the first version of this test never got past one dispatch because the second
 * request's plan no longer contained the failing account. So the breaker's contribution is where health cannot help:
 *
 * - **inside one request**, where `maxRetries` can send the same failing route four times before anything has been
 *   recorded against it — the breaker stops at the threshold and the ledger says `CIRCUIT_OPEN` instead of pretending
 *   the provider was asked again;
 * - and **naming the skip**: a route that health quietly removes from the plan and a route the breaker refuses look the
 *   same to a user staring at "every provider route failed"; one of them is now a recorded attempt with a reason.
 */

const request = () => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

async function serviceWith({ retries = 0, breaker } = {}) {
  const store = new InMemoryConnectionStore();
  await store.save(
    { id: 'volatile', providerId: 'p', name: 'volatile', endpoint: 'https://p.example/v1', priority: 1, proxyPool: 'none', enabled: true, modelPolicy: 'all', modelIds: ['m'], resilience: { maxRetries: retries, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: 'key-volatile' },
  );

  let dispatches = 0;
  const registry = new ProviderRegistry().register({
    id: 'p',
    name: 'P',
    capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat() {
      dispatches += 1;
      throw new ProviderError('PROVIDER_REQUEST_FAILED', 'The provider timed out.', { providerId: 'p', publicMessage: 'The provider request failed.' });
    },
  });
  const service = new GatewayService(registry, store, store, new InMemoryApiKeyStore(), { breaker });
  return { service, dispatches: () => dispatches };
}

test('one request with four retries does not spend all four on a route that has already failed twice', async () => {
  const { service, dispatches } = await serviceWith({ retries: 3, breaker: { failureThreshold: 2, baseCooldownMs: 1_000, maxCooldownMs: 8_000 } });

  const outcome = await service.chatWithFailover(request(), undefined).catch((error) => error);

  assert.equal(dispatches(), 2, 'the breaker let the retries through past its threshold');
  // A total failure hands the ledger back on the error, under `details.attempts` — the same place the HTTP envelope
  // reads it from.
  const ledger = outcome.attempts ?? outcome.details?.attempts ?? [];
  const skipped = ledger.filter((attempt) => attempt.errorCode === 'CIRCUIT_OPEN');
  // One refusal is recorded, and it ends the route: the loop breaks out rather than asking again, so the two remaining
  // retries are not recorded twice — the saving is the dispatch count above (2 against 4), not the ledger length.
  assert.equal(skipped.length, 1, 'the ledger does not say the route was skipped rather than asked');
  assert.equal(skipped[0].connectionId, 'volatile');
});

test('with the breaker off, the same request spends every retry', async () => {
  // The control: same fixture, threshold 0. This is the behaviour before the breaker existed, and the difference is
  // the measurement — two dispatches against four.
  const { service, dispatches } = await serviceWith({ retries: 3, breaker: { failureThreshold: 0, baseCooldownMs: 1_000, maxCooldownMs: 8_000 } });
  await service.chatWithFailover(request(), undefined).catch(() => undefined);
  assert.equal(dispatches(), 4, 'the control did not dispatch every retry, so the comparison is not like for like');
});
