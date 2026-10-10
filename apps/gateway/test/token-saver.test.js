import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';
import { GatewayService, createGatewayServer } from '../dist/index.js';

// A long tool result is resent on every turn of an agent loop. The gateway shortens it before the provider sees it,
// unless the client opts out for one request with `x-omnihilbras-token-saver: off`. A failure trace is never shortened.

let lastRequest;

function recordingAdapter(seen) {
  return {
    id: 'fake',
    name: 'Fake provider',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'fake-1', providerId: 'fake', displayName: 'Fake One' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString() }; },
    async chat(request) {
      seen.push(request.messages);
      lastRequest = request;
      return { id: 'r', providerId: 'fake', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  };
}

async function start(t, seen) {
  const service = new GatewayService(new ProviderRegistry().register(recordingAdapter(seen)), new InMemorySecretStore({ fake: { type: 'api-key', value: 'secret' } }));
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const longGrep = Array.from({ length: 2000 }, (_, index) => (index % 400 === 0 ? `src/file-${index}.ts:${index + 1}: match` : `    context ${index + 1} without a match`)).join('\n');

function body(toolContent, isError) {
  return {
    model: 'fake-1',
    messages: [
      { role: 'user', content: 'search' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: toolContent, ...(isError ? { is_error: true } : {}) },
    ],
  };
}

async function post(base, payload, headers = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-omnihilbras-provider': 'fake', ...headers },
    body: JSON.stringify(payload),
  });
}

test('a long tool result is shortened before the provider sees it, by default', async (t) => {
  const seen = [];
  const base = await start(t, seen);
  const response = await post(base, body(longGrep));
  assert.equal(response.status, 200);
  const toolMessage = seen[0].find((message) => message.role === 'tool');
  assert.ok(toolMessage.content.length < longGrep.length, 'the provider receives the shortened result');
  assert.match(toolMessage.content, /lines omitted/);
});

test('the opt-out header sends the full tool result, unchanged', async (t) => {
  const seen = [];
  const base = await start(t, seen);
  const response = await post(base, body(longGrep), { 'x-omnihilbras-token-saver': 'off' });
  assert.equal(response.status, 200);
  const toolMessage = seen[0].find((message) => message.role === 'tool');
  assert.equal(toolMessage.content, longGrep, 'the client asked for the full output');
});

test('a failed tool result is sent whole, even by default', async (t) => {
  const seen = [];
  const base = await start(t, seen);
  const response = await post(base, body(longGrep, true));
  assert.equal(response.status, 200);
  const toolMessage = seen[0].find((message) => message.role === 'tool');
  assert.equal(toolMessage.content, longGrep, 'an error trace is never shortened');
  assert.equal(toolMessage.isError, true);
});

test('the savings log reports a byte count for the request and never prints tool content', async (t) => {
  const seen = [];
  const base = await start(t, seen);
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  t.after(() => { console.log = original; });
  const marker = 'UNIQUE-TOOL-OUTPUT-MARKER';
  const content = `${marker}\n${longGrep}`;
  const response = await post(base, body(content));
  assert.equal(response.status, 200);
  const saver = lines.filter((line) => line.startsWith('[token-saver]'));
  assert.equal(saver.length, 1, 'one line per compressed request');
  assert.match(saver[0], /saved \d+ bytes of tool output/);
  assert.equal(lines.some((line) => line.includes(marker)), false, 'no tool content reaches the log');
});

test('a tool_choice from the client reaches the provider, and an unknown choice is refused with 400', async (t) => {
  const seen = [];
  const base = await start(t, seen);
  const ok = await post(base, { ...body(longGrep.slice(0, 40)), tool_choice: 'none' });
  assert.equal(ok.status, 200);
  assert.equal(lastRequest.toolChoice, 'none', 'the adapter receives the client\'s choice');
  const bad = await post(base, { ...body(longGrep.slice(0, 40)), tool_choice: 'sometimes' });
  assert.equal(bad.status, 400, 'a choice the gateway does not know is refused, not forwarded');
});
