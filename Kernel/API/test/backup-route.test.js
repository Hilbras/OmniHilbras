import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

/**
 * Export and import over HTTP, because the UI talks to these routes and a service-level test cannot
 * catch a body that the route drops. A backup that exports but will not import is worse than none.
 */

const connection = {
  id: 'openrouter',
  providerId: 'openrouter',
  name: 'Primary',
  endpoint: 'https://openrouter.ai/api/v1',
  priority: 1,
  proxyPool: 'none',
};

async function startServer(t) {
  const store = new InMemoryConnectionStore();
  await store.save(connection, { type: 'api-key', value: 'sk-or-secret' });
  const service = new GatewayService(new ProviderRegistry(), store, store, new InMemoryApiKeyStore());
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173', publicBaseUrl: 'http://127.0.0.1:8787' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, 'object');
  return { base: `http://127.0.0.1:${address.port}`, store };
}

const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
  body: JSON.stringify(body),
});

test('an exported envelope imports over HTTP and restores the credential', async (t) => {
  const { base, store } = await startServer(t);
  const exported = await post(base, '/v1/backup/export', { passphrase: 'correct horse battery' });
  assert.equal(exported.status, 200);
  const { backup } = await exported.json();
  assert.equal(JSON.stringify(backup).includes('sk-or-secret'), false, 'the envelope is not encrypted');

  const imported = await post(base, '/v1/backup/import', { passphrase: 'correct horse battery', backup, confirmReplace: true });
  const body = await imported.json();
  assert.equal(imported.status, 200, JSON.stringify(body));
  assert.equal(body.connections, 1);
  assert.equal(body.removed, 1);
  assert.deepEqual(await store.get('openrouter'), { type: 'api-key', value: 'sk-or-secret' });
});

test('import refuses without confirmation, with a wrong passphrase, or with a non-envelope', async (t) => {
  const { base } = await startServer(t);
  const { backup } = await (await post(base, '/v1/backup/export', { passphrase: 'correct horse battery' })).json();

  const unconfirmed = await post(base, '/v1/backup/import', { passphrase: 'correct horse battery', backup });
  assert.equal(unconfirmed.status, 400);

  const wrong = await post(base, '/v1/backup/import', { passphrase: 'wrong horse battery', backup, confirmReplace: true });
  assert.equal(wrong.status, 400);

  const junk = await post(base, '/v1/backup/import', { passphrase: 'correct horse battery', backup: { format: 'nope' }, confirmReplace: true });
  assert.equal(junk.status, 400);
});
