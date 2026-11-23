import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';
import { isPublicLlmRoute } from '../dist/src/routes/inference.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';

// Codex-style clients speak the Responses API (`input`, `output`), not chat completions. Without this route they
// cannot point at the gateway at all. The route translates the request onto the same chat path, so routing, failover,
// usage and the key gate are the ones chat already has.

function recordingProvider(seen) {
  return {
    id: 'fake',
    name: 'Fake',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'fake-1', providerId: 'fake' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString() }; },
    async chat(request) {
      seen.push(request);
      return { id: 'r1', providerId: 'fake', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'pong' }, finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
    },
  };
}

async function start(t, seen, provider = recordingProvider(seen)) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('responses')).key;
  const registry = new ProviderRegistry().register(provider);
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'fake', providerId: 'fake', name: 'Fake', endpoint: 'https://f.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: 'k' });
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, key };
}

test('THE BOUNDARY: /v1/responses is in the authenticated route set', () => {
  assert.equal(isPublicLlmRoute('POST', '/v1/responses'), true, 'a route served to clients must be on the auth list');
});

test('an unauthenticated POST /v1/responses is refused with 401', async (t) => {
  const seen = [];
  const { base } = await start(t, seen);
  const response = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-1', input: 'ping' }) });
  assert.equal(response.status, 401);
  assert.equal(seen.length, 0, 'nothing reaches a provider without a key');
});

test('a Responses request is answered in the Responses shape, and reaches the provider as a chat request', async (t) => {
  const seen = [];
  const { base, key } = await start(t, seen);
  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'fake-1', instructions: 'Be brief.', input: 'ping' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.equal(body.output_text, 'pong');
  assert.equal(body.output[0].content[0].text, 'pong');
  assert.equal(seen[0].messages.find((message) => message.role === 'system')?.content, 'Be brief.', 'instructions become the system message');
  assert.equal(seen[0].messages.at(-1).content, 'ping', 'input becomes the user message');
});

test('the Responses wire shapes are translated: parts, developer role, flat tools, reasoning', async (t) => {
  const seen = [];
  const { base, key } = await start(t, seen);
  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'fake-1',
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'Be terse.' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'ping' }] },
        { type: 'function_call_output', call_id: 'call_1', output: 'result' },
      ],
      tools: [{ type: 'function', name: 'lookup', description: 'Find a thing', parameters: { type: 'object', properties: {} } }],
      tool_choice: 'auto',
      reasoning: { effort: 'low' },
      max_output_tokens: 64,
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.gateway?.requestId, 'a successful response carries the gateway request id');
  assert.deepEqual(seen[0].messages.map((message) => message.role), ['system', 'user', 'tool']);
  assert.deepEqual(seen[0].messages[2].toolCallId, 'call_1');
  assert.equal(seen[0].tools[0].name, 'lookup', 'a flat Responses tool became a chat tool');
  assert.equal(seen[0].toolChoice, 'auto');
  assert.equal(seen[0].reasoningEffort, 'low');
  assert.equal(seen[0].maxOutputTokens, 64);
});

test('a tool-call answer is emitted as function_call output instead of an empty message', async (t) => {
  const seen = [];
  const provider = {
    ...recordingProvider(seen),
    async chat(request) {
      seen.push(request);
      return {
        id: 'r1', providerId: 'fake', model: request.model, createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: '', toolCalls: [{ id: 'call_9', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        finishReason: 'tool_calls',
      };
    },
  };
  const { base, key } = await start(t, seen, provider);
  const body = await (await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'fake-1', input: 'ping', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] }),
  })).json();
  assert.equal(body.output_text, '');
  assert.equal(body.output.length, 1, 'no empty assistant message beside the call');
  assert.deepEqual({ type: body.output[0].type, call_id: body.output[0].call_id, name: body.output[0].name, arguments: body.output[0].arguments }, {
    type: 'function_call', call_id: 'call_9', name: 'lookup', arguments: '{"q":"x"}',
  });
});

function streamingProvider() {
  return {
    id: 'fake',
    name: 'Fake',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'fake-1', providerId: 'fake' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString() }; },
    async chat() { throw new Error('the streamed test must not reach the non-streaming path'); },
    async *streamChat() {
      yield { id: 'r2', providerId: 'fake', model: 'fake-1', delta: { role: 'assistant', content: 'po' } };
      yield { id: 'r2', providerId: 'fake', model: 'fake-1', delta: { content: 'ng' }, finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
    },
  };
}

