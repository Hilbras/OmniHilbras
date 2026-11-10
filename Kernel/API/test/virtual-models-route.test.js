import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryVirtualModelStore, ProviderRegistry } from '../dist/src/core/index.js';
import { InMemoryApiKeyStore, InMemoryConnectionStore, GatewayService, createGatewayServer } from '../dist/src/index.js';

/** The management surface for virtual models, and the /v1/models list that advertises them. */

function adapter(id) {
  return {
    id, name: id, capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    async listModels() { return [{ id: `model-${id}`, providerId: id }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request) { return { id: 'r', providerId: id, model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }; },
  };
}

async function gateway() {
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'conn-a', providerId: 'a', name: 'A', endpoint: 'https://a.example/v1', priority: 1, proxyPool: 'none', enabled: true, modelIds: ['model-a'] }, { type: 'api-key', value: 'key' });
  await store.save({ id: 'conn-b', providerId: 'b', name: 'B', endpoint: 'https://b.example/v1', priority: 2, proxyPool: 'none', enabled: true, modelIds: ['model-b'] }, { type: 'api-key', value: 'key' });
  const keys = new InMemoryApiKeyStore();
  const key = (await keys.create('virtual')).key;
  const virtual = new InMemoryVirtualModelStore();
  const registry = new ProviderRegistry().register(adapter('a')).register(adapter('b'));
  const service = new GatewayService(registry, store, store, keys, { virtualModels: virtual });
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, key, virtual,
    close: () => new Promise((resolve) => server.close(resolve)),
    call: (path, init = {}) => fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
    }),
  };
}

const modelBody = {
  id: 'oh/chat',
  name: 'Chat',
  strategy: 'round-robin',
  targets: [
    { connectionId: 'conn-a', upstreamModelId: 'model-a', priority: 1 },
    { connectionId: 'conn-b', upstreamModelId: 'model-b', priority: 2 },
  ],
};

test('virtual model CRUD validates the oh/ prefix and the targets', async (t) => {
  const gw = await gateway();
  t.after(gw.close);

  const bad = await gw.call('/v1/virtual-models', { method: 'POST', body: JSON.stringify({ ...modelBody, id: 'chat' }) });
  assert.equal(bad.status, 400);

  const missing = await gw.call('/v1/virtual-models', { method: 'POST', body: JSON.stringify({ ...modelBody, targets: [{ connectionId: 'missing', upstreamModelId: 'model-a' }] }) });
  assert.equal(missing.status, 400);

  const created = await gw.call('/v1/virtual-models', { method: 'POST', body: JSON.stringify(modelBody) });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.model.id, 'oh/chat');
  assert.equal(createdBody.model.targets.length, 2);

  const listed = await gw.call('/v1/virtual-models');
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).data.map((model) => model.id), ['oh/chat']);

  const updated = await gw.call('/v1/virtual-models/oh/chat', { method: 'PUT', body: JSON.stringify({ name: 'Renamed', targets: modelBody.targets }) });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).model.name, 'Renamed');

  const deleted = await gw.call('/v1/virtual-models/oh/chat', { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal((await gw.call('/v1/virtual-models/oh/chat', { method: 'DELETE' })).status, 404);
});

test('GET /v1/models advertises an enabled virtual model with its providers', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  assert.equal((await gw.call('/v1/virtual-models', { method: 'POST', body: JSON.stringify(modelBody) })).status, 201);

  const response = await gw.call('/v1/models');
  assert.equal(response.status, 200);
  const virtual = (await response.json()).data.find((model) => model.id === 'oh/chat');
  assert.ok(virtual, 'the virtual model is missing from /v1/models');
  assert.equal(virtual.virtual, true);
  assert.deepEqual(virtual.providers, ['a', 'b']);
});

test('virtual model routes require the management key', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  const response = await fetch(`${gw.base}/v1/virtual-models`, { headers: { 'content-type': 'application/json' } });
  assert.equal(response.status, 401);
});
