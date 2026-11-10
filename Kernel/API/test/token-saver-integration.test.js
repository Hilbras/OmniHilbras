import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

/**
 * The standalone saver, wired into the gateway request path.
 *
 * The adapter is the assertion point: it receives the request the provider would actually get. A unit
 * test on `compressMessages` proves the library; this proves the gateway calls it and that the marker
 * points back into the same store.
 */

function registry(captured) {
  const registry = new ProviderRegistry();
  registry.register({
    id: 'p',
    name: 'Provider P',
    capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request) {
      captured.push(request);
      return {
        id: 'r', providerId: 'p', model: request.model, createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: 'ok' }, finishReason: 'stop',
      };
    },
  });
  return registry;
}

const toolLog = Array.from({ length: 120 }, (_, index) => `2026-01-01 INFO line ${index}`).join('\n')
  + '\n2026-01-01 ERROR FATAL: database is locked\n    at open (db.js:42:7)';

const connection = { id: 'p', providerId: 'p', name: 'P', endpoint: 'https://p.example/v1', priority: 1, proxyPool: 'none', modelIds: ['m'] };

async function serviceFor(tokenSaver) {
  const captured = [];
  const store = new InMemoryConnectionStore();
  await store.save(connection, { type: 'api-key', value: 'key' });
  const service = new GatewayService(registry(captured), store, store, new InMemoryApiKeyStore(), {
    ...(tokenSaver ? { tokenSaver } : {}),
  });
  return { captured, service };
}

test('the gateway compresses the provider-bound request when the saver is enabled', async () => {
  const { captured, service } = await serviceFor({
    enabled: true, targetRatio: 0.4, protectRecent: 0, compressUsers: false,
    compressCode: false, reversible: true, ccrLimit: 10,
  });
  await service.chat('p', {
    model: 'm',
    messages: [
      { role: 'tool', content: toolLog },
      { role: 'user', content: 'what failed?' },
    ],
  });
  const sent = captured.at(-1).messages;
  const tool = sent.find((message) => message.role === 'tool');
  assert.ok(tool.content.length < toolLog.length, 'tool output was not compressed');
  assert.match(tool.content, /FATAL: database is locked/);
  const id = /token-saver:([a-f0-9]{12})/.exec(tool.content)?.[1];
  assert.ok(id, 'no retrieval marker');
  assert.equal(service.retrieveTokenSaverContext(id), toolLog);
});

test('without the opt-in the retrieval store is empty', async () => {
  const { captured, service } = await serviceFor(undefined);
  await service.chat('p', {
    model: 'm',
    messages: [{ role: 'tool', content: toolLog }, { role: 'user', content: 'what failed?' }],
  });
  const tool = captured.at(-1).messages.find((message) => message.role === 'tool');
  assert.doesNotMatch(tool.content, /token-saver:[a-f0-9]{12}/);
  assert.equal(service.retrieveTokenSaverContext('abcdef123456'), undefined);
});

test('the retrieval route returns the original and 404s a miss', async (t) => {
  const captured = [];
  const store = new InMemoryConnectionStore();
  await store.save(connection, { type: 'api-key', value: 'key' });
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('token-saver')).key;
  const service = new GatewayService(registry(captured), store, store, apiKeys, {
    tokenSaver: { enabled: true, targetRatio: 0.4, protectRecent: 0, compressUsers: false, compressCode: false, reversible: true, ccrLimit: 10 },
  });
  await service.chat('p', { model: 'm', messages: [{ role: 'tool', content: toolLog }] });
  const tool = captured.at(-1).messages[0];
  const id = /token-saver:([a-f0-9]{12})/.exec(tool.content)?.[1];
  assert.ok(id);

  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const found = await fetch(`${base}/v1/token-saver/${id}`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(found.status, 200);
  assert.equal((await found.json()).content, toolLog);

  const missing = await fetch(`${base}/v1/token-saver/abcdef123456`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(missing.status, 404);

  const unauthenticated = await fetch(`${base}/v1/token-saver/${id}`);
  assert.equal(unauthenticated.status, 401);
});
