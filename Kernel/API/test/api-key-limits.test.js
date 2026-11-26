import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, LocalApiKeyStore } from '../dist/src/index.js';
import { InMemorySecretStore } from '../dist/src/core/index.js';
import { ApiKeyManager } from '../dist/src/core/api-key-manager.js';

/**
 * What a key may do, and for how long.
 *
 * A leaked key was unlimited: it could spend every provider's quota as fast as the network allowed, for ever. The
 * gateway-wide limit protects the provider; this protects the operator from one string that got out. Both limits are
 * enforced at the **gate**, before routing, so a key that may not use the gateway never reaches a provider and the
 * refusal is the same whichever endpoint it was aimed at.
 */

function manager(store = new InMemoryApiKeyStore()) {
  return { store, apiKeys: new ApiKeyManager(store, new InMemoryConnectionStore()) };
}

test('an expired key is refused, and the message says which date', async (t) => {
  const { store, apiKeys } = manager();
  const created = await store.create('old');
  await apiKeys.setLimits(created.record.id, { expiresAt: '2020-01-01T00:00:00.000Z' });
  await assert.rejects(
    () => apiKeys.authorize(created.key),
    (error) => {
      assert.equal(error.code, 'AUTHENTICATION_FAILED', 'an expired key was not an authentication failure');
      assert.match(String(error.message), /expired on 2020-01-01/, 'the refusal does not say when');
      return true;
    },
  );
});

test('a key with time left is accepted, and the limit can be cleared', async (t) => {
  const { store, apiKeys } = manager();
  const created = await store.create('young');
  await apiKeys.setLimits(created.record.id, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await apiKeys.authorize(created.key);

  await apiKeys.setLimits(created.record.id, { expiresAt: null });
  const [record] = await store.list();
  assert.equal(record.expiresAt, undefined, 'clearing the expiry left one behind');
  await apiKeys.authorize(created.key);
});

test('a rate limit is a sliding minute, and the refusal is a retry rather than a dead key', async (t) => {
  const { store, apiKeys } = manager();
  const created = await store.create('busy');
  await apiKeys.setLimits(created.record.id, { rpm: 3 });

  for (let i = 1; i <= 3; i += 1) await apiKeys.authorize(created.key);
  await assert.rejects(
    () => apiKeys.authorize(created.key),
    (error) => {
      assert.equal(error.code, 'RATE_LIMITED', 'a throttled key was reported as a dead one');
      assert.match(String(error.message), /3 requests a minute/);
      return true;
    },
  );
  // Still refused on the next attempt, because the window has not moved — this is a limit, not a one-shot.
  await assert.rejects(() => apiKeys.authorize(created.key), /3 requests a minute/);
});

test('one key being throttled does not throttle another', async (t) => {
  const { store, apiKeys } = manager();
  const busy = await store.create('busy');
  const quiet = await store.create('quiet');
  await apiKeys.setLimits(busy.record.id, { rpm: 1 });
  await apiKeys.authorize(busy.key);
  await assert.rejects(() => apiKeys.authorize(busy.key), /1 requests a minute/);
  await apiKeys.authorize(quiet.key);
  await apiKeys.authorize(quiet.key);
});

test('the limits are stored, so a restart does not forgive an expiry', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-limits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new LocalApiKeyStore({ directory, lastUsedFlushIntervalMs: 0 });
  const created = await first.create('persisted');
  await first.setLimits(created.record.id, { rpm: 60, expiresAt: '2027-01-01T00:00:00.000Z' });
  await first.close();

  const reopened = new LocalApiKeyStore({ directory, lastUsedFlushIntervalMs: 0 });
  t.after(() => reopened.close());
  const [record] = await reopened.list();
  assert.equal(record.rpm, 60, 'the rate limit did not reach the file');
  assert.equal(record.expiresAt, '2027-01-01T00:00:00.000Z', 'the expiry did not reach the file');
});

test('the route refuses a body that carries two intents', async (t) => {
  const store = new InMemoryApiKeyStore();
  const created = await store.create('one-intent');
  const service = new GatewayService(
    new ProviderRegistry().register({ id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: true }, async listModels() { return []; } }),
    new InMemorySecretStore({}),
    new InMemoryConnectionStore(),
    store,
  );
  const { createGatewayServer } = await import('../dist/src/index.js');
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const patched = await fetch(`http://127.0.0.1:${port}/v1/keys/${created.record.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${created.key}` },
    body: JSON.stringify({ rpm: 10, name: 'renamed' }),
  });
  assert.equal(patched.status, 400, 'two intents in one request were accepted');

  const limited = await fetch(`http://127.0.0.1:${port}/v1/keys/${created.record.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${created.key}` },
    body: JSON.stringify({ rpm: 10 }),
  });
  assert.equal(limited.status, 200);
  assert.equal((await limited.json()).apiKey.rpm, 10);
});

test('a budget, a token limit and an allowlist survive a restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new LocalApiKeyStore({ directory, lastUsedFlushIntervalMs: 0 });
  const created = await first.create('policy');
  await first.setLimits(created.record.id, { tpm: 500, budget: { usd: 2.5, period: 'month' }, allowedModels: ['gpt-*'], allowedProviders: ['openai'], allowedRoutes: ['/v1/chat/completions'] });
  await first.close();

  const reopened = new LocalApiKeyStore({ directory, lastUsedFlushIntervalMs: 0 });
  t.after(() => reopened.close());
  const [record] = await reopened.list();
  assert.equal(record.tpm, 500);
  assert.deepEqual(record.budget, { usd: 2.5, period: 'month' });
  assert.deepEqual(record.allowedModels, ['gpt-*']);
  assert.deepEqual(record.allowedProviders, ['openai']);
  assert.deepEqual(record.allowedRoutes, ['/v1/chat/completions']);
});
