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

test('OpenRouter health uses authenticated key metadata rather than models', async () => {
  const transport = createTransport({ data: { label: 'local test', is_management_key: false } });
  const adapter = new OpenRouterAdapter({}, { transport });

  const health = await adapter.healthCheck({ credential: { type: 'api-key', value: 'sk-or-test' } });

  assert.equal(health.status, 'healthy');
  assert.equal(transport.calls[0].url, 'https://openrouter.ai/api/v1/key');
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
