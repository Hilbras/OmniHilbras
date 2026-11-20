import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';
import { isPublicLlmRoute } from '../dist/src/routes/inference.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';

// Anthropic SDK clients speak /v1/messages. The route translates directly onto the chat path and reframes the
// reply; these assert the shape a client actually sees, plus the auth boundary and the two shapes that made
// every agent turn fail with "The request is invalid." before a provider was reached (stream and tool_result).

function recordingProvider(seen, streaming = false, reasoning = false) {
  return {
    id: 'custom',
    name: 'Custom',
    capabilities: { chat: true, streaming, models: true },
    async listModels() { return [{ id: 'fake-1', providerId: 'custom' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString() }; },
    async chat(request) {
      seen.push(request);
      return { id: 'msg_1', providerId: 'custom', model: request.model, createdAt: '2026-11-20T00:00:00.000Z', message: { role: 'assistant', content: 'pong' }, finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
    },
    async *streamChat(providerId, request) {
      seen.push(request);
      if (reasoning) yield { id: 'chunk_0', providerId, model: request.model, delta: { reasoning: 'Thinking.' } };
      yield { id: 'chunk_1', providerId, model: request.model, delta: { content: 'po' } };
      yield { id: 'chunk_1', providerId, model: request.model, delta: { content: 'ng' } };
      yield {
        id: 'chunk_1', providerId, model: request.model,
        delta: { toolCalls: [{ index: 0, id: 'call_7', function: { name: 'Read', arguments: '{"file_path":"package.json"}' } }] },
        usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      };
    },
  };
}

async function start(t, seen, streaming = false, reasoning = false) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('messages')).key;
  const registry = new ProviderRegistry().register(recordingProvider(seen, streaming, reasoning));
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'custom', providerId: 'custom', name: 'Custom', endpoint: 'https://f.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } }, { type: 'api-key', value: 'k' });
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, key };
}

const post = (base, key, body) => fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
});

test('/v1/messages is on the authenticated route set', () => {
  assert.equal(isPublicLlmRoute('POST', '/v1/messages'), true, 'a client route must be behind the key gate');
});

test('an unauthenticated POST /v1/messages is refused and reaches no provider', async (t) => {
  const seen = [];
  const { base } = await start(t, seen);
  const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'ping' }] }) });
  assert.equal(response.status, 401);
  assert.equal(seen.length, 0);
});

test('an authenticated Anthropic request is translated and the reply reframed', async (t) => {
  const seen = [];
  const { base, key } = await start(t, seen);
  const response = await post(base, key, {
    model: 'fake-1',
    system: [{ type: 'text', text: 'Be brief.' }],
    max_tokens: 50,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.content, [{ type: 'text', text: 'pong' }]);
  assert.equal(body.usage.input_tokens, 3);
  assert.match(body.id, /^msg_/, 'Anthropic clients expect the msg_ id prefix');
  assert.equal(body.gateway.requestId, body.id ? body.gateway.requestId : null);
  assert.equal(seen.length, 1, 'one provider call through the direct translation');
  assert.equal(seen[0].messages[0].content, 'Be brief.', 'system translated to a system message');
  assert.equal(seen[0].maxOutputTokens, 50, 'max_tokens translated to the internal chat field');
});

test('a full agent turn with tool_use and tool_result history reaches the provider', async (t) => {
  const seen = [];
  const { base, key } = await start(t, seen);
  const response = await post(base, key, {
    model: 'fake-1',
    max_tokens: 100,
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
    tool_choice: { type: 'tool', name: 'Read' },
    system: 'You are a coding agent.',
    stop_sequences: ['END'],
    messages: [
      { role: 'user', content: 'Read package.json' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'package.json' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '{"name":"demo"}' }] },
      ] },
    ],
  });
  assert.equal(response.status, 200, `the whole tool loop is accepted, not refused as invalid: ${JSON.stringify(await response.json())}`);
  assert.equal(seen.length, 1);
  const messages = seen[0].messages;
  assert.deepEqual(messages.at(-1), { role: 'tool', toolCallId: 'toolu_1', content: '{"name":"demo"}' });
  assert.deepEqual(messages[2].toolCalls, [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"package.json"}' } }]);
  assert.equal(seen[0].toolChoice, 'required', 'Anthropic tool_choice is honored');
  assert.deepEqual(seen[0].stop, ['END'], 'stop_sequences are forwarded');
});

