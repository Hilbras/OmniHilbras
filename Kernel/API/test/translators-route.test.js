import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryApiKeyStore, InMemoryConnectionStore, GatewayService, createGatewayServer } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';

async function gateway() {
  const store = new InMemoryConnectionStore();
  const keys = new InMemoryApiKeyStore();
  const key = (await keys.create('translators')).key;
  const service = new GatewayService(new ProviderRegistry(), store, store, keys, {});
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, key,
    close: () => new Promise((resolve) => server.close(resolve)),
    call: (path, init = {}) => fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
    }),
  };
}

test('GET /v1/translators lists the exact registered pairs and nothing else', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  const res = await gw.call('/v1/translators');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    object: 'list',
    data: [{ source: 'messages-api', target: 'openai-chat' }],
  });
  // The registry rows carry a `translate` function and the format handlers carry request bodies.
  // Neither belongs on an inventory route, and no credential field can appear either.
  const text = JSON.stringify(body);
  for (const forbidden of ['translate', 'credential', 'apiKey', 'api_key', 'token', 'body']) {
    assert.ok(!text.includes(forbidden), `the translator inventory leaked ${forbidden}`);
  }
});

test('the translator inventory is read-only and refusal is not a silent empty list', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  const post = await gw.call('/v1/translators', { method: 'POST', body: '{}' });
  assert.notEqual(post.status, 200, 'a write must not be reported as a successful inventory read');
  const missing = await gw.call('/v1/translators/extra');
  assert.equal(missing.status, 404, 'an unregistered sub-path must not answer with the inventory');
});

test('the translator inventory requires a gateway key when management enforcement is on', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  const res = await fetch(`${gw.base}/v1/translators`);
  assert.equal(res.status, 401);
});
