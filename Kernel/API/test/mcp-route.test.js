import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryApiKeyStore, InMemoryConnectionStore, GatewayService, createGatewayServer } from '../dist/src/index.js';
import { ProviderRegistry } from '../dist/src/core/index.js';

function adapter(id) {
  return {
    id, name: id, capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: `model-${id}`, providerId: id }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
  };
}

async function gateway() {
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'conn-a', providerId: 'a', name: 'A', endpoint: 'https://a.example/v1', priority: 1, proxyPool: 'none', enabled: true, modelIds: ['model-a'] }, { type: 'api-key', value: 'key' });
  const keys = new InMemoryApiKeyStore();
  const key = (await keys.create('mcp')).key;
  const registry = new ProviderRegistry().register(adapter('a'));
  const service = new GatewayService(registry, store, store, keys);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, key,
    close: () => new Promise((resolve) => server.close(resolve)),
    call: (body) => fetch(`${base}/v1/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }),
  };
}

test('MCP initialize + tools/list + tools/call', async (t) => {
  const gw = await gateway();
  t.after(gw.close);

  const init = await gw.call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.status, 200);
  const initBody = await init.json();
  assert.equal(initBody.result.protocolVersion, '2024-11-05');
  assert.ok(initBody.result.capabilities.tools);

  const list = await gw.call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(list.status, 200);
  const tools = (await list.json()).result.tools;
  assert.ok(tools.some((tool) => tool.name === 'list_connections'));

  const call = await gw.call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_connections' } });
  assert.equal(call.status, 200);
  const callBody = await call.json();
  assert.ok(callBody.result.content[0].text.includes('conn-a'));

  const unknown = await gw.call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.result.isError, true);
});

test('MCP requires auth', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  const res = await fetch(`${gw.base}/v1/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
  assert.equal(res.status, 401);
});
