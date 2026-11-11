import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';

/**
 * The two new web-cookie routes, end to end through the HTTP layer.
 *
 * The provider fetch is mocked; the gateway is real. That is the split that matters
 * here: the route must parse the body, pass the paste to the adapter, refuse to save
 * a rejected cookie, and save an accepted one. No live subscription is touched.
 */

async function start(t, handler) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://grok.com/') || url.startsWith('https://www.perplexity.ai/')) return handler(url, init);
    return realFetch(input, init);
  };
  const apiKeys = new InMemoryApiKeyStore();
  await apiKeys.setEnforced(false);
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), apiKeys);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    globalThis.fetch = realFetch;
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, service };
}

const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('a refused Grok cookie is a 401 and nothing is saved', async (t) => {
  const { base, service } = await start(t, async () => new Response('{}', { status: 401 }));
  const response = await post(base, '/v1/web-cookie/grok/connect', { cookieHeader: 'sso=expired' });
  assert.equal(response.status, 401);
  assert.equal((await service.listConnections()).length, 0);
});

test('an accepted Grok cookie is stored as a grok-web connection', async (t) => {
  const { base, service } = await start(t, async () => new Response('{}', { status: 400 }));
  const response = await post(base, '/v1/web-cookie/grok/connect', { cookieHeader: 'sso=live' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.connection.providerId, 'grok-web');
  assert.equal(body.connection.endpoint, 'https://grok.com');
  assert.equal((await service.listConnections()).length, 1);
});

test('a Perplexity check is side-effect free, and a 200 proves the route', async (t) => {
  const { base, service } = await start(t, async () => new Response('{}', { status: 200 }));
  const response = await post(base, '/v1/web-cookie/perplexity/check', { cookieHeader: '__Secure-next-auth.session-token=live' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { verified: true });
  assert.equal((await service.listConnections()).length, 0);
});

test('a Perplexity session is stored after the check accepts it', async (t) => {
  const { base, service } = await start(t, async () => new Response('{}', { status: 200 }));
  const response = await post(base, '/v1/web-cookie/perplexity/connect', { cookieHeader: '__Secure-next-auth.session-token=live' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.connection.providerId, 'perplexity-web');
  assert.equal(body.connection.endpoint, 'https://www.perplexity.ai');
  assert.equal((await service.listConnections()).length, 1);
});
