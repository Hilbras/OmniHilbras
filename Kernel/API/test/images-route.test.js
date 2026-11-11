import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';
import { isPublicLlmRoute, parseImageRequest } from '../dist/src/routes/inference.js';

function imageAdapter() {
  return {
    id: 'acme',
    name: 'Acme',
    capabilities: { chat: true, streaming: false, models: true, images: true },
    async listModels() { return [{ id: 'acme-image', providerId: 'acme' }]; },
    async image(request) {
      return {
        id: 'img-1',
        providerId: 'acme',
        model: request.model,
        createdAt: '2026-10-05T00:00:00.000Z',
        data: [{ url: 'https://example.com/img.png', revisedPrompt: request.prompt }],
      };
    },
  };
}

function chatOnlyAdapter() {
  return {
    id: 'quiet',
    name: 'Quiet',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'quiet-1', providerId: 'quiet' }]; },
  };
}

async function gateway(adapterFactory) {
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'conn-a', providerId: 'acme', name: 'A', endpoint: 'https://a.example/v1', priority: 1, proxyPool: 'none', enabled: true, modelIds: ['acme-image'] }, { type: 'api-key', value: 'key' });
  const keys = new InMemoryApiKeyStore();
  const key = (await keys.create('images')).key;
  const registry = new ProviderRegistry().register(adapterFactory());
  const service = new GatewayService(registry, store, store, keys);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, key,
    close: () => new Promise((resolve) => server.close(resolve)),
    call: (body) => fetch(`${base}/v1/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }),
  };
}

test('isPublicLlmRoute covers /v1/images/generations', () => {
  assert.equal(isPublicLlmRoute('POST', '/v1/images/generations'), true);
});

test('parseImageRequest validates prompt and model', () => {
  assert.throws(() => parseImageRequest({}), /model must be a non-empty string/);
  assert.throws(() => parseImageRequest({ model: 'm' }), /prompt must be a non-empty string/);
  const req = parseImageRequest({ model: 'm', prompt: 'a cat', n: 2, size: '1024x1024' });
  assert.equal(req.model, 'm');
  assert.equal(req.prompt, 'a cat');
  assert.equal(req.n, 2);
  assert.equal(req.size, '1024x1024');
});

test('image generation returns data', async (t) => {
  const gw = await gateway(imageAdapter);
  t.after(gw.close);
  const res = await gw.call({ model: 'acme-image', prompt: 'a cat' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data[0].url, 'https://example.com/img.png');
  assert.equal(body.data[0].revised_prompt, 'a cat');
});

test('chat-only provider returns NOT_SUPPORTED', async (t) => {
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'conn-q', providerId: 'quiet', name: 'Q', endpoint: 'https://q.example/v1', priority: 1, proxyPool: 'none', enabled: true, modelIds: ['quiet-1'] }, { type: 'api-key', value: 'key' });
  const keys = new InMemoryApiKeyStore();
  const key = (await keys.create('images2')).key;
  const registry = new ProviderRegistry().register(chatOnlyAdapter());
  const service = new GatewayService(registry, store, store, keys);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const res = await fetch(`${base}/v1/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: 'quiet-1', prompt: 'a cat' }) });
  assert.equal(res.status, 501);
  const body = await res.json();
  assert.equal(body.error.code, 'NOT_SUPPORTED');
});

test('images route requires auth', async (t) => {
  const gw = await gateway(imageAdapter);
  t.after(gw.close);
  const res = await fetch(`${gw.base}/v1/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'acme-image', prompt: 'a cat' }) });
  assert.equal(res.status, 401);
});
