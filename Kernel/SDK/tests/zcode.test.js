import assert from 'node:assert/strict';
import test from 'node:test';
import { ZcodeAdapter, zcodeEffort, zcodeModel } from '../zcode-start-plan/dist/adapter/index.js';
import { START_PLAN_TEMPLATE } from '../zcode-start-plan/dist/lib/startPlanTemplate.js';

/**
 * ZCode (Start Plan) — the facts the reference project measured, and the adapter that acts on them.
 *
 * 1. The wire is **Anthropic Messages**, at `.../zcode-plan/anthropic/v1/messages`.
 * 2. The backend refuses a request whose **system** prompt was replaced (405/3012), so the stock system
 *    blocks must survive and a caller's system prompt is carried in the first user turn instead.
 * 3. The token is sent as **both** `x-api-key` and `Authorization: Bearer`, with the desktop client's
 *    own headers.
 *
 * All asserted against a scripted transport, so no request reaches the provider.
 */

function transportFor(handler) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      const answer = await handler(request);
      return { status: answer?.status ?? 200, headers: new Headers(), data: answer?.data ?? {} };
    },
    async *stream(request) {
      calls.push(request);
      const chunks = await handler(request);
      for (const chunk of chunks) yield chunk;
    },
  };
}

const credential = { type: 'api-key', value: 'zcode-session-token' };

test('the model list is the two Start Plan models, and it needs no request', async () => {
  const transport = transportFor(() => { throw new Error('listModels must not call the network'); });
  const adapter = new ZcodeAdapter({ transport });
  const models = await adapter.listModels();
  assert.deepEqual(models.map((model) => model.id).sort(), ['glm-5.3', 'glm-5.3-flash']);
  assert.ok(models.every((model) => model.contextWindow === 1_000_000), 'both models must declare the 1M context window');
  assert.equal(transport.calls.length, 0);
});

test('the request keeps the stock system and the Anthropic wire, and sends the token both ways', async () => {
  const transport = transportFor(() => ({
    data: {
      id: 'msg_1', model: 'GLM-5.3-Flash', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  }));
  const adapter = new ZcodeAdapter({ transport });
  const response = await adapter.chat(
    {
      model: 'zc/glm-5.3-flash',
      messages: [
        { role: 'system', content: 'You are a strict reviewer.' },
        { role: 'user', content: 'Reply only OK.' },
      ],
      maxOutputTokens: 32,
      reasoningEffort: 'medium',
    },
    { credential },
  );

  assert.equal(response.message.content, 'OK');
  assert.equal(transport.calls.length, 1);
  const call = transport.calls[0];
  assert.equal(call.url, 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages');
  assert.equal(call.headers['x-api-key'], 'zcode-session-token');
  assert.equal(call.headers.authorization, 'Bearer zcode-session-token');
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.headers['x-zcode-session-type'], 'main');
  assert.equal(call.headers['x-zcode-query-source'], 'main_turn');

  const body = JSON.parse(call.body);
  // The stock system blocks are preserved; the only allowed edit is the workspace placeholder, which
  // the desktop app also substitutes. Replacing the *system itself* is what the backend refuses.
  assert.equal(body.system.length, START_PLAN_TEMPLATE.system.length, 'the stock system blocks were not preserved');
  assert.deepEqual(body.system[0], START_PLAN_TEMPLATE.system[0], 'the first stock system block was altered');
  assert.ok(!JSON.stringify(body.system).includes('__ZCODE_PRIMARY_WORKING_DIRECTORY__'), 'the workspace placeholder was sent literally');
  // The caller's system prompt is carried, not dropped, and not put where it would be refused.
  const firstUser = body.messages.find((message) => message.role === 'user');
  assert.equal(firstUser.content[0].text, 'You are a strict reviewer.');
  assert.equal(body.model, 'GLM-5.3-Flash');
  assert.equal(body.output_config.effort, 'high');
  assert.equal(body.thinking.type, 'enabled');
  assert.equal(body.stream, false);
});

test('a streaming turn yields reasoning, text deltas and a finish reason', async () => {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","model":"GLM-5.3-Flash","usage":{"input_tokens":4}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Considering..."}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"OK"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const transport = transportFor(() => events);
  const adapter = new ZcodeAdapter({ transport });
  const chunks = [];
  for await (const chunk of adapter.streamChat({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'Reply only OK.' }] }, { credential })) {
    chunks.push(chunk);
  }
  const text = chunks.map((chunk) => chunk.delta.content ?? '').join('');
  const reasoning = chunks.map((chunk) => chunk.delta.reasoning ?? '').join('');
  assert.equal(text, 'OK');
  assert.equal(reasoning, 'Considering...', 'the thinking delta was dropped, so the client sees no reasoning');
  assert.ok(chunks.some((chunk) => chunk.finishReason === 'stop'), 'the stream never reported a finish reason');
});