test('stream on /v1/messages emits Anthropic SSE events and completes', async (t) => {
  const seen = [];
  const { base, key } = await start(t, seen, true);
  const response = await post(base, key, { model: 'fake-1', stream: true, messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await response.text();
  const events = text.trim().split('\n\n').map((frame) => {
    const lines = frame.split('\n');
    return { event: lines.find((line) => line.startsWith('event: '))?.slice(7), data: JSON.parse(lines.find((line) => line.startsWith('data: '))?.slice(6) ?? '{}') };
  });
  const names = events.map((entry) => entry.event);
  assert.equal(names[0], 'message_start', 'the stream opens with message_start');
  assert.equal(names.at(-1), 'message_stop', 'the stream closes with message_stop');
  assert.match(events[0].data.message.id, /^msg_/);
  const deltaText = events.filter((entry) => entry.event === 'content_block_delta' && entry.data.delta.type === 'text_delta').map((entry) => entry.data.delta.text).join('');
  assert.equal(deltaText, 'pong');
  const jsonDeltas = events.filter((entry) => entry.event === 'content_block_delta' && entry.data.delta.type === 'input_json_delta').map((entry) => entry.data.delta.partial_json).join('');
  assert.equal(jsonDeltas, '{"file_path":"package.json"}');
  assert.equal(events.find((entry) => entry.event === 'message_delta').data.delta.stop_reason, 'tool_use');
  assert.equal(events.find((entry) => entry.event === 'message_delta').data.usage.output_tokens, 5);
  const starts = events.filter((entry) => entry.event === 'content_block_start').map((entry) => entry.data.index).sort();
  const stops = events.filter((entry) => entry.event === 'content_block_stop').map((entry) => entry.data.index).sort();
  assert.deepEqual(starts, stops, 'every content block is closed');
  assert.equal(seen.length, 1, 'one provider stream');
});

test('the chat route accepts the object tool_choice agents send', async (t) => {
  const seen = [];
  const { base, key } = await start(t, seen);
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'fake-1',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }],
      tool_choice: { type: 'function', function: { name: 'Read' } },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(seen[0].toolChoice, 'required');
});


test('a thinking model streams its reasoning as an Anthropic thinking block', async (t) => {
  const seen = [];
  const { base, key } = await start(t, seen, true, true);
  const response = await post(base, key, { model: 'fake-1', stream: true, messages: [{ role: 'user', content: 'think' }] });
  assert.equal(response.status, 200);
  const text = await response.text();
  const events = text.trim().split('\n\n').map((frame) => {
    const lines = frame.split('\n');
    return { event: lines.find((line) => line.startsWith('event: '))?.slice(7), data: JSON.parse(lines.find((line) => line.startsWith('data: '))?.slice(6) ?? '{}') };
  });
  const thinking = events.find((entry) => entry.event === 'content_block_start' && entry.data.content_block?.type === 'thinking');
  assert.ok(thinking, 'reasoning arrives as a thinking content block, not as answer text');
  const delta = events.find((entry) => entry.event === 'content_block_delta' && entry.data.delta?.type === 'thinking_delta');
  assert.equal(delta.data.delta.thinking, 'Thinking.');
  const thinkingIndex = thinking.data.index;
  assert.ok(events.some((entry) => entry.event === 'content_block_stop' && entry.data.index === thinkingIndex), 'the thinking block is closed');
  const answer = events.find((entry) => entry.event === 'content_block_delta' && entry.data.delta?.type === 'text_delta');
  assert.equal(answer.data.delta.text, 'po', 'the answer text is still a separate text block');
});
