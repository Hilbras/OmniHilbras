import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleAdapter, ProviderError } from '../dist/index.js';

function createTransport(overrides = {}) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      return overrides.request ? overrides.request(request) : {
        status: 200,
        headers: new Headers(),
        data: { id: 'response-1', model: 'acme-1', choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] },
      };
    },
    async *stream(request) {
      calls.push(request);
      yield* (overrides.stream ? overrides.stream(request) : ['data: {"id":"chunk-1","model":"acme-1","choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\ndata: [DONE]\n\n']);
    },
  };
}

function createAdapter(transport, config = {}) {
  return new OpenAICompatibleAdapter({
    id: 'acme',
    name: 'Acme',
    baseUrl: 'https://api.acme.test/v1',
    auth: { header: 'X-API-Key' },
    ...config,
  }, { transport });
}

test('OpenAI-compatible adapter maps chat requests and responses', async () => {
  const transport = createTransport();
  const adapter = createAdapter(transport);
  const response = await adapter.chat({
    model: 'acme-1',
    messages: [{ role: 'user', content: 'Hello' }],
    maxOutputTokens: 64,
    temperature: 0.2,
  }, { credential: { type: 'api-key', value: 'secret' } });

  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].url, 'https://api.acme.test/v1/chat/completions');
  assert.equal(transport.calls[0].headers['X-API-Key'], 'secret');
  assert.equal(transport.calls[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(transport.calls[0].body), {
    model: 'acme-1',
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
    temperature: 0.2,
    max_tokens: 64,
  });
  assert.equal(response.providerId, 'acme');
  assert.equal(response.message.content, 'hello');
  assert.equal(response.finishReason, 'stop');
});

test('OpenAI-compatible adapter lists models and normalizes stream chunks', async () => {
  const transport = createTransport({
    request: async () => ({ status: 200, headers: new Headers(), data: { data: [{ id: 'acme-1', owned_by: 'acme' }] } }),
    stream: async function* () {
      yield 'data: {"id":"chunk-1","model":"acme-1","choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\n';
      yield 'data: {"id":"chunk-2","choices":[{"delta":{"content":" there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n';
      yield 'data: [DONE]\n\n';
    },
  });
  const adapter = createAdapter(transport);
  const models = await adapter.listModels({ credential: { type: 'api-key', value: 'secret' } });
  const chunks = [];
  for await (const chunk of adapter.streamChat({ model: 'acme-1', messages: [{ role: 'user', content: 'Hi' }] }, { credential: { type: 'api-key', value: 'secret' } })) {
    chunks.push(chunk);
  }

  assert.deepEqual(models, [{ id: 'acme-1', providerId: 'acme', ownedBy: 'acme' }]);
  assert.deepEqual(chunks.map((chunk) => chunk.delta.content), ['hi', ' there']);
  assert.equal(chunks[1].finishReason, 'stop');
  assert.deepEqual(chunks[1].usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
});

test('OpenAI-compatible adapter uses custom paths and exact image wire parts', async () => {
  const transport = createTransport();
  const adapter = createAdapter(transport, { modelsPath: '/catalog', chatPath: '/generate' });
  await adapter.chat({
    model: 'acme-1',
    messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: { url: 'https://cdn.example/image.png', detail: 'auto' } }] }],
  }, { credential: { type: 'api-key', value: 'secret' } });

  assert.equal(transport.calls[0].url, 'https://api.acme.test/v1/generate');
  assert.deepEqual(JSON.parse(transport.calls[0].body).messages[0].content, [{ type: 'image_url', image_url: { url: 'https://cdn.example/image.png', detail: 'auto' } }]);
});

test('OpenAI-compatible adapter rejects a stream that ends before DONE', async () => {
  const transport = createTransport({
    stream: async function* () {
      yield 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';
    },
  });
  const adapter = createAdapter(transport);

  await assert.rejects(async () => {
    for await (const _chunk of adapter.streamChat({ model: 'acme-1', messages: [{ role: 'user', content: 'Hi' }] }, { credential: { type: 'api-key', value: 'secret' } })) {
      // consume the stream
    }
  }, (error) => error instanceof ProviderError && error.code === 'INVALID_RESPONSE');
});

test('OpenAI-compatible adapter defaults to bearer authentication', async () => {
  const transport = createTransport();
  const adapter = new OpenAICompatibleAdapter({ id: 'acme', name: 'Acme', baseUrl: 'https://api.acme.test/v1' }, { transport });
  await adapter.chat({ model: 'acme-1', messages: [{ role: 'user', content: 'Hello' }] }, { credential: { type: 'api-key', value: 'secret' } });
  assert.equal(transport.calls[0].headers.Authorization, 'Bearer secret');
});

test('OpenAI-compatible adapter rejects unsupported provider options', async () => {
  const adapter = createAdapter(createTransport());
  await assert.rejects(
    adapter.chat({ model: 'acme-1', messages: [{ role: 'user', content: 'Hello' }], providerOptions: { unsupported: true } }, { credential: { type: 'api-key', value: 'secret' } }),
    (error) => error instanceof ProviderError && error.code === 'INVALID_REQUEST',
  );
});

test('OpenAI-compatible adapter requires credentials when configured', async () => {
  const adapter = createAdapter(createTransport());

  await assert.rejects(
    adapter.chat({ model: 'acme-1', messages: [{ role: 'user', content: 'Hello' }] }),
    (error) => error instanceof ProviderError && error.code === 'AUTHENTICATION_FAILED',
  );
});
