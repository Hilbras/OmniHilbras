import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

/**
 * Forgetting a model ID this gateway added.
 *
 * `customModelIds` is the record of what the add-model control wrote, and until this route existed nothing
 * could shrink it: `POST /v1/connections/:id/models` refuses an empty list, so an ID typed by hand — a typo, a
 * model the provider retired, an experiment — stayed in the catalogue for good.
 *
 * The route is a `DELETE` on the same path the add uses, which is also why the ordering below is asserted: the
 * connection-delete route matches every path under `/v1/connections/`, so a branch that lost its place would
 * delete the connection instead of one model from it.
 */

async function gateway(t) {
  const store = new InMemoryConnectionStore();
  const apiKeys = new InMemoryApiKeyStore();
  const { key } = await apiKeys.create('test');
  const service = new GatewayService(new ProviderRegistry(), store, store, apiKeys, {});
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173', publicBaseUrl: 'http://127.0.0.1:20138' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, key, store };
}

/** The stored record. `store.get` is the credential store's getter, not the connection's metadata. */
const record = async (store, id = 'acct') => (await store.list()).find((connection) => connection.id === id);

const call = (base, key, path, method, body) => fetch(`${base}${path}`, {
  method,
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', origin: 'http://localhost:5173' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** A connection whose provider reports `discovered`, with `added` typed in by hand on top of it. */
async function connectionWith(store, discovered, added) {
  await store.save(
    { id: 'acct', providerId: 'openrouter', name: 'Primary', endpoint: 'https://openrouter.ai/api/v1', priority: 1, proxyPool: 'none', modelIds: discovered },
    { type: 'api-key', value: 'sk-test' },
  );
  if (added.length > 0) await store.updateModels('acct', added);
}

test('a model added by hand can be removed, and the provider’s own catalogue is untouched', async (t) => {
  const { base, key, store } = await gateway(t);
  await connectionWith(store, ['provider/reported-model'], ['hand/typed-typo']);
  assert.deepEqual((await record(store)).modelIds.length, 2);

  const response = await call(base, key, '/v1/connections/acct/models', 'DELETE', { modelIds: ['hand/typed-typo'] });
  assert.equal(response.status, 200, await response.clone().text());
  const { connection } = await response.json();
  assert.deepEqual(connection.modelIds, ['provider/reported-model'], 'the added id is gone');
  assert.deepEqual(connection.customModelIds, [], 'and it is gone from the operator’s list too');

  const persisted = await record(store);
  assert.equal(persisted.modelIds.includes('hand/typed-typo'), false, 'the removal did not persist');
  assert.equal(persisted.hasCredential, true, 'the connection itself must survive the request');
});

test('a model the provider reported is not removable, and the request says so rather than pretending', async (t) => {
  const { base, key, store } = await gateway(t);
  await connectionWith(store, ['provider/reported-model'], []);
  const response = await call(base, key, '/v1/connections/acct/models', 'DELETE', { modelIds: ['provider/reported-model'] });
  assert.equal(response.status, 404, 'removing a discovered model is a removal the next rescan would undo');
  assert.deepEqual((await record(store)).modelIds, ['provider/reported-model']);
});

test('an empty list clears every added model and leaves the discovered ones', async (t) => {
  const { base, key, store } = await gateway(t);
  await connectionWith(store, ['provider/one', 'provider/two'], ['hand/one', 'hand/two']);

  const response = await call(base, key, '/v1/connections/acct/models', 'DELETE', { modelIds: [] });
  assert.equal(response.status, 200, await response.clone().text());
  const { connection } = await response.json();
  assert.deepEqual(connection.customModelIds, []);
  assert.deepEqual(connection.modelIds.sort(), ['provider/one', 'provider/two'], 'only the additions were cleared');
});

test('the route order holds: deleting models does not delete the connection', async (t) => {
  const { base, key, store } = await gateway(t);
  await connectionWith(store, ['provider/one'], ['hand/one']);

  await call(base, key, '/v1/connections/acct/models', 'DELETE', { modelIds: ['hand/one'] });
  assert.equal((await store.list()).length, 1, 'the connection was deleted by a request that named a model');

  // And the connection's own delete still works, on the same prefix.
  const deleted = await call(base, key, '/v1/connections/acct', 'DELETE');
  assert.equal(deleted.status, 200);
  assert.deepEqual(await store.list(), []);
});

test('a malformed body is refused rather than read as “clear everything”', async (t) => {
  const { base, key, store } = await gateway(t);
  await connectionWith(store, ['provider/one'], ['hand/one']);

  const wrongType = await call(base, key, '/v1/connections/acct/models', 'DELETE', { modelIds: 'hand/one' });
  assert.equal(wrongType.status, 400);
  const badId = await call(base, key, '/v1/connections/acct/models', 'DELETE', { modelIds: ['has space'] });
  assert.equal(badId.status, 400);
  const extraField = await call(base, key, '/v1/connections/acct/models', 'DELETE', { modelIds: [], wipe: true });
  assert.equal(extraField.status, 400);
  assert.deepEqual((await record(store)).customModelIds, ['hand/one'], 'a refused request changed the catalogue');
});
