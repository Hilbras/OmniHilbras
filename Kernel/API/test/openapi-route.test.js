import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

async function start(t) {
  const apiKeys = new InMemoryApiKeyStore();
  const owner = await apiKeys.create('Owner');
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), apiKeys, {});
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, owner };
}

test('the OpenAPI route serves the dispatcher inventory and is management-gated', async (t) => {
  const { base, owner } = await start(t);
  const unauth = await fetch(`${base}/v1/openapi`);
  assert.equal(unauth.status, 401, 'the inventory names the management surface, so it is not public');

  const response = await fetch(`${base}/v1/openapi`, { headers: { authorization: `Bearer ${owner.key}` } });
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.equal(document.openapi, '3.1.0');
  assert.equal(document.info.title, 'OmniHilbras Gateway');
  assert.ok(document.paths['/v1/connections'], 'the connections route is missing');
  assert.ok(document.paths['/v1/openapi'], 'the inventory does not name itself');
  assert.ok(document.paths['/v1/connections/'], 'the connections prefix is missing');
  assert.deepEqual(document['x-omnihilbras-prefixes'], document['x-omnihilbras-prefixes'].filter((path) => path.endsWith('/')));
});
