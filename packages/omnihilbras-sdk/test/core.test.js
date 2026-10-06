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
  assert.equal(JSON.stringify({ ...detailedError }).includes(secret), false);
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
  assert.throws(() => normalizeProviderBaseUrl('https://10.0.0.1/v1', 'acme'), (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR');
  assert.throws(() => resolveProviderUrl('https://provider.test/v1', '../outside', 'acme'), (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR');
  assert.throws(() => resolveProviderUrl('http://remote.example/v1', 'models', 'acme'), (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR');
  assert.equal(resolveProviderUrl('https://provider.test/v1', 'models', 'acme'), 'https://provider.test/v1/models');
  assert.throws(() => sanitizeProviderHeaders({ authorization: 'Bearer secret' }, 'acme'), (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR');
  assert.throws(() => sanitizeProviderHeaders({ 'x-test': 'safe\r\nInjected' }, 'acme'), (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR');
});

test('FetchHttpTransport caps response and stream sizes', async () => {
  const responseTransport = new FetchHttpTransport({
    maxResponseBytes: 4,
    fetch: async () => new Response('123456', { status: 200, headers: { 'content-type': 'text/plain' } }),
  });
  await assert.rejects(responseTransport.request({ method: 'GET', url: 'https://provider.test/large' }), (error) => error instanceof ProviderError && error.code === 'INVALID_RESPONSE');

  const streamTransport = new FetchHttpTransport({
    maxStreamBytes: 4,
    fetch: async () => new Response('123456', { status: 200, headers: { 'content-type': 'text/plain' } }),
  });
  await assert.rejects(async () => {
    for await (const _chunk of streamTransport.stream({ method: 'GET', url: 'https://provider.test/stream' })) {
      // consume the stream
    }
  }, (error) => error instanceof ProviderError && error.code === 'INVALID_RESPONSE');

  await assert.rejects(async () => {
    for await (const _event of parseSseStream((async function* () { yield `data: ${'x'.repeat(20)}\n\n`; })(), { maxEventBytes: 8 })) {
      // consume the stream
    }
  }, (error) => error instanceof ProviderError && error.code === 'INVALID_RESPONSE');
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

  const streamDurationTransport = new FetchHttpTransport({
    maxStreamDurationMs: 5,
    fetch: async (_input, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  });
  await assert.rejects(async () => {
    for await (const _chunk of streamDurationTransport.stream({ method: 'GET', url: 'https://provider.test/stream' })) {
      // consume the stream
    }
  }, (error) => error instanceof ProviderError && error.code === 'PROVIDER_TIMEOUT');
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


/**
 * `tolerateRefusalBody` — an OAuth token exchange whose refusal *is* the answer.
 *
 * Kimi's poll answers `400 {"error":"authorization_pending"}` while the user has not approved yet. The
 * transport throws on any non-2xx before a caller can read that, so the sign-in reported a failure for a
 * request that was merely waiting.
 *
 * Both directions are asserted, and the second matters more than the first: the flag is a sharp tool, and
 * its value is that the default path is unchanged. A guard that only proved the flag *works* would leave
 * the property that matters unproven — that it is hard to use by accident.
 */
test('a 4xx throws by default, with the provider\'s wording attached', async () => {
  const transport = new FetchHttpTransport({
    fetch: async () => new Response(JSON.stringify({ error: { message: 'Invalid Authentication' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(
    () => transport.request({ method: 'GET', providerId: 'acme', url: 'https://api.acme.test/v1/models' }),
    (error) => error.code === 'AUTHENTICATION_FAILED',
    'a refusal must still be a failure when nobody opted out',
  );
});

test('tolerateRefusalBody returns the 4xx body instead of throwing, for a token exchange', async () => {
  const transport = new FetchHttpTransport({
    fetch: async () => new Response(JSON.stringify({ error: 'authorization_pending', error_description: 'Authorization is pending' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const response = await transport.request({
    method: 'POST',
    providerId: 'acme',
    url: 'https://auth.acme.test/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=device_code',
    tolerateRefusalBody: true,
  });
  assert.equal(response.status, 400);
  assert.equal(response.data.error, 'authorization_pending');
  assert.equal(response.data.error_description, 'Authorization is pending', 'the body must survive intact, not be re-read');
});

test('a non-JSON refusal body is still returned rather than throwing', async () => {
  // An HTML error page from a proxy in front of the token endpoint. What matters is that the caller sees
  // the **status** rather than a transport error claiming the provider is unreachable — which is what
  // happens if the body parse throws here. The body itself comes back as text, since `parseResponse` is
  // content-type driven and a `text/html` body is not a parse failure.
  const transport = new FetchHttpTransport({
    fetch: async () => new Response('<html>gateway timeout</html>', {
      status: 504,
      headers: { 'content-type': 'text/html' },
    }),
  });
  const response = await transport.request({
    method: 'POST',
    providerId: 'acme',
    url: 'https://auth.acme.test/oauth/token',
    tolerateRefusalBody: true,
  });
  assert.equal(response.status, 504, 'the status is the part the caller branches on');
  assert.equal(response.data, '<html>gateway timeout</html>');
  // And the same body without the flag still throws, which is the property that keeps the flag sharp.
  const strict = new FetchHttpTransport({
    fetch: async () => new Response('<html>gateway timeout</html>', {
      status: 504,
      headers: { 'content-type': 'text/html' },
    }),
  });
  await assert.rejects(
    () => strict.request({ method: 'GET', providerId: 'acme', url: 'https://api.acme.test/v1/models' }),
    (error) => error.code === 'PROVIDER_TIMEOUT' || error.code === 'PROVIDER_UNAVAILABLE',
  );
});
