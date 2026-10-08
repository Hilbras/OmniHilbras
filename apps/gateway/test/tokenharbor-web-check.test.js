import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryConnectionStore, createGatewayServer, createProviderRegistry, loadGatewayConfig } from '../dist/index.js';
import { TokenHarborWebAdapter } from '../../../packages/omnihilbras-sdk/dist/index.js';

/**
 * Token Harbor Web at the gateway boundary, without a network.
 *
 * What is testable offline is everything that decides *whether a connection is made at all*: a
 * paste that carries no session cookie, and the route being served rather than 404-ing. The turn
 * itself needs a real session and is verified by using it — the adapter's own wire handling is
 * asserted with a scripted `fetch` in the SDK suite (`tokenharbor-web.test.js`).
 *
 * Note this provider's terms prohibit proxying its web chat, which is why the catalog card
 * carries a `high` risk notice. These tests are about the mechanism, not about the trade.
 */

const secrets = new Map();
const secretStore = {
  get: async (connectionId, providerId) => secrets.get(`${connectionId}:${providerId}`),
  set: async (connectionId, providerId, credential) => {
    secrets.set(`${connectionId}:${providerId}`, credential);
  },
};

function service() {
  return new GatewayService(createProviderRegistry(loadGatewayConfig({})), secretStore, new InMemoryConnectionStore());
}

test('a paste with no session cookie is refused by name, before any request', async () => {
  // A Cookie header for the wrong site is the most likely bad paste, and "unauthorized" would send
  // the user looking for a problem that is not there. The cookie is read first, so this never
  // reaches the network.
  await assert.rejects(
    () => service().checkTokenHarborWeb('some_other_cookie=abc123'),
    (error) => {
      assert.equal(error.name, 'ProviderError');
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.match(error.publicMessage ?? error.message, /sb-auth-auth-token/);
      return true;
    },
  );
});

test('a refused check stores nothing', async () => {
  // A check that half-connects is worse than no check: the user believes the credential is good
  // and finds out on their first request.
  try {
    await service().checkTokenHarborWeb('some_other_cookie=abc123');
  } catch {
    // The point is what is left behind, not why it failed.
  }
  assert.equal((await service().listConnections()).length, 0);
});

test('a refused connect stores nothing either', async () => {
  try {
    await service().connectTokenHarborWeb('not-a-cookie');
  } catch {
    // as above
  }
  assert.equal((await service().listConnections()).length, 0);
});

test('the connect route is served, not 404', async () => {
  // The route's existence is what `tests/gateway-routes.test.js` pins to the spec, but that reads
  // source. This asks the running server, so a route that is registered in the wrong file — or
  // behind the wrong prefix — is caught rather than assumed.
  const gateway = service();
  const server = createGatewayServer(gateway, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    for (const path of ['/v1/web-cookie/tokenharbor/check', '/v1/web-cookie/tokenharbor/connect']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: JSON.stringify({ cookieHeader: 'some_other_cookie=abc123' }),
      });
      assert.notEqual(response.status, 404, `${path} is not served`);
      const body = await response.json();
      // A bad paste, named — not a missing route and not a generic failure.
      assert.equal(body.error?.code, 'INVALID_REQUEST', `${path} answered ${JSON.stringify(body)}`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the adapter answers a health check, so the dashboard can test it', () => {
  // Without a healthCheck the health loop reports "Health checks are not supported." and "Test
  // provider" fails on a connection that can answer.
  const adapter = new TokenHarborWebAdapter();
  assert.equal(adapter.id, 'tokenharbor-web');
  assert.equal(typeof adapter.healthCheck, 'function');
});

test('health is a credential check and costs one round trip', async () => {
  const calls = [];
  const adapter = new TokenHarborWebAdapter({
    fetch: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await adapter.healthCheck({ credential: { type: 'api-key', value: 'sb-auth-auth-token=x' } });
  assert.equal(result.status, 'healthy');
  assert.equal(result.verified, 'credential');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/me\/profile/);
});