import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

/**
 * A sign-in saves to the row it was started for.
 *
 * ZCode was the one flow whose start route dropped `connectionId`, so reconnecting an account saved a second
 * one beside it — the same duplicate the dashboard's Reconnect button produced by calling the Add-account path
 * instead of the repair path. Both halves are pinned here: the route parses the target, and the poll saves to
 * it rather than deciding an id for itself.
 *
 * The OAuth server is the only thing stubbed: the flow's own endpoints go through global `fetch`, and the
 * adapter's model list is static, so nothing else in the save needs a network.
 */

const started = {
  code: 0,
  data: { flow_id: 'flow-1', poll_token: 'poll-token', authorize_url: 'https://zcode.example/authorize', expires_at: Date.now() + 600_000, poll_interval_sec: 1 },
};
const ready = { code: 0, data: { status: 'ready', token: 'zcodejwttoken-from-the-sign-in', user: { user_id: 'uuid-1' } } };

function stubOauthServer(t, gatewayBase) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    // The test's own calls to the gateway go through untouched; only the sign-in endpoints are the flow's.
    if (target.startsWith(gatewayBase)) return realFetch(url, init);
    if (target.includes('/oauth/cli/init')) return new Response(JSON.stringify(started), { status: 200, headers: { 'content-type': 'application/json' } });
    if (target.includes('/oauth/cli/poll/')) return new Response(JSON.stringify(ready), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`the test stubs the sign-in endpoints only, and something asked for ${target}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
}

async function gateway(t) {
  const store = new InMemoryConnectionStore();
  const apiKeys = new InMemoryApiKeyStore();
  const { key } = await apiKeys.create('test');
  const service = new GatewayService(new ProviderRegistry(), store, store, apiKeys, {});
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173', publicBaseUrl: 'http://127.0.0.1:20138' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, key, store };
}

const post = (base, key, path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', origin: 'http://localhost:5173' },
  body: JSON.stringify(body),
});

test('a ZCode sign-in started for a row replaces that row instead of adding an account', async (t) => {
  const { base, key, store } = await gateway(t);
  stubOauthServer(t, base);
  // The account the row shows, saved before the reconnect — the one a repair has to keep.
  await store.save(
    { id: 'zcode-work', providerId: 'zcode', name: 'Work', endpoint: 'https://zcode.z.ai', priority: 1, proxyPool: 'none' },
    { type: 'api-key', value: 'the-old-token' },
  );

  const start = await post(base, key, '/v1/oauth/zcode/start', { provider: 'zai', connectionId: 'zcode-work' });
  assert.equal(start.status, 200, await start.clone().text());
  const flow = await start.json();

  const poll = await fetch(`${base}/v1/oauth/zcode/session/${encodeURIComponent(flow.flowId)}`, { headers: { authorization: `Bearer ${key}`, origin: 'http://localhost:5173' } });
  const body = await poll.json();
  assert.equal(body.status, 'ready', JSON.stringify(body).slice(0, 200));
  assert.equal(body.connection.id, 'zcode-work', 'the sign-in saved beside the row instead of replacing it');
  assert.deepEqual((await store.list()).map((connection) => connection.id), ['zcode-work'], 'a second account appeared');
  assert.deepEqual(await store.get('zcode-work'), { type: 'api-key', value: 'zcodejwttoken-from-the-sign-in' }, 'the row keeps the credential the sign-in produced');
});

test('without a target the same flow still adds a second account, so the repair path is what changed', async (t) => {
  const { base, key, store } = await gateway(t);
  stubOauthServer(t, base);
  await store.save(
    { id: 'zcode', providerId: 'zcode', name: 'First', endpoint: 'https://zcode.z.ai', priority: 1, proxyPool: 'none' },
    { type: 'api-key', value: 'the-first-token' },
  );

  const start = await post(base, key, '/v1/oauth/zcode/start', { provider: 'zai', addAccount: true });
  const flow = await start.json();
  const poll = await fetch(`${base}/v1/oauth/zcode/session/${encodeURIComponent(flow.flowId)}`, { headers: { authorization: `Bearer ${key}`, origin: 'http://localhost:5173' } });
  const body = await poll.json();

  assert.equal(body.status, 'ready', JSON.stringify(body).slice(0, 200));
  const ids = (await store.list()).map((connection) => connection.id).sort();
  assert.equal(ids.length, 2, `the add-account path must still add, got ${ids.join(', ')}`);
  assert.ok(ids.includes('zcode'), 'the first account is gone');
  assert.ok(ids.some((id) => /^zcode-[0-9a-f]{12}$/.test(id)), `no second-account id was minted: ${ids.join(', ')}`);
});
