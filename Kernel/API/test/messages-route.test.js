import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';
import { isPublicLlmRoute } from '../dist/src/routes/inference.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';

// Anthropic SDK clients speak /v1/messages. The route translates directly onto the chat path and reframes the
// reply; these assert the shape a client actually sees, plus the auth boundary.

function recordingProvider(seen) {
  return {
    id: 'fake',
    name: 'Fake',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'fake-1', providerId: 'fake' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString() }; },
    async chat(request) {
      seen.push(request);
      return { id: 'msg_1', providerId: 'fake', model: request.model, createdAt: '2026-11-20T00:00:00.000Z', message: { role: 'assistant', content: 'pong' }, finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
    },
  };
}

async function start(t, seen) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('messages')).key;
  const registry = new ProviderRegistry().register(recordingProvider(seen));
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'fake', providerId: 'fake', name: 'Fake', endpoint: 'https://f.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } }, { type: 'api-key', value: 'k' });
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, key };
}

test('/v1/messages is on the authenticated route set', () => {
  assert.equal(isPublicLlmRoute('POST', '/v1/messages'), true, 'a client route must be behind the key gate');
});

test('an unauthenticated POST /v1/messages is refused and reaches no provider', async (t) => {
  const seen = [];
  const { base } = await start(t, seen);
  const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'ping' }] }) });
  assert.equal(response.status, 401);
  assert.equal(seen.length, 0);
});

test('an authenticated Anthropic request is translated and the reply reframed', async (t) => {
  const seen = [];
  const { base, key } = await start(t, seen);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'fake-1',
      system: [{ type: 'text', text: 'Be brief.' }],
      max_tokens: 50,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.content, [{ type: 'text', text: 'pong' }]);
  assert.equal(body.usage.input_tokens, 3);
  assert.equal(body.gateway.requestId, body.id ? body.gateway.requestId : null);
  assert.equal(seen.length, 1, 'one provider call through the direct translation');
  assert.equal(seen[0].messages[0].content, 'Be brief.', 'system translated to a system message');
  assert.equal(seen[0].maxOutputTokens, 50, 'max_tokens translated to the internal chat field');
});

test('stream on /v1/messages is refused rather than served in the wrong shape', async (t) => {
  const seen = [];
  const { base, key } = await start(t, seen);
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'fake-1', stream: true, messages: [{ role: 'user', content: 'ping' }] }),
  });
  assert.equal(response.status, 400);
  assert.equal(seen.length, 0);
});
