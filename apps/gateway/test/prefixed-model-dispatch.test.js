import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

// A `provider/model` id is how the model list now names a model, so an agent that copies an id from the
// list sends the prefix. The routing layer strips it to choose the connection, but the provider must receive
// the bare model name: a provider does not know `tiarina/deepseek-v4.1-flash`, and was refusing it.

function recordingProvider(id, seen) {
  return {
    id,
    name: id,
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'deepseek-v4.1-flash', providerId: id }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat(request) {
      seen.push(request.model);
      return {
        id: 'r', providerId: id, model: request.model, createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: 'ok' }, finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

async function gateway(seen) {
  const registry = new ProviderRegistry().register(recordingProvider('tiarina', seen));
  const store = new InMemoryConnectionStore();
  await store.save(
    {
      id: 'conn-t', providerId: 'tiarina', name: 'Tiarina', endpoint: 'https://t.example/v1', priority: 1,
      enabled: true, proxyPool: 'none', modelPolicy: 'all',
      resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 },
    },
    { type: 'api-key', value: 'k' },
  );
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('prefixed-model')).key;
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    post: (model) => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('a prefixed model id reaches the provider as the bare model name', async (t) => {
  const seen = [];
  const gw = await gateway(seen);
  t.after(gw.close);
  const response = await gw.post('tiarina/deepseek-v4.1-flash');
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ['deepseek-v4.1-flash'], 'the provider must not be sent the prefix it does not know');
});

test('a bare model id is sent unchanged', async (t) => {
  const seen = [];
  const gw = await gateway(seen);
  t.after(gw.close);
  assert.equal((await gw.post('deepseek-v4.1-flash')).status, 200);
  assert.deepEqual(seen, ['deepseek-v4.1-flash']);
});