test('no token is an authentication failure, not a network error', async () => {
  const adapter = new ZcodeAdapter({ transport: transportFor(() => ({})) });
  await assert.rejects(
    () => adapter.chat({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => {
      assert.equal(error.code, 'AUTHENTICATION_FAILED');
      assert.match(error.publicMessage ?? '', /access token/i);
      return true;
    },
  );
});

test('every spelling of a model folds onto the two the backend serves', () => {
  assert.equal(zcodeModel('glm-5.3'), 'GLM-5.3');
  assert.equal(zcodeModel('GLM-5.3'), 'GLM-5.3');
  assert.equal(zcodeModel('zc/glm-5.3'), 'GLM-5.3');
  assert.equal(zcodeModel('zcode-glm-5.3-flash'), 'GLM-5.3-Flash');
  assert.equal(zcodeModel('glm-5.3-flash'), 'GLM-5.3-Flash');
  assert.equal(zcodeModel('unknown-model'), 'GLM-5.3-Flash');
});

test('the three gateway efforts fold onto the Start Plan low/high/max', () => {
  assert.equal(zcodeEffort('low'), 'low');
  assert.equal(zcodeEffort('medium'), 'high');
  assert.equal(zcodeEffort('high'), 'high');
  assert.equal(zcodeEffort(undefined), 'max');
});

test('the caller\'s tools and tool results are forwarded structurally, not flattened', async () => {
  // The reference proxies flatten a whole conversation to one prompt and re-synthesise tool calls from
  // the text. This adapter talks the Anthropic wire, so tools stay tools. Whether the *backend* accepts
  // them is the live-verification question; this pins that we send the right shape rather than guessing.
  const transport = transportFor(() => ({
    data: { id: 'msg_t', model: 'GLM-5.3-Flash', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  }));
  const adapter = new ZcodeAdapter({ transport });
  await adapter.chat(
    {
      model: 'glm-5.3',
      messages: [
        { role: 'user', content: 'run ping' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'ping', arguments: '{}' } }] },
        { role: 'tool', toolCallId: 'call-1', content: 'pong' },
      ],
      tools: [{ name: 'ping', description: 'Ping the host', parameters: { type: 'object', properties: {} } }],
    },
    { credential },
  );

  const body = JSON.parse(transport.calls[0].body);
  assert.deepEqual(body.tools, [{ name: 'ping', description: 'Ping the host', input_schema: { type: 'object', properties: {} } }]);
  const toolUse = body.messages.find((message) => (message.content ?? []).some((block) => block.type === 'tool_use'));
  assert.equal(toolUse.content.find((block) => block.type === 'tool_use').id, 'call-1');
  const toolResult = body.messages.find((message) => (message.content ?? []).some((block) => block.type === 'tool_result'));
  assert.equal(toolResult.content[0].tool_use_id, 'call-1');
  assert.equal(toolResult.content[0].content, 'pong');
});

