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

test('OpenAI-compatible adapter rejects an empty completed stream', async () => {
  const transport = createTransport({
    stream: async function* () {
      yield 'data: {}\n\ndata: [DONE]\n\n';
    },
  });
  const adapter = createAdapter(transport);

  await assert.rejects(async () => {
    for await (const _chunk of adapter.streamChat({ model: 'acme-1', messages: [{ role: 'user', content: 'Hi' }] }, { credential: { type: 'api-key', value: 'secret' } })) {
      // consume the stream
    }
  }, (error) => error instanceof ProviderError && error.code === 'INVALID_RESPONSE');
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

test('an unusable chat response says which part was missing', async () => {
  // A provider that intermittently answers with an empty `choices` array is
  // indistinguishable from one that answers with a choice lacking a message.
  const adapter = new OpenAICompatibleAdapter({ id: 'odd', name: 'Odd', baseUrl: 'https://example.test/v1' }, {
    transport: {
      async request() {
        return { status: 200, headers: new Headers(), data: { id: 'x', choices: [] } };
      },
      stream() { throw new Error('not used'); },
    },
  });
  await assert.rejects(
    () => adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'api-key', value: 'k' } }),
    (error) => error.code === 'INVALID_RESPONSE'
      && /no choices/.test(error.message)
      && /no choices/.test(error.details?.providerMessage ?? ''),
  );

  const noMessage = new OpenAICompatibleAdapter({ id: 'odd', name: 'Odd', baseUrl: 'https://example.test/v1' }, {
    transport: {
      async request() {
        return { status: 200, headers: new Headers(), data: { id: 'x', choices: [{ index: 0, finish_reason: 'stop' }] } };
      },
      stream() { throw new Error('not used'); },
    },
  });
  await assert.rejects(
    () => noMessage.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'api-key', value: 'k' } }),
    (error) => error.code === 'INVALID_RESPONSE' && /choice with no message/.test(error.message),
  );
});

test('a thinking model\'s reasoning is passed back on the assistant turn that made the tool call', async () => {
  // DeepSeek's thinking mode refuses a tool round unless the reasoning from that turn is sent back as
  // `reasoning_content`. Without it the provider answers 400 on every multi-turn tool call.
  const transport = createTransport();
  const adapter = createAdapter(transport);
  await adapter.chat({
    model: 'acme-1',
    messages: [
      { role: 'user', content: 'count' },
      { role: 'assistant', content: '', reasoning: 'The output has 3 lines.', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
      { role: 'tool', toolCallId: 'c1', content: '3 lines' },
    ],
  }, { credential: { type: 'api-key', value: 'k' } });
  const sent = JSON.parse(transport.calls[0].body).messages;
  assert.equal(sent[1].reasoning_content, 'The output has 3 lines.', 'the reasoning reaches the provider');
  assert.equal('reasoning_content' in sent[2], false, 'a tool result carries no reasoning');
});

test('an assistant turn without reasoning is sent exactly as before', async () => {
  const transport = createTransport();
  const adapter = createAdapter(transport);
  await adapter.chat({
    model: 'acme-1',
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
  }, { credential: { type: 'api-key', value: 'k' } });
  const sent = JSON.parse(transport.calls[0].body).messages;
  assert.equal('reasoning_content' in sent[1], false, 'no reasoning field is invented');
});

test('a toolChoice reaches an OpenAI-compatible provider as tool_choice, unchanged', async () => {
  const transport = createTransport();
  const adapter = createAdapter(transport);
  await adapter.chat({
    model: 'acme-1',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_weather', parameters: { type: 'object' } }],
    toolChoice: 'required',
  }, { credential: { type: 'api-key', value: 'k' } });
  const body = JSON.parse(transport.calls[0].body);
  assert.equal(body.tool_choice, 'required', 'the choice is sent in OpenAI\'s own names');
});

test('without a toolChoice, the request carries no tool_choice field', async () => {
  const transport = createTransport();
  const adapter = createAdapter(transport);
  await adapter.chat({
    model: 'acme-1',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_weather', parameters: { type: 'object' } }],
  }, { credential: { type: 'api-key', value: 'k' } });
  const body = JSON.parse(transport.calls[0].body);
  assert.equal('tool_choice' in body, false, 'the provider keeps its own default');
});
