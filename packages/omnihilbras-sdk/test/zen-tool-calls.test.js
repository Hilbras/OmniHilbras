import assert from 'node:assert/strict';
import test from 'node:test';
import { ZenAdapter, FetchHttpTransport } from '../dist/index.js';

/**
 * The free-tier stream read only text and the finish reason, so a tool call was dropped on both the streamed
 * and the non-streamed path: the model asked for a tool and the caller received none. An agent cannot work
 * from that. The call's arguments arrive across several deltas, and must join into the JSON the model wrote.
 */
const frames = [
  { id: 'r1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":' } }] }, finish_reason: null }] },
  { id: 'r1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: null }] },
  { id: 'r1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
];
const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
const adapter = () => new ZenAdapter({ transport: new FetchHttpTransport({ fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }) }) });
const req = { model: 'opencode-zen/mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'ls' }], tools: [{ name: 'Bash', description: 'x', parameters: { type: 'object', properties: {} } }] };
const cred = { credential: { type: 'api-key', value: 'k' } };

test('a streamed tool call reaches the caller, with its arguments joined', async () => {
  let calls = [];
  for await (const chunk of adapter().streamChat(req, cred)) calls.push(...(chunk.delta.toolCalls ?? []));
  assert.equal(calls.map((c) => c.function?.arguments ?? '').join(''), '{"command":"ls"}');
});

test('a non-streamed tool call is returned whole, in the OpenAI shape', async () => {
  const reply = await adapter().chat(req, cred);
  assert.equal(reply.finishReason, 'tool_calls');
  assert.deepEqual(reply.message.toolCalls, [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }]);
});
