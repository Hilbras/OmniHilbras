import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiAdapter, ProviderError } from '../dist/index.js';

function createTransport(overrides = {}) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      return overrides.request ? overrides.request(request) : {
        status: 200,
        headers: new Headers(),
        data: {
          candidates: [{ content: { role: 'model', parts: [{ text: 'Hello from Gemini' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
        },
      };
    },
    async *stream(request) {
      calls.push(request);
      yield* (overrides.stream ? overrides.stream(request) : [
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":" there"}]},"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":2,"totalTokenCount":5}}\n\n',
      ]);
    },
  };
}

test('GeminiAdapter converts system instructions, generation config, and responses', async () => {
  const transport = createTransport();
  const adapter = new GeminiAdapter({ transport });
  const response = await adapter.chat({
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ],
    temperature: 0.2,
    topP: 0.8,
    maxOutputTokens: 128,
  }, { credential: { type: 'api-key', value: 'gemini-test' } });

  assert.equal(transport.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(transport.calls[0].headers['x-goog-api-key'], 'gemini-test');
  const body = JSON.parse(transport.calls[0].body);
  assert.deepEqual(body.systemInstruction, { role: 'user', parts: [{ text: 'Be concise.' }] });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Hello' }] }]);
  assert.deepEqual(body.generationConfig, { temperature: 0.2, topP: 0.8, maxOutputTokens: 128 });
  assert.equal(response.providerId, 'gemini');
  assert.equal(response.message.content, 'Hello from Gemini');
  assert.equal(response.finishReason, 'stop');
  assert.deepEqual(response.usage, { inputTokens: 4, outputTokens: 3, totalTokens: 7 });
});

test('GeminiAdapter preserves function names across tool continuations', async () => {
  const transport = createTransport();
  const adapter = new GeminiAdapter({ transport });
  await adapter.chat({
    model: 'gemini-2.5-flash',
    messages: [
      { role: 'user', content: 'Look it up' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      { role: 'tool', toolCallId: 'call-1', content: 'result' },
    ],
  }, { credential: { type: 'api-key', value: 'gemini-test' } });

  const body = JSON.parse(transport.calls[0].body);
  assert.equal(body.contents.at(-1).parts[0].functionResponse.name, 'lookup');
});

test('GeminiAdapter represents blocked prompts as content-filter responses', async () => {
  const transport = createTransport({
    request: async () => ({ status: 200, headers: new Headers(), data: { promptFeedback: { blockReason: 'SAFETY' } } }),
  });
  const adapter = new GeminiAdapter({ transport });
  const response = await adapter.chat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Blocked' }] }, { credential: { type: 'api-key', value: 'gemini-test' } });
  assert.equal(response.message.content, null);
  assert.equal(response.finishReason, 'content_filter');
});

test('GeminiAdapter lists models and normalizes streaming chunks', async () => {
  const transport = createTransport({
    request: async () => ({ status: 200, headers: new Headers(), data: { models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] }] } }),
  });
  const adapter = new GeminiAdapter({ transport });
  const models = await adapter.listModels({ credential: { type: 'api-key', value: 'gemini-test' } });
  const chunks = [];
  for await (const chunk of adapter.streamChat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hi' }] }, { credential: { type: 'api-key', value: 'gemini-test' } })) {
    chunks.push(chunk);
  }

  assert.deepEqual(models, [{ id: 'gemini-2.5-flash', providerId: 'gemini', displayName: 'Gemini Flash', contextWindow: 1048576, capabilities: { chat: true, streaming: false } }]);
  assert.equal(transport.calls[1].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  assert.deepEqual(chunks.map((chunk) => chunk.delta.content), ['Hi', ' there']);
  assert.equal(chunks.at(-1).finishReason, 'stop');
});

test('GeminiAdapter rejects a stream without a terminal finish reason', async () => {
  const transport = createTransport({
    stream: async function* () {
      yield 'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]}}]}\n\n';
    },
  });
  const adapter = new GeminiAdapter({ transport });

  await assert.rejects(async () => {
    for await (const _chunk of adapter.streamChat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hi' }] }, { credential: { type: 'api-key', value: 'gemini-test' } })) {
      // consume the stream
    }
  }, (error) => error instanceof ProviderError && error.code === 'INVALID_RESPONSE');
});

test('GeminiAdapter rejects malformed stream payloads', async () => {
  const transport = createTransport({
    stream: async function* () {
      yield 'data: {}\n\n';
    },
  });
  const adapter = new GeminiAdapter({ transport });

  await assert.rejects(async () => {
    for await (const _chunk of adapter.streamChat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hi' }] }, { credential: { type: 'api-key', value: 'gemini-test' } })) {
      // consume the stream
    }
  }, (error) => error instanceof ProviderError && error.code === 'INVALID_RESPONSE');
});

test('GeminiAdapter requires an API key', async () => {
  const adapter = new GeminiAdapter({ transport: createTransport() });

  await assert.rejects(
    adapter.chat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hello' }] }),
    (error) => error instanceof ProviderError && error.code === 'AUTHENTICATION_FAILED',
  );
});
