import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';
import { isPublicLlmRoute } from '../dist/routes/inference.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

// Codex-style clients speak the Responses API (`input`, `output`), not chat completions. Without this route they
// cannot point at the gateway at all. The route translates the request onto the same chat path, so routing, failover,
// usage and the key gate are the ones chat already has.

function recordingProvider(seen) {
  return {
    id: 'fake',
    name: 'Fake',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'fake-1', providerId: 'fake' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString() }; },
    async chat(request) {
      seen.push(request);
      return { id: 'r1', providerId: 'fake', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'pong' }, finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
    },
  };
}

async function start(t, seen) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('responses')).key;
  const registry = new ProviderRegistry().register(recordingProvider(seen));
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'fake', providerId: 'fake', name: 'Fake', endpoint: 'https://f.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: 'k' });
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, key };
}

test('THE BOUNDARY: /v1/responses is in the authenticated route set', () => {
  assert.equal(isPublicLlmRoute('POST', '/v1/responses'), true, 'a route served to clients must be on the auth list');
});

test('an unauthenticated POST /v1/responses is refused with 401', async (t) => {
  const seen = [];
  const { base } = await start(t, seen);
  const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-1', input: 'ping' }) });
  assert.equal(response.status, 401);
  assert.equal(seen.length, 0, 'nothing reaches a provider without a key');
});

test('a Responses request is answered in the Responses shape, and reaches the provider as a chat request', async (t) => {
  const seen = [];
  const { base, key } = await start(t, seen);
  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'fake-1', instructions: 'Be brief.', input: 'ping' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.equal(body.output_text, 'pong');
  assert.equal(body.output[0].content[0].text, 'pong');
  assert.equal(seen[0].messages.find((message) => message.role === 'system')?.content, 'Be brief.', 'instructions become the system message');
  assert.equal(seen[0].messages.at(-1).content, 'ping', 'input becomes the user message');
});

function streamingProvider() {
  return {
    id: 'fake',
    name: 'Fake',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'fake-1', providerId: 'fake' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString() }; },
    async chat() { throw new Error('the streamed test must not reach the non-streaming path'); },
    async *streamChat() {
      yield { id: 'r2', providerId: 'fake', model: 'fake-1', delta: { role: 'assistant', content: 'po' } };
      yield { id: 'r2', providerId: 'fake', model: 'fake-1', delta: { content: 'ng' }, finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
    },
  };
}

test('stream: true on /v1/responses is answered as Responses events: text deltas, then response.completed with the full body', async (t) => {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('responses')).key;
  const registry = new ProviderRegistry().register(streamingProvider());
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'fake', providerId: 'fake', name: 'Fake', endpoint: 'https://f.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: 'k' });
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'fake-1', input: 'ping', stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  const events = text.split('\n\n').filter(Boolean).map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(block)[1]);
    return { event, data };
  });
  const deltas = events.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta);
  assert.deepEqual(deltas, ['po', 'ng'], 'each text delta is its own event, in order');
  const completed = events.at(-1);
  assert.equal(completed.event, 'response.completed', 'the last event is response.completed');
  assert.equal(completed.data.response.object, 'response');
  assert.equal(completed.data.response.status, 'completed');
  assert.equal(completed.data.response.output_text, 'pong', 'the completed body carries the joined text');
});