test('the ZCode app device and account ids are reported in metadata.user_id', async () => {
  // The gateway reads these from `~/.zcode/v2` and hands them in; the SDK never touches the filesystem.
  // Attribution only — a missing value falls back to a generated id rather than failing the turn.
  const transport = transportFor(() => ({
    data: { id: 'msg_id', model: 'GLM-5.3-Flash', stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }] },
  }));
  const adapter = new ZcodeAdapter({ transport, deviceMid: 'device-from-app', accountUuid: 'account-from-app' });
  await adapter.chat({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] }, { credential });

  const body = JSON.parse(transport.calls[0].body);
  const userId = JSON.parse(body.metadata.user_id);
  assert.equal(userId.device_id, 'device-from-app');
  assert.equal(userId.account_uuid, 'account-from-app');
  assert.match(userId.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('a turn that spent its budget inside a thinking block is served, not malformed', async () => {
  // Measured against the real endpoint: with `thinking: enabled` and max_tokens 16, GLM answered a
  // message whose only content block was `thinking`. Treating that as a broken response is what made a
  // healthy account fail credential validation with "missing content blocks".
  const transport = transportFor(() => ({
    data: { id: 'msg_think', model: 'glm-5.3-flash', stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: 'considering', signature: 'sig' }], usage: { input_tokens: 5, output_tokens: 16 } },
  }));
  const adapter = new ZcodeAdapter({ transport });
  const response = await adapter.chat({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16 }, { credential });
  assert.equal(response.message.content, null);
  assert.equal(response.finishReason, 'length');
  assert.equal(response.message.reasoning, 'considering', 'the thinking block was dropped from the response');
  assert.deepEqual(response.message.thinking, { text: 'considering', signature: 'sig' }, 'the signed thinking block was not kept for replay');
});

test('credential validation keeps thinking enabled and accepts a thinking-only turn', async () => {
  // The live endpoint refuses `thinking: disabled` with 1210 ("this model always thinks"). A short
  // reply can therefore be thinking-only, and that still proves the token is accepted.
  const transport = transportFor(() => ({
    data: { id: 'msg_think_ok', model: 'glm-5.3-flash', stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: 'considering', signature: 'sig' }] },
  }));
  const adapter = new ZcodeAdapter({ transport });
  const result = await adapter.validateCredential({ type: 'api-key', value: 'zcode-session-token' });
  assert.equal(result.status, 'valid');
  const body = JSON.parse(transport.calls[0].body);
  assert.deepEqual(body.thinking, { type: 'enabled' }, 'validation must keep thinking enabled; the model refuses it disabled');
  assert.equal(body.max_tokens, 32);
});

test('a business error inside a 200 surfaces the provider message as the public one', async () => {
  const transport = transportFor(() => ({ data: { code: 1005, msg: 'exceed quota limit' } }));
  const adapter = new ZcodeAdapter({ transport });
  await assert.rejects(
    () => adapter.chat({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] }, { credential }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_REQUEST_FAILED');
      assert.match(error.publicMessage ?? '', /exceed quota limit/);
      return true;
    },
  );
});

test('the template workspace placeholder is substituted, not sent literally', async () => {
  // The desktop app substitutes the signed-in workspace for `__ZCODE_PRIMARY_WORKING_DIRECTORY__`.
  // A gateway has no workspace, and leaving the literal in the system prompt made the model repeat it
  // as the directory in its answer.
  const transport = transportFor(() => ({
    data: { id: 'msg_dir', model: 'glm-5.3-flash', stop_reason: 'end_turn', content: [{ type: 'text', text: 'OK' }] },
  }));
  const adapter = new ZcodeAdapter({ transport, workingDirectory: '/home/gin/work' });
  await adapter.chat({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] }, { credential });
  const body = JSON.parse(transport.calls[0].body);
  const system = JSON.stringify(body.system);
  assert.ok(!system.includes('__ZCODE_PRIMARY_WORKING_DIRECTORY__'), 'the placeholder was sent literally');
  assert.ok(system.includes('/home/gin/work'), 'the working directory is missing from the system prompt');
});