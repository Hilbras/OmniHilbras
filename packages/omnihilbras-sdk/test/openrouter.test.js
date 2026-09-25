import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenRouterAdapter, ProviderError } from '../dist/index.js';

function createTransport(data) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      return { status: 200, headers: new Headers(), data };
    },
    async *stream() {
      throw new Error('stream should not be used for credential validation');
    },
  };
}

test('OpenRouter validates credentials through the key metadata endpoint', async () => {
  const transport = createTransport({ data: { is_management_key: false, label: 'local test' } });
  const adapter = new OpenRouterAdapter({}, { transport });

  await adapter.validateCredential({ type: 'api-key', value: 'sk-or-test' });

  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].method, 'GET');
  assert.equal(transport.calls[0].url, 'https://openrouter.ai/api/v1/key');
  assert.equal(transport.calls[0].headers.Authorization, 'Bearer sk-or-test');
  assert.equal(transport.calls[0].headers.accept, 'application/json');
});

test('OpenRouter explains rejected keys without exposing them', async () => {
  const secret = 'sk-or-rejected-secret';
  const transport = {
    async request() {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Provider authentication failed.', { providerId: 'openrouter', statusCode: 401 });
    },
    async *stream() {
      throw new Error('stream should not be used for credential validation');
    },
  };
  const adapter = new OpenRouterAdapter({}, { transport });

  await assert.rejects(
    adapter.validateCredential({ type: 'api-key', value: secret }),
    (error) => error instanceof ProviderError && error.code === 'AUTHENTICATION_FAILED' && error.toJSON().message.includes('management key') && !error.toJSON().message.includes(secret),
  );
});

test('OpenRouter health uses authenticated key metadata rather than models', async () => {
  const transport = createTransport({ data: { label: 'local test', is_management_key: false } });
  const adapter = new OpenRouterAdapter({}, { transport });

  const health = await adapter.healthCheck({ credential: { type: 'api-key', value: 'sk-or-test' } });

  assert.equal(health.status, 'healthy');
  assert.equal(transport.calls[0].url, 'https://openrouter.ai/api/v1/key');
});

test('OpenRouter imports free models using provider pricing, not model names', async () => {
  const transport = createTransport({ data: [
    { id: 'openrouter/free-model', name: 'Free model', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
    { id: 'openrouter/paid-model', name: 'Paid model', pricing: { prompt: '0.000001', completion: '0' }, architecture: { output_modalities: ['text'] } },
    { id: '~openrouter/latest-model', name: 'Latest model', pricing: { prompt: '0.000001', completion: '0.000001' }, architecture: { output_modalities: ['text'] } },
    { id: 'openrouter/missing-modalities', name: 'Malformed model', pricing: { prompt: '0', completion: '0' } },
    { id: 'openrouter/image-free', name: 'Image model', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['image'] } },
  ] });
  const adapter = new OpenRouterAdapter({}, { transport });

  const freeModels = await adapter.discoverModels({ credential: { type: 'api-key', value: 'sk-or-test' } }, { policy: 'free' });
  const allModels = await adapter.discoverModels({ credential: { type: 'api-key', value: 'sk-or-test' } }, { policy: 'all' });

  assert.deepEqual(freeModels.map((model) => model.id), ['openrouter/free-model']);
  assert.deepEqual(allModels.map((model) => model.id), ['openrouter/free-model', 'openrouter/paid-model', '~openrouter/latest-model']);
  assert.equal(transport.calls[0].url, 'https://openrouter.ai/api/v1/models');
});

test('OpenRouter follows same-origin model pagination links', async () => {
  const pages = [
    { data: [{ id: 'vendor/first', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } }], links: { next: '/api/v1/models?offset=1&limit=1' } },
    { data: [{ id: 'vendor/second', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } }], links: { next: null } },
  ];
  const calls = [];
  let page = 0;
  const transport = {
    calls,
    async request(request) {
      calls.push(request);
      const data = pages[page++];
      return { status: 200, headers: new Headers(), data };
    },
    async *stream() {
      throw new Error('stream should not be used for model discovery');
    },
  };
  const adapter = new OpenRouterAdapter({}, { transport });

  const models = await adapter.discoverModels({ credential: { type: 'api-key', value: 'sk-or-test' } }, { policy: 'free' });

  assert.deepEqual(models.map((model) => model.id), ['vendor/first', 'vendor/second']);
  assert.deepEqual(calls.map((call) => call.url), ['https://openrouter.ai/api/v1/models', 'https://openrouter.ai/api/v1/models?offset=1&limit=1']);
});

test('OpenRouter rejects model pagination links that leave the provider origin', async () => {
  const adapter = new OpenRouterAdapter({}, { transport: createTransport({ data: [], links: { next: 'https://evil.example/models' } }) });
  await assert.rejects(
    adapter.discoverModels({ credential: { type: 'api-key', value: 'sk-or-test' } }, { policy: 'all' }),
    (error) => error instanceof ProviderError && error.code === 'INVALID_RESPONSE',
  );
});

test('OpenRouter rejects malformed model discovery responses', async () => {
  const adapter = new OpenRouterAdapter({}, { transport: createTransport({ data: {} }) });
  await assert.rejects(
    adapter.discoverModels({ credential: { type: 'api-key', value: 'sk-or-test' } }, { policy: 'all' }),
    (error) => error instanceof ProviderError && error.code === 'INVALID_RESPONSE',
  );
});

test('OpenRouter rejects invalid import policies and oversized catalogs', async () => {
  const adapter = new OpenRouterAdapter({}, { transport: createTransport({ data: [] }) });
  await assert.rejects(
    adapter.discoverModels({ credential: { type: 'api-key', value: 'sk-or-test' } }, { policy: 'invalid' }),
    (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR',
  );

  const oversized = new OpenRouterAdapter({}, { transport: createTransport({ data: Array.from({ length: 2_001 }, (_, index) => ({ id: `vendor/model-${index}`, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } })) }) });
  await assert.rejects(
    oversized.discoverModels({ credential: { type: 'api-key', value: 'sk-or-test' } }, { policy: 'free' }),
    (error) => error instanceof ProviderError && error.code === 'INVALID_RESPONSE',
  );
});

test('OpenRouter rejects management keys for inference connections', async () => {
  const adapter = new OpenRouterAdapter({}, { transport: createTransport({ data: { label: 'management', is_management_key: true } }) });

  await assert.rejects(
    adapter.validateCredential({ type: 'api-key', value: 'management-key' }),
    (error) => error instanceof ProviderError && error.code === 'AUTHENTICATION_FAILED',
  );
});

test('OpenRouter rejects malformed key metadata without exposing the key', async () => {
  const secret = 'sk-or-secret';
  const adapter = new OpenRouterAdapter({}, { transport: createTransport({ data: {} }) });

  await assert.rejects(
    adapter.validateCredential({ type: 'api-key', value: secret }),
    (error) => error instanceof ProviderError && error.code === 'INVALID_RESPONSE' && !error.toJSON().message.includes(secret),
  );
});
