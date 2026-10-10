import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { GatewayService, LocalConnectionStore, InMemoryApiKeyStore, createGatewayServer } from '../dist/index.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

async function start(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-strategy-route-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory });
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('strategy-route')).key;
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 3 });
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, key, service };
}

test('a provider strategy can be set over HTTP, and the change is visible to routing at once', async (t) => {
  const { base, key, service } = await start(t);
  const response = await fetch(`${base}/v1/providers/openrouter/strategy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ strategy: 'round-robin' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).strategy, 'round-robin');
  assert.equal(service.providerStrategy('openrouter'), 'round-robin');
});

test('setting a provider strategy requires a key, because it changes how traffic is routed', async (t) => {
  const { base, service } = await start(t);
  const response = await fetch(`${base}/v1/providers/openrouter/strategy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy: 'round-robin' }),
  });
  assert.equal(response.status, 401, 'an unauthenticated caller cannot change routing');
  assert.equal(service.providerStrategy('openrouter'), 'priority', 'nothing changed');
});

test('an unknown strategy is refused with 400, and nothing is stored', async (t) => {
  const { base, key, service } = await start(t);
  const response = await fetch(`${base}/v1/providers/openrouter/strategy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ strategy: 'shuffle' }),
  });
  assert.equal(response.status, 400);
  assert.equal(service.providerStrategy('openrouter'), 'priority');
});

test('the routing report carries each provider\'s strategy, so the dashboard shows the choice in effect', async (t) => {
  const { base, key, service } = await start(t);
  await service.setProviderStrategy('openrouter', 'round-robin');
  const response = await fetch(`${base}/v1/routing`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.strategies?.openrouter, 'round-robin', 'the report names the strategy in effect for each provider');
});
