import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * The tool contract as the gateway applies it.
 *
 * The package's own tests prove the decisions; this proves they are the ones the request path takes. The adapter is the
 * assertion point throughout: it receives what the provider would actually get.
 */

const tool = (name, extra = {}) => ({ name, description: `${name} tool`, parameters: { type: 'object', properties: {} }, ...extra });
const call = (name, args, id = 'call_1') => ({ id, type: 'function', function: { name, arguments: args } });

function harness({ response } = {}) {
  const requests = [];
  const registry = new ProviderRegistry();
  for (const id of ['kiro', 'qwen-web', 'openai', 'opencode']) {
    registry.register({
      id,
      name: id,
      capabilities: { chat: true, streaming: true, models: true },
      async listModels() { return [{ id: 'm', providerId: id }]; },
      async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
      async chat(request) {
        requests.push(request);
        return response?.(request, id) ?? {
          id: 'r', providerId: id, model: request.model, createdAt: new Date().toISOString(),
          message: { role: 'assistant', content: 'ok' }, finishReason: 'stop',
        };
      },
      async *streamChat(request) {
        requests.push(request);
        yield { id: 'r', model: request.model, delta: { ...(response ? { toolCalls: response(request, id).message.toolCalls ?? [] } : {}) }, finishReason: 'tool_calls' };
      },
    });
  }
  const store = new InMemoryConnectionStore();
  for (const id of ['kiro', 'qwen-web', 'openai', 'opencode']) {
    void store.save({ id, providerId: id, name: id, endpoint: 'https://example.invalid/v1', priority: 1, proxyPool: 'none', modelIds: ['m'] }, { type: 'api-key', value: 'key' });
  }
  const service = new GatewayService(registry, store, store, new InMemoryApiKeyStore(), {});
  return { requests, service };
}

test('a forced call is refused by name where the provider cannot honour it', async () => {
  // `kiro` accepts tools and has no way to force one. Anthropic used to be the example here until its table row was
  // corrected: it had been mapping `required` to `{type:"any"}` all along.
  const { requests, service } = harness();
  await assert.rejects(
    () => service.chat('kiro', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('read')], toolChoice: 'required' }),
    (error) => {
      assert.equal(error.code, 'NOT_SUPPORTED');
      assert.match(error.publicMessage ?? error.message, /cannot be told to force a tool call/);
      return true;
    },
  );
  assert.equal(requests.length, 0, 'the request was sent even though it could not be honoured');
});

test('a forced call reaches a provider whose adapter maps it', async () => {
  const { requests, service } = harness();
  await service.chat('openai', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('read')], toolChoice: 'required' });
  assert.equal(requests.at(-1).toolChoice, 'required');
});

test('tool_choice: none removes the definitions before the adapter sees them', async () => {
  const { requests, service } = harness();
  await service.chat('openai', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('read')], toolChoice: 'none' });
  assert.equal(requests.at(-1).tools, undefined);
});

test('a web provider receives no tools at all', async () => {
  const { requests, service } = harness();
  await service.chat('qwen-web', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('bash')] });
  assert.equal(requests.at(-1).tools, undefined, 'a web session was handed a schema it will ignore');
});

test('a call naming a tool the client never declared is dropped, and the turn stops claiming a tool call', async () => {
  const { service } = harness({
    response: () => ({
      id: 'r', providerId: 'openai', model: 'm', createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: null, toolCalls: [call('rm_rf', '{"path":"/"}')] },
      finishReason: 'tool_calls',
    }),
  });
  const response = await service.chat('openai', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('read')] });
  assert.equal(response.message.toolCalls, undefined, 'an undeclared tool reached the client');
  assert.equal(response.finishReason, 'stop', 'a turn with no forwarded call still reported tool_calls');
});

