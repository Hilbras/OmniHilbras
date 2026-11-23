import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
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

test('a web provider refuses declared tools instead of stripping them silently', async () => {
  const { requests, service } = harness();
  await assert.rejects(
    () => service.chat('qwen-web', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('bash')] }),
    (error) => error.code === 'NOT_SUPPORTED' && /cannot serve function tools/.test(error.publicMessage ?? ''),
  );
  assert.equal(requests.length, 0, 'no provider was billed for a contract the gateway could not honour');
});

test('a call naming a tool the client never declared is dropped, and the turn stops claiming a tool call', async () => {
  const { service } = harness({
    response: () => ({
      id: 'r', providerId: 'openai', model: 'm', createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: null, toolCalls: [call('rm_rf', '{"path":"/"}')] },
      finishReason: 'tool_calls',
    }),
  });
  const scope = { id: 'scope-dropped-call', startedAt: Date.now(), requestedModel: 'm' };
  const response = await service.chat('openai', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('read')] }, undefined, scope);
  assert.equal(response.message.toolCalls, undefined, 'an undeclared tool reached the client');
  assert.equal(response.finishReason, 'stop', 'a turn with no forwarded call still reported tool_calls');
  assert.equal(service.blockedCallsFor(scope.id), 1, 'the rejected call must be visible to the route, not only in a log');
  assert.equal(service.blockedCallsFor('other-scope'), 0);
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

test('a Zen Messages-lane stream refuses by name before any chunk or request', async () => {
  // The lane cannot stream tools. Silently answering with a finished non-stream turn used to break an
  // agent waiting for deltas; refusing before the first byte is the honest answer and must not spend a
  // request. `streamChat` is an async generator, so its body runs on first iteration.
  const { ZenAdapter } = await import('../../SDK/opencode-zen/dist/adapter/index.js');
  let used = false;
  const transport = {
    async request() { used = true; throw new Error('the refusing lane reached the transport'); },
    async *stream() { used = true; throw new Error('the refusing lane reached the transport'); },
  };
  const adapter = new ZenAdapter({ transport });
  const chunks = adapter.streamChat(
    { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }], tools: [tool('read')] },
    { credential: { type: 'api-key', value: 'k' } },
  );
  await assert.rejects(async () => { for await (const _chunk of chunks) { /* collect */ } }, (error) => error.code === 'NOT_SUPPORTED' && /Streaming is not implemented/.test(error.message));
  assert.equal(used, false, 'the refusal cost an upstream request');
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
  const scope = { id: 'scope-stream-dropped', startedAt: Date.now(), requestedModel: 'm' };
  for await (const chunk of service.streamChat('openai', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('read')] }, undefined, scope)) {
    chunks.push(chunk);
  }
  const emitted = chunks.flatMap((chunk) => [...(chunk.delta.toolCalls ?? [])]);
  assert.deepEqual(emitted, [], 'the blocked call was streamed to the client');
  assert.equal(chunks.at(-1).finishReason, 'stop', 'the stream still ended as a tool call');
  assert.equal(service.blockedCallsFor(scope.id), 1, 'a blocked stream call is counted for the route');
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

test('a model that publishes no tools gets the same stated refusal', async () => {
  // The per-model narrowing uses the connection's own catalog metadata. A provider row that allows tools
  // must not turn a model that cannot call them into a normal text answer.
  const requests = [];
  const registry = new ProviderRegistry().register({
    id: 'openai', name: 'openai', capabilities: { chat: true, models: true },
    async listModels() { return [{ id: 'm', providerId: 'openai' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request) { requests.push(request); return { id: 'r', providerId: 'openai', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }; },
  });
  const connections = new InMemoryConnectionStore();
  void connections.save({
    id: 'openai', providerId: 'openai', name: 'openai', endpoint: 'https://example.invalid/v1',
    priority: 1, proxyPool: 'none', modelIds: ['m'], modelMeta: { m: { cp: { tools: false } } },
  }, { type: 'api-key', value: 'k' });
  const narrowed = new GatewayService(registry, new InMemorySecretStore({}), connections, new InMemoryApiKeyStore(), {});
  await assert.rejects(
    () => narrowed.chat('openai', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('read')] }, undefined, undefined, 'openai'),
    (error) => error.code === 'NOT_SUPPORTED' && /cannot serve function tools/.test(error.publicMessage ?? ''),
  );
  assert.equal(requests.length, 0);
});

test('a caller that opts out of tools or sends none is still served by a text-only provider', async () => {
  const { service } = harness();
  const none = await service.chat('qwen-web', { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('read')], toolChoice: 'none' });
  assert.equal(none.message.content, 'ok');
  const plain = await service.chat('qwen-web', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(plain.message.content, 'ok');
});
