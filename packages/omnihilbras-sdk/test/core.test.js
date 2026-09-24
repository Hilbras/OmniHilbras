import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FetchHttpTransport,
  ProviderError,
  ProviderRegistry,
  parseSseJson,
  parseSseStream,
  normalizeProviderBaseUrl,
  resolveProviderUrl,
  sanitizeProviderHeaders,
} from '../dist/index.js';

test('FetchHttpTransport parses JSON responses', async () => {
  const transport = new FetchHttpTransport({
    fetch: async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  const response = await transport.request({ method: 'GET', url: 'https://provider.test/health' });

  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { ok: true });
});

test('FetchHttpTransport normalizes provider HTTP errors', async () => {
  const transport = new FetchHttpTransport({
    fetch: async () => new Response(JSON.stringify({ error: { message: 'Invalid key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    transport.request({ method: 'GET', url: 'https://provider.test/models' }),
    (error) => error instanceof ProviderError && error.code === 'AUTHENTICATION_FAILED' && error.statusCode === 401,
  );
});

test('provider errors and serialized errors do not disclose response secrets', async () => {
  const secret = 'sk-super-secret-value';
  const transport = new FetchHttpTransport({
    fetch: async () => new Response(JSON.stringify({ error: { message: `Invalid API key: ${secret}` } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    transport.request({ method: 'GET', url: 'https://provider.test/models', providerId: 'acme' }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.providerId, 'acme');
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );

  const detailedError = new ProviderError('PROVIDER_REQUEST_FAILED', 'Safe message', { details: { secret } });
  assert.equal(JSON.stringify(detailedError).includes(secret), false);
});

test('FetchHttpTransport refuses redirects and validates provider URLs', async () => {
  let requestInit;
  const transport = new FetchHttpTransport({
    fetch: async (_input, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await transport.request({ method: 'GET', url: 'https://provider.test/health' });
  assert.equal(requestInit.redirect, 'error');
  assert.throws(() => normalizeProviderBaseUrl('http://remote.example/v1', 'acme'), (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR');
  assert.throws(() => resolveProviderUrl('https://provider.test/v1', '../outside', 'acme'), (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR');
  assert.equal(resolveProviderUrl('https://provider.test/v1', 'models', 'acme'), 'https://provider.test/v1/models');
  assert.throws(() => sanitizeProviderHeaders({ authorization: 'Bearer secret' }, 'acme'), (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR');
  assert.throws(() => sanitizeProviderHeaders({ 'x-test': 'safe\r\nInjected' }, 'acme'), (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR');
});

test('FetchHttpTransport exposes streamed text and maps timeouts', async () => {
  const streamTransport = new FetchHttpTransport({
    fetch: async () => new Response('data: {"value":1}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  });
  const events = [];
  for await (const event of parseSseStream(streamTransport.stream({ method: 'GET', url: 'https://provider.test/stream' }))) {
    events.push(event);
  }
  assert.deepEqual(events.map((event) => event.data), ['{"value":1}', '[DONE]']);
  assert.deepEqual(parseSseJson(events[0]), { value: 1 });

  const timeoutTransport = new FetchHttpTransport({
    timeoutMs: 5,
    fetch: async (_input, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  });

  await assert.rejects(
    timeoutTransport.request({ method: 'GET', url: 'https://provider.test/slow' }),
    (error) => error instanceof ProviderError && error.code === 'PROVIDER_TIMEOUT',
  );
});

test('ProviderRegistry resolves capabilities without provider-specific logic', () => {
  const registry = new ProviderRegistry();
  const adapter = {
    id: 'test-provider',
    name: 'Test provider',
    capabilities: { chat: true, streaming: false },
    chat: async () => ({ id: 'response', providerId: 'test-provider', model: 'test-model', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }),
  };

  registry.register(adapter);

  assert.equal(registry.get('test-provider'), adapter);
  assert.equal(registry.supports('test-provider', 'chat'), true);
  assert.equal(registry.supports('test-provider', 'streaming'), false);
  registry.register({ id: 'search-provider', name: 'Search provider', capabilities: { search: true } });
  assert.equal(registry.supports('search-provider', 'search'), true);
  assert.throws(() => registry.register(adapter), (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR');
  assert.throws(() => registry.require('missing'), (error) => error instanceof ProviderError && error.code === 'NOT_FOUND');
});
