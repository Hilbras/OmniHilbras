import assert from 'node:assert/strict';
import test from 'node:test';
import { TokenRenewal } from '../dist/index.js';

// An OAuth session that expires while nobody is using it fails the first request of the next burst. The renewal
// pass runs on its own timer and refreshes any connection whose token expires soon, so the burst meets a live token.

function source(connections) {
  const renewed = [];
  return {
    renewed,
    source: {
      connections: async () => connections,
      renew: async (connection) => { renewed.push(connection.id); },
    },
  };
}

test('a token expiring within the window is renewed without any request', async () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const soon = { id: 'soon', providerId: 'cline', expiresAt: new Date(now + 10 * 60_000).toISOString() };
  const far = { id: 'far', providerId: 'cline', expiresAt: new Date(now + 2 * 3600_000).toISOString() };
  const { renewed, source: deps } = source([soon, far]);
  const renewal = new TokenRenewal(deps, { now: () => now, windowMs: 30 * 60_000 });
  await renewal.pass();
  assert.deepEqual(renewed, ['soon'], 'the token expiring in 10 minutes is renewed; the one valid for 2 hours is not touched');
});

test('a connection with no expiry is left alone rather than renewed on every pass', async () => {
  const noExpiry = { id: 'api', providerId: 'openrouter' };
  const { renewed, source: deps } = source([noExpiry]);
  const renewal = new TokenRenewal(deps, { now: () => Date.now(), windowMs: 30 * 60_000 });
  await renewal.pass();
  assert.deepEqual(renewed, []);
});

test('a failed renewal does not stop the pass from renewing the rest', async () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const a = { id: 'a', providerId: 'cline', expiresAt: new Date(now + 60_000).toISOString() };
  const b = { id: 'b', providerId: 'cline', expiresAt: new Date(now + 60_000).toISOString() };
  const renewed = [];
  const renewal = new TokenRenewal({
    connections: async () => [a, b],
    renew: async (connection) => {
      if (connection.id === 'a') throw new Error('network blip');
      renewed.push(connection.id);
    },
  }, { now: () => now, windowMs: 30 * 60_000 });
  await renewal.pass();
  assert.deepEqual(renewed, ['b'], 'one connection failing does not block the others');
});

test('stopping the renewal clears its timer, so nothing is left running at shutdown', async () => {
  const renewal = new TokenRenewal({ connections: async () => [], renew: async () => {} }, { now: () => Date.now(), windowMs: 1, intervalMs: 60_000 });
  renewal.start();
  assert.equal(renewal.running(), true);
  renewal.stop();
  assert.equal(renewal.running(), false);
});

test('the service renews an OAuth connection whose token is near expiry, and leaves a fresh one alone', async () => {
  const { GatewayService, InMemoryConnectionStore } = await import('../dist/index.js');
  const { InMemorySecretStore, ProviderRegistry } = await import('@hilbras/omnihilbras');
  const now = Date.now();
  const validated = [];
  const adapter = {
    id: 'oauthprov',
    name: 'OAuth provider',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'm', providerId: 'oauthprov' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString() }; },
    isCredentialExpired(credential, at = Date.now()) {
      if (credential?.type !== 'oauth' || typeof credential.expiresAt !== 'string') return undefined;
      return Date.parse(credential.expiresAt) <= at;
    },
    async validateCredential(credential) {
      validated.push(credential.value);
      return { status: 'valid', checkedAt: new Date().toISOString() };
    },
  };
  const store = new InMemoryConnectionStore();
  const connection = (id, expiresInMs) => ({ id, providerId: 'oauthprov', name: id, endpoint: 'https://o.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } });
  await store.save(connection('soon', 0), { type: 'oauth', value: 'soon-token', refreshToken: 'r', expiresAt: new Date(now + 10 * 60_000).toISOString() });
  await store.save(connection('far', 0), { type: 'oauth', value: 'far-token', refreshToken: 'r', expiresAt: new Date(now + 2 * 3600_000).toISOString() });
  const service = new GatewayService(new ProviderRegistry().register(adapter), store, store, undefined, { failureThreshold: 1_000 });
  service.setHealthInterval(0);
  await service.renewExpiringTokens();
  assert.deepEqual(validated, ['soon-token'], 'only the token expiring within 30 minutes is refreshed');
});

test('the service runs renewal on a timer and clears it on close, so nothing renews after shutdown begins', async () => {
  const { GatewayService, InMemoryConnectionStore } = await import('../dist/index.js');
  const { ProviderRegistry } = await import('@hilbras/omnihilbras');
  const store = new InMemoryConnectionStore();
  const service = new GatewayService(new ProviderRegistry(), store, store, undefined, { failureThreshold: 1_000 });
  service.startTokenRenewal(60_000);
  assert.equal(service.tokenRenewalTimer?.running(), true, 'the renewal timer is running after start');
  await service.close();
  assert.equal(service.tokenRenewalTimer?.running(), false, 'close stops renewal before anything drains');
});
