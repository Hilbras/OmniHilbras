import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderError, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore, createGatewayServer } from '../dist/src/index.js';

/**
 * One id per request, visible to the client, the usage record and the error envelope.
 *
 * The gateway has generated this id since the usage store was written — it rides on the context every adapter
 * receives, on every usage record, and on every error envelope — but it never reached the **client**, so the one
 * thing that could join "my request failed" to a row in `/v1/usage` was invisible to the person holding the failure.
 * `service.startScope`'s own comment said the HTTP layer "needs to hand the id to the client"; nothing did.
 */

const request = () => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

function adapter({ fail = false } = {}) {
  return {
    id: 'fake',
    name: 'Fake',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'm', providerId: 'fake' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
    async chat(_request) {
      if (fail) throw new ProviderError('RATE_LIMITED', 'Slow down.', { providerId: 'fake', publicMessage: 'Slow down.' });
      return { id: 'r', providerId: 'fake', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
    },
  };
}

async function start(t, { fail = false } = {}) {
  const connections = new InMemoryConnectionStore();
  await connections.save(
    { id: 'c', providerId: 'fake', name: 'c', endpoint: 'http://127.0.0.1:1/v1', priority: 1, proxyPool: 'none', enabled: true, modelPolicy: 'all', modelIds: ['m'], resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: 'sk-test' },
  );
  const usageStore = new InMemoryUsageStore();
  const apiKeys = new InMemoryApiKeyStore();
  // Enforcement off so the test exercises the request id rather than the auth gate; the gate is covered elsewhere.
  await apiKeys.setEnforced(false);
  const service = new GatewayService(
    new ProviderRegistry().register(adapter({ fail })),
    new InMemorySecretStore({ fake: { type: 'api-key', value: 'sk-test' } }),
    connections,
    apiKeys,
    { usageStore },
  );
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, usageStore };
}

const ID_SHAPE = /^[0-9a-f]{32}$/;

test('a successful response carries the id that its usage record was written with', async (t) => {
  const { base, usageStore } = await start(t);
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request()),
  });
  assert.equal(response.status, 200);
  const id = response.headers.get('x-request-id');
  assert.match(String(id), ID_SHAPE, 'the client has no request id to quote');

  const records = await usageStore.list({ limit: 5 });
  assert.equal(records.length, 1);
  assert.equal(records[0].requestId, id, 'the id on the response is not the id on the usage record');
});

test('a failed request carries the same id in the header and in the error envelope', async (t) => {
  const { base } = await start(t, { fail: true });
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request()),
  });
  assert.ok(response.status >= 400);
  const header = response.headers.get('x-request-id');
  assert.match(String(header), ID_SHAPE);
  const body = await response.json();
  assert.equal(body.error.requestId, header, 'the envelope and the header disagree about which request this was');
});

test('the id is readable by a browser on another origin, not just by curl', async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/v1/models`, { headers: { origin: 'http://localhost:5173' } });
  const exposed = response.headers.get('access-control-expose-headers') ?? '';
  // A CORS response decides which headers a script may read; without `x-request-id` listed, a browser gets the header
  // on the wire and `null` from `headers.get`.
  assert.match(exposed, /x-request-id/, 'a browser cannot read the request id it was sent');
});

test('two requests get two ids', async (t) => {
  const { base } = await start(t);
  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request()),
    });
    ids.push(response.headers.get('x-request-id'));
  }
  assert.notEqual(ids[0], ids[1], 'two requests shared one id, so the id cannot join a failure to a record');
});
