import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicAdapter, ProviderError } from '../dist/index.js';

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
          id: 'msg-1',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'Hello from Claude' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 3 },
        },
      };
    },
    async *stream(request) {
      calls.push(request);
      yield* (overrides.stream ? overrides.stream(request) : [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-stream","model":"claude-sonnet-4"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
    },
  };
}

test('AnthropicAdapter converts system messages, tools, and responses', async () => {
  const transport = createTransport();
  const adapter = new AnthropicAdapter({ transport });
  const response = await adapter.chat({
    model: 'claude-sonnet-4',
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ],
    maxOutputTokens: 256,
    tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
  }, { credential: { type: 'api-key', value: 'sk-ant-test' } });

  assert.equal(transport.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(transport.calls[0].headers['x-api-key'], 'sk-ant-test');
  assert.equal(transport.calls[0].headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(transport.calls[0].body);
  assert.equal(body.system, 'Be concise.');
  assert.equal(body.max_tokens, 256);
  assert.deepEqual(body.tools, [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object' } }]);
  assert.equal(response.providerId, 'anthropic');
  assert.equal(response.message.content, 'Hello from Claude');
  assert.equal(response.finishReason, 'stop');
  assert.deepEqual(response.usage, { inputTokens: 4, outputTokens: 3 });
});

test('AnthropicAdapter represents a refusal as a content-filter response', async () => {
  const transport = createTransport({
    request: async () => ({ status: 200, headers: new Headers(), data: { id: 'msg-refusal', model: 'claude-sonnet-4', content: [], stop_reason: 'refusal' } }),
  });
  const adapter = new AnthropicAdapter({ transport });
  const response = await adapter.chat({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'Hello' }] }, { credential: { type: 'api-key', value: 'sk-ant-test' } });
  assert.equal(response.message.content, null);
  assert.equal(response.finishReason, 'content_filter');
});

test('AnthropicAdapter normalizes native SSE events and tool deltas', async () => {
  const transport = createTransport({
    stream: async function* () {
      yield 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-stream","model":"claude-sonnet-4"}}\n\n';
      yield 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
      yield 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n';
      yield 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n\n';
      yield 'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"lookup"}}\n\n';
      yield 'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"x\\"}"}}\n\n';
      yield 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n';
      yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    },
  });
  const adapter = new AnthropicAdapter({ transport });
  const chunks = [];
  for await (const chunk of adapter.streamChat({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'Hi' }] }, { credential: { type: 'api-key', value: 'sk-ant-test' } })) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks.filter((chunk) => chunk.delta.content).map((chunk) => chunk.delta.content), ['Hi', ' there']);
  assert.equal(chunks.find((chunk) => chunk.delta.toolCalls)?.delta.toolCalls[0].function.name, 'lookup');
  assert.equal(chunks.at(-1).finishReason, 'tool_calls');
});

test('AnthropicAdapter requires an API key', async () => {
  const adapter = new AnthropicAdapter({ transport: createTransport() });

  await assert.rejects(
    adapter.chat({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'Hello' }] }),
    (error) => error instanceof ProviderError && error.code === 'AUTHENTICATION_FAILED',
  );
});
