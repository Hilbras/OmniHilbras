import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '@omnihilbras/sdk';
import { createGatewayServer } from '../dist/index.js';
import { GatewayService } from '../dist/index.js';

function createService(onChat) {
  const adapter = {
    id: 'fake',
    name: 'Fake provider',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() {
      return [{ id: 'fake-1', providerId: 'fake', displayName: 'Fake One' }];
    },
    async healthCheck() {
      return { status: 'healthy', checkedAt: new Date().toISOString() };
    },
    async chat(request) {
      onChat?.(request);
      return { id: 'response-1', providerId: 'fake', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'Hello from gateway' }, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
    },
    async *streamChat(request) {
      yield { id: 'chunk-1', providerId: 'fake', model: request.model, delta: { role: 'assistant', content: 'Hello' } };
      yield { id: 'chunk-2', providerId: 'fake', model: request.model, delta: { content: ' world' }, finishReason: 'stop' };
    },
  };
  return new GatewayService(new ProviderRegistry().register(adapter), new InMemorySecretStore({ fake: { type: 'api-key', value: 'secret' } }));
}

async function startServer(t, service = createService()) {
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('local gateway exposes health, models, chat, and streaming', async (t) => {
  const baseUrl = await startServer(t);

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const models = await fetch(`${baseUrl}/v1/models`);
  assert.deepEqual((await models.json()).data, [{ id: 'fake-1', object: 'model', owned_by: 'fake', display_name: 'Fake One' }]);

  const chat = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-omnihilbras-provider': 'fake' },
    body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'Hello' }] }),
  });
  assert.equal(chat.status, 200);
  const chatBody = await chat.json();
  assert.equal(chatBody.object, 'chat.completion');
  assert.equal(chatBody.choices[0].message.content, 'Hello from gateway');

  const stream = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-omnihilbras-provider': 'fake' },
    body: JSON.stringify({ model: 'fake-1', stream: true, messages: [{ role: 'user', content: 'Hello' }] }),
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
  const streamBody = await stream.text();
  assert.match(streamBody, /Hello/);
  assert.match(streamBody, /data: \[DONE\]/);
});

test('local gateway restricts browser origins to the configured allowlist', async (t) => {
  const baseUrl = await startServer(t);
  const allowed = await fetch(`${baseUrl}/health`, { headers: { origin: 'http://localhost:5173' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');

  const denied = await fetch(`${baseUrl}/health`, { headers: { origin: 'https://evil.example' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await denied.json(), { error: { code: 'CORS_ORIGIN_DENIED', message: 'This browser origin is not allowed.' } });
});

test('local gateway strictly validates fields and preserves assistant tool calls', async (t) => {
  const baseUrl = await startServer(t);
  const invalidPayloads = [
    { model: 'fake-1', stream: 'true', messages: [{ role: 'user', content: 'Hi' }] },
    { model: 'fake-1', temperature: 3, messages: [{ role: 'user', content: 'Hi' }] },
    { model: 'fake-1', messages: [{ role: 'tool', content: 'result' }] },
    { model: 'fake-1', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'javascript:alert(1)' } }] }] },
  ];
  for (const payload of invalidPayloads) {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
  }

  let received;
  const toolServer = await startServer(t, createService((request) => { received = request; }));
  const response = await fetch(`${toolServer}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-omnihilbras-provider': 'fake' },
    body: JSON.stringify({
      model: 'fake-1',
      messages: [
        { role: 'user', content: 'Use a tool' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'result' },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received.messages[1].toolCalls[0].function, { name: 'lookup', arguments: '{"q":"x"}' });
  assert.equal(received.messages[2].toolCallId, 'call-1');

  const missingProvider = await fetch(`${toolServer}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-omnihilbras-provider': 'missing' },
    body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'Hi' }] }),
  });
  assert.equal(missingProvider.status, 404);
  assert.equal((await missingProvider.json()).error.provider, 'missing');
});

test('local gateway returns structured validation errors', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: 'INVALID_REQUEST', message: 'model is required.' } });
});
