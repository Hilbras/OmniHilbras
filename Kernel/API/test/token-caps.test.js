import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

/** Caps and the estimate endpoint. Neither may claim more precision than it has. */

function registry(captured) {
  const registry = new ProviderRegistry().register({
    id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request) {
      captured.push(request);
      return { id: 'r', providerId: 'p', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
    },
  });
  return registry;
}

async function serviceWith(limits) {
  const captured = [];
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'p', providerId: 'p', name: 'P', endpoint: 'https://p.example/v1', priority: 1, proxyPool: 'none', modelIds: ['m'] }, { type: 'api-key', value: 'key' });
  const service = new GatewayService(registry(captured), store, store, new InMemoryApiKeyStore(), limits);
  return { captured, service };
}

const request = (maxOutputTokens) => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) });

test('the output cap clamps a larger request and supplies an absent one', async () => {
  const { captured, service } = await serviceWith({ maxOutputTokensCap: 100 });
  await service.chat('p', request(500));
  await service.chat('p', request(undefined));
  await service.chat('p', request(50));
  assert.equal(captured[0].maxOutputTokens, 100);
  assert.equal(captured[1].maxOutputTokens, 100);
  assert.equal(captured[2].maxOutputTokens, 50, 'a smaller explicit limit must not be raised');
});

test('the thinking cap is attached for adapters that take a budget', async () => {
  const { captured, service } = await serviceWith({ thinkingBudgetCap: 2_000 });
  await service.chat('p', request(undefined));
  assert.equal(captured[0].maxThinkingTokens, 2_000);
});

test('count_tokens returns an explicitly estimated count and requires the LLM gate', async (t) => {
  const captured = [];
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('count')).key;
  const store = new InMemoryConnectionStore();
  const service = new GatewayService(registry(captured), store, store, apiKeys, {});
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({ model: 'm', system: 'be terse', messages: [{ role: 'user', content: 'a '.repeat(400) }], tools: [{ name: 'x' }] });

  const unauthenticated = await fetch(`${base}/v1/messages/count_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(unauthenticated.status, 401);

  const response = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body,
  });
  assert.equal(response.status, 200);
  const counted = await response.json();
  assert.equal(counted.estimated, true);
  assert.ok(counted.input_tokens > 200);
});