test('stream: true on /v1/responses is answered as Responses events: text deltas, then response.completed with the full body', async (t) => {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('responses')).key;
  const registry = new ProviderRegistry().register(streamingProvider());
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'fake', providerId: 'fake', name: 'Fake', endpoint: 'https://f.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: 'k' });
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'fake-1', input: 'ping', stream: true }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  const events = text.split('\n\n').filter(Boolean).map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(block)[1]);
    return { event, data };
  });
  const names = events.map((e) => e.event);
  assert.equal(names[0], 'response.created', 'a Responses stream opens with response.created');
  assert.equal(names[1], 'response.in_progress', 'in_progress follows created before any work');
  const deltas = events.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta);
  assert.deepEqual(deltas, ['po', 'ng'], 'each text delta is its own event, in order');
  assert.ok(events.some((e) => e.event === 'response.output_text.done'), 'the text block is explicitly closed');
  assert.equal(events.findIndex((e) => e.event === 'response.output_text.done') > events.findIndex((e) => e.event === 'response.output_text.delta'), true);
  const completed = events.at(-1);
  assert.equal(completed.event, 'response.completed', 'the last event is response.completed');
  assert.equal(completed.data.response.object, 'response');
  assert.equal(completed.data.response.status, 'completed');
  assert.equal(completed.data.response.output_text, 'pong', 'the completed body carries the joined text');
});


/**
 * A scripted stream with reasoning first and a tool call after it. The exact event order is the
 * contract: a strict Responses client builds its output blocks from these announcements, so a missing
 * `part.added` or an early `part.done` silently loses the thinking block or the tool round.
 */
test('stream: reasoning and tool calls use the full Responses event lifecycle, in order', async (t) => {
  const provider = {
    id: 'fake', name: 'Fake',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'fake-1', providerId: 'fake' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString() }; },
    async chat() { throw new Error('the streamed test must not reach the non-streaming path'); },
    async *streamChat() {
      yield { id: 'r3', providerId: 'fake', model: 'fake-1', delta: { reasoning: 'thinking ' } };
      yield { id: 'r3', providerId: 'fake', model: 'fake-1', delta: { reasoning: 'hard' } };
      yield { id: 'r3', providerId: 'fake', model: 'fake-1', delta: { content: 'answer' } };
      yield { id: 'r3', providerId: 'fake', model: 'fake-1', delta: { toolCalls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"q"' } }] } };
      yield { id: 'r3', providerId: 'fake', model: 'fake-1', delta: { toolCalls: [{ index: 0, function: { arguments: ':1}' } }] }, finishReason: 'tool_calls', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
    },
  };
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('responses')).key;
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'fake', providerId: 'fake', name: 'Fake', endpoint: 'https://f.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } }, { type: 'api-key', value: 'k' });
  const service = new GatewayService(new ProviderRegistry().register(provider), new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'fake-1', input: 'ping', stream: true, tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] }),
  });
  const events = (await response.text()).split('\n\n').filter(Boolean).map((block) => ({
    event: /^event: (.+)$/m.exec(block)?.[1],
    data: JSON.parse(/^data: (.+)$/m.exec(block)[1]),
  }));
  assert.deepEqual(events.map((entry) => entry.event), [
    'response.created',
    'response.in_progress',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done',
    'response.reasoning_summary_part.done',
    'response.output_text.delta',
    'response.output_text.done',
    'response.output_item.added',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
    'response.output_item.done',
    'response.completed',
  ]);
  assert.deepEqual(events.filter((entry) => entry.event === 'response.reasoning_summary_text.delta').map((entry) => entry.data.delta), ['thinking ', 'hard']);
  assert.equal(events.find((entry) => entry.event === 'response.reasoning_summary_text.done').data.text, 'thinking hard');
  assert.equal(events.find((entry) => entry.event === 'response.output_text.done').data.text, 'answer');
  assert.equal(events.at(-1).data.response.status, 'completed');
});

test('stream: a provider failure ends with one response.failed and no response.completed', async (t) => {
  const provider = {
    id: 'fake', name: 'Fake',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'fake-1', providerId: 'fake' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString() }; },
    async chat() { throw new Error('the streamed test must not reach the non-streaming path'); },
    async *streamChat() {
      yield { id: 'r4', providerId: 'fake', model: 'fake-1', delta: { content: 'partial' } };
      throw new Error('scripted upstream failure');
    },
  };
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('responses')).key;
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'fake', providerId: 'fake', name: 'Fake', endpoint: 'https://f.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } }, { type: 'api-key', value: 'k' });
  const service = new GatewayService(new ProviderRegistry().register(provider), new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'fake-1', input: 'ping', stream: true }),
  });
  const events = (await response.text()).split('\n\n').filter(Boolean).map((block) => ({
    event: /^event: (.+)$/m.exec(block)?.[1],
    data: JSON.parse(/^data: (.+)$/m.exec(block)[1]),
  }));
  assert.equal(events.filter((entry) => entry.event === 'response.completed').length, 0, 'a failed turn must never report completion');
  const failed = events.filter((entry) => entry.event === 'response.failed');
  assert.equal(failed.length, 1, 'exactly one terminal response.failed');
  assert.equal(failed[0].data.response.status, 'failed');
  assert.ok(failed[0].data.response.error.code, 'the failure carries the gateway error code');
  assert.ok(events.some((entry) => entry.event === 'response.output_text.done'), 'the partial text block is closed even on failure');
});