test('the free-tier declaration comes from the gateway and contains no shell tool', async () => {
  // `applyToolContract` is private in TypeScript but is the exact seam the gateway applies before every adapter.
  // Driving it directly avoids resolving a real OpenCode adapter (and a real key) in a unit test.
  const { service } = harness();
  const { request } = await service.applyToolContract('opencode', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  const names = (request.tools ?? []).map((entry) => entry.name);
  assert.deepEqual(names, ['glob', 'grep', 'read'], 'the SDKs no longer declare tools; the gateway must supply them');
  assert.equal(names.includes('bash'), false, 'a shell tool reached a provider request');
});

test('a forced call on an OpenCode free lane is refused by name before any provider is called', async () => {
  // Its capability row states `auto`/`none`: these lanes have always refused `required`. Claiming
  // otherwise made the refusal terminal *after* a request had started, which silently ended agent turns.
  const { service } = harness();
  await assert.rejects(
    service.applyToolContract('opencode', {
      model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('write')], toolChoice: 'required',
    }),
    (error) => error.code === 'NOT_SUPPORTED' && /cannot honour tool_choice/.test(error.message),
  );
});

test('tool history is healed before it reaches a provider', async () => {
  const { requests, service } = harness();
  await service.chat('openai', {
    model: 'm',
    messages: [{ role: 'assistant', content: '', toolCalls: [call('read', '{}', 'bad id!')] }],
  });
  const sent = requests.at(-1).messages;
  assert.equal(sent[0].toolCalls[0].id, 'badid', 'the provider received a malformed tool id');
  assert.deepEqual(sent[1], { role: 'tool', content: '', toolCallId: 'badid' }, 'the unanswered call was not filled under the healed id');
});

test('a definition dropped by sanitisation is not a tool the model may call', async () => {
  // `declared` used to be read from the raw request, before sanitisation. A rejected definition (a name with a space)
  // therefore stayed on the allow list, and a provider that called it was believed to be calling something the client
  // had offered. The allow list must be the definitions that actually reached the adapter.
  const { service } = harness({
    response: () => ({
      id: 'r', providerId: 'openai', model: 'm', createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: null, toolCalls: [call('bad name', '{}')] },
      finishReason: 'tool_calls',
    }),
  });
  const response = await service.chat('openai', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('bad name')] });
  assert.equal(response.message.toolCalls, undefined, 'a call to a definition that never reached the provider was forwarded');
  assert.equal(response.finishReason, 'stop');
});

test('a call with a repairable argument payload is repaired, not dropped', async () => {
  const { service } = harness({
    response: () => ({
      id: 'r', providerId: 'openai', model: 'm', createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: null, toolCalls: [call('read', '{"path":"a.ts",}')] },
      finishReason: 'tool_calls',
    }),
  });
  const response = await service.chat('openai', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('read')] });
  assert.equal(response.message.toolCalls?.[0]?.function.arguments, '{"path":"a.ts"}');
  assert.equal(response.finishReason, 'tool_calls');
});

test('a streamed call to an undeclared tool never reaches the client', async () => {
  const { service } = harness({
    response: () => ({
      id: 'r', providerId: 'openai', model: 'm', createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: null, toolCalls: [call('rm_rf', '{"path":"/"}')] },
      finishReason: 'tool_calls',
    }),
  });
  const chunks = [];
  for await (const chunk of service.streamChat('openai', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('read')] })) {
    chunks.push(chunk);
  }
  const emitted = chunks.flatMap((chunk) => [...(chunk.delta.toolCalls ?? [])]);
  assert.deepEqual(emitted, [], 'the blocked call was streamed to the client');
  assert.equal(chunks.at(-1).finishReason, 'stop', 'the stream still ended as a tool call');
});

test('a returned tool call makes the turn a tool turn whatever finish reason the provider reported', async () => {
  // Gemini answers a function-call turn with `STOP`, and Claude Code hardcodes `stop` on its final stream chunk.
  // Clients that key their loop on finish_reason stopped there with a perfectly good call in their hands.
  const { service } = harness({
    response: () => ({
      id: 'r', providerId: 'openai', model: 'm', createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: null, toolCalls: [call('read', '{"path":"a.ts"}')] },
      finishReason: 'stop',
    }),
  });
  const response = await service.chat('openai', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('read')] });
  assert.equal(response.message.toolCalls?.length, 1);
  assert.equal(response.finishReason, 'tool_calls', 'the gateway derives the terminal state from the call it forwards');
});
