import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * The connection list reports when a session ends.
 *
 * Reported as *"the auth does not save, it lasts about an hour"*, and the dashboard had no way to tell an expiring
 * session from a fresh one: both rows said "credential accepted". The gateway had the expiry all along — it is the
 * field its own renewal pass filters on — so this exposes it rather than inventing a second guess.
 */

const capabilities = { chat: true, streaming: false, models: true, embeddings: false };
const resilience = { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 };

function save(store, id, priority, credential) {
  return store.save(
    { id, providerId: 'p', name: id, endpoint: 'https://p.example/v1', priority, proxyPool: 'none', enabled: true, modelPolicy: 'all', resilience, modelIds: ['m'] },
    credential,
  );
}

test('each credential reports its expiry and one of five states', async () => {
  const store = new InMemoryConnectionStore();
  const soon = new Date(Date.now() + 10 * 60_000).toISOString();
  const past = new Date(Date.now() - 5 * 60_000).toISOString();
  const fresh = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
  await save(store, 'soon', 1, { type: 'oauth', value: 'a', refreshToken: 'r1', expiresAt: soon });
  await save(store, 'past', 2, { type: 'oauth', value: 'b', refreshToken: 'r2', expiresAt: past });
  await save(store, 'fresh', 3, { type: 'oauth', value: 'c', refreshToken: 'r3', expiresAt: fresh });
  await save(store, 'nodate', 4, { type: 'oauth', value: 'd', refreshToken: 'r4' });
  await save(store, 'keyed', 5, { type: 'api-key', value: 'sk-live' });
  await save(store, 'keyless', 6, { type: 'none' });

  const registry = new ProviderRegistry().register({
    id: 'p', name: 'P', capabilities,
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
  });
  const service = new GatewayService(registry, store, store, undefined, {});

  const rows = new Map((await service.listConnectionsWithExpiry()).map((row) => [row.id, row]));

  assert.equal(rows.get('soon').credentialState, 'expiring', 'a session inside the renewal window reads as fine');
  assert.equal(rows.get('soon').credentialExpiresAt, soon, 'the expiry itself is not reported');
  assert.equal(rows.get('past').credentialState, 'expired', 'an expired session reads as working');
  assert.equal(rows.get('fresh').credentialState, 'valid');
  assert.equal(rows.get('nodate').credentialState, 'unknown', 'a credential with no readable expiry claimed one');
  assert.equal(rows.get('nodate').credentialExpiresAt, undefined);
  assert.equal(rows.get('keyed').credentialState, 'unknown', 'an API key claims an expiry it does not have');
  assert.equal(rows.get('keyless').credentialState, 'none', 'a deliberately keyless connection is not "unknown"');
});

test('the plain connection list stays cheap and carries no credential fields', async () => {
  // The routing and renewal paths call `listConnections()` on every pass; decrypting every credential there to
  // produce a label nothing reads would be paid by requests, not by one dashboard page.
  const store = new InMemoryConnectionStore();
  await save(store, 'one', 1, { type: 'oauth', value: 'a', refreshToken: 'r', expiresAt: new Date().toISOString() });
  const registry = new ProviderRegistry().register({
    id: 'p', name: 'P', capabilities,
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
  });
  const service = new GatewayService(registry, store, store, undefined, {});

  const [row] = await service.listConnections();
  assert.equal(row.credentialState, undefined, 'the hot path started reporting expiry');
});
