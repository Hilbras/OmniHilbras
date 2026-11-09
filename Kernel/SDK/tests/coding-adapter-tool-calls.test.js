import assert from 'node:assert/strict';
import test from 'node:test';
import { createMinimaxCodeAdapter } from '../minimax-code/dist/adapter/index.js';
import { createKiloCodeAdapter } from '../kilocode/dist/adapter/index.js';

/**
 * Tool calls from the two coding subscriptions, on both transport paths.
 *
 * Both adapters dropped `tool_use` / `tool_calls` on the non-streaming path (MiniMax also on the
 * streaming path, where it only read text deltas). A turn that asked for a tool returned
 * `finishReason: 'tool_calls'` with no calls, which a client cannot act on — and the streaming and
 * non-streaming paths disagreed about the same provider.
 */

const oauth = { type: 'oauth', value: 'access-token' };

function jsonTransport(data) {
  const requests = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      return { status: 200, headers: new Headers(), data };
    },
    async *stream() {
      throw new Error('not used');
    },
  };
}

test('Kilo Code keeps tool calls on the non-streaming path', async () => {
  const transport = jsonTransport({
    id: 'chat-1',
    model: 'kilo-1',
    choices: [{
      message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
      finish_reason: 'tool_calls',
    }],
  });
  const adapter = createKiloCodeAdapter({ transport });
  const response = await adapter.chat({ model: 'kilo-1', messages: [{ role: 'user', content: 'hi' }] }, { credential: oauth });
  assert.deepEqual(response.message.toolCalls, [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }]);
  assert.equal(response.finishReason, 'tool_calls');
});

test('MiniMax Code keeps tool_use blocks on the non-streaming path', async () => {
  const transport = jsonTransport({
    id: 'msg-1',
    model: 'MiniMax-M3',
    content: [{ type: 'text', text: '' }, { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }],
    stop_reason: 'tool_use',
  });
  const adapter = createMinimaxCodeAdapter('cn', { transport });
  const response = await adapter.chat({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }] }, { credential: oauth });
  assert.deepEqual(response.message.toolCalls, [{ id: 'toolu_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }]);
});

test('MiniMax Code streams tool_use blocks as tool-call deltas', async () => {
  const transport = {
    async request() {
      throw new Error('not used');
    },
    async *stream() {
      yield 'event: message_start\ndata: {"type":"message_start","message":{"id":"s1","usage":{"input_tokens":5}}}\n\n';
      yield 'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_2","name":"lookup"}}\n\n';
      yield 'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"x\\"}"}}\n\n';
      yield 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n';
      yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    },
  };
  const adapter = createMinimaxCodeAdapter('cn', { transport });
  const chunks = [];
  for await (const chunk of adapter.streamChat({ model: 'MiniMax-M3', messages: [{ role: 'user', content: 'hi' }] }, { credential: oauth })) chunks.push(chunk);
  const calls = chunks.flatMap((chunk) => chunk.delta.toolCalls ?? []);
  assert.deepEqual([calls[0].index, calls[0].id, calls[0].function?.name], [1, 'toolu_2', 'lookup']);
  assert.equal(calls.map((call) => call.function?.arguments ?? '').join(''), '{"q":"x"}');
  const last = chunks.at(-1);
  assert.equal(last.finishReason, 'tool_calls');
  assert.deepEqual(last.usage, { inputTokens: 5, outputTokens: 2 });
});
