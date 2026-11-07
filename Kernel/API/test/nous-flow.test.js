import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry, InMemorySecretStore } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

/**
 * The Nous Research sign-in, through the gateway.
 *
 * The card takes an **API key or a portal sign-in**, and this is the second path end to end. What is
 * worth guarding is invisible from outside: the device code must not appear in the view the dashboard
 * polls, the agent key must be what gets stored (the inference host does not accept the access token's
 * role, it accepts the agent key), a mint failure must not discard a working sign-in, and a session id
 * must be shape-checked before it reaches the store.
 */

/** A transport that answers the portal from a script, so no network is touched. */
function scriptTransport(script) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      // The portal's sign-in endpoints are read as **form** bodies; a JSON request would be refused here
      // exactly as the portal refuses one, which is what makes the encoding assertion meaningful.
      const fields = request.headers?.['content-type'] === 'application/x-www-form-urlencoded'
        ? Object.fromEntries(new URLSearchParams(request.body ?? ''))
        : undefined;
      const answer = script(request, fields);
      return { status: answer.status ?? 200, headers: new Headers(), data: answer.data ?? answer };
    },
    async *stream() { throw new Error('not used'); },
  };
}

const DEVICE = { device_code: 'dev-1', user_code: 'NOUS-1234', verification_uri: 'https://portal.nousresearch.com/device', expires_in: 900 };
const TOKEN = { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 };
const AGENT_KEY = { api_key: 'sk-agent-1', key_id: 'key_1', expires_at: '2030-01-01T00:00:00Z' };

/**
 * A sign-in script that mints a **distinct** credential per grant, as the portal does.
 *
 * The shared fixture returned one agent key for every sign-in, and once the duplicate rule existed that
 * made the second add-account sign-in a *renewal* of the first — correctly, since identical credentials
 * are one account — so the add-account test saw one row and read as a broken flow.
 */
function completedSignIn() {
  let mints = 0;
  return (request) => {
    if (request.url.endsWith('/api/oauth/device/code')) return { data: DEVICE };
    if (request.url.endsWith('/api/oauth/agent-key')) {
      mints += 1;
      return { data: { ...AGENT_KEY, api_key: `sk-agent-${mints}` } };
    }
    if (request.url.endsWith('/api/oauth/token')) {
      const fields = Object.fromEntries(new URLSearchParams(request.body ?? ''));
      if (fields.grant_type === 'refresh_token') return { data: { ...TOKEN, access_token: 'at-refreshed' } };
      return { data: { ...TOKEN, access_token: `at-${mints + 1}`, refresh_token: `rt-${mints + 1}` } };
    }
    if (request.url.includes('/models')) return { data: { data: [{ id: 'nous/one' }, { id: 'nous/two' }] } };
    return { data: {} };
  };
}

async function buildService(script, options = {}) {
  const transport = scriptTransport(script);
  const apiKeys = new InMemoryApiKeyStore();
  const { key } = await apiKeys.create('test');
  const service = new GatewayService(
    new ProviderRegistry(),
    new InMemorySecretStore({}),
    options.connectionStore ?? new InMemoryConnectionStore(),
    apiKeys,
    { transport },
  );
  return { service, transport, key };
}

function startFlow(base, key, body = {}) {
  return fetch(`${base}/v1/oauth/nous/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

async function withServer(service, run) {
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST /v1/oauth/nous/start returns a session, a code and a verification URL', async () => {
  const { service, transport, key } = await buildService(completedSignIn());
  await withServer(service, async (base) => {
    const response = await startFlow(base, key);
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.userCode, 'NOUS-1234');
    assert.equal(body.verificationUrl, 'https://portal.nousresearch.com/device');
    assert.ok(body.sessionId);

    const deviceCall = transport.calls.find((call) => call.url.endsWith('/api/oauth/device/code'));
    assert.equal(deviceCall.headers['content-type'], 'application/x-www-form-urlencoded', 'the portal reads a form body');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(deviceCall.body)), {
      client_id: 'hermes-cli',
      scope: 'inference:invoke inference:mint_agent_key',
    });
  });
});

test('the session view never carries the device code', async () => {
  const { service, key } = await buildService((request) => {
    if (request.url.endsWith('/api/oauth/device/code')) return { data: DEVICE };
    return { status: 400, data: { error: 'authorization_pending' } };
  });
  await withServer(service, async (base) => {
    const started = await (await startFlow(base, key)).json();
    const status = await (await fetch(`${base}/v1/oauth/nous/session/${started.sessionId}`, { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(status.status, 'pending');
    assert.equal('deviceCode' in status, false, 'the view the dashboard polls must not carry the device code');
    assert.equal(JSON.stringify(status).includes('dev-1'), false);
  });
});

test('an approved sign-in saves the connection with the agent key', async () => {
  const connectionStore = new InMemoryConnectionStore();
  const { service, key } = await buildService(completedSignIn(), { connectionStore });
  await withServer(service, async (base) => {
    const started = await (await startFlow(base, key)).json();
    const status = await (await fetch(`${base}/v1/oauth/nous/session/${started.sessionId}`, { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(status.status, 'connected');

    const saved = (await connectionStore.list()).find((connection) => connection.providerId === 'nous');
    assert.ok(saved, 'the sign-in is stored, not only reported');
    assert.equal(saved.endpoint, 'https://inference-api.nousresearch.com/v1');
    const credential = await connectionStore.get(saved.id);
    assert.equal(credential.value, 'sk-agent-1', 'the inference host accepts the agent key');
    assert.equal(credential.refreshToken, 'rt-1', 'and the portal refresh token is kept for renewal');
  });
});

test('an add-account sign-in reserves its own connection id and keeps the first', async () => {
  const connectionStore = new InMemoryConnectionStore();
  const { service, key } = await buildService(completedSignIn(), { connectionStore });
  await withServer(service, async (base) => {
    const poll = async (sessionId) => (await fetch(`${base}/v1/oauth/nous/session/${sessionId}`, { headers: { authorization: `Bearer ${key}` } })).json();
    const first = await (await startFlow(base, key)).json();
    await poll(first.sessionId);
    const second = await (await startFlow(base, key, { addAccount: true })).json();
    await poll(second.sessionId);

    const rows = (await connectionStore.list()).filter((connection) => connection.providerId === 'nous');
    assert.equal(rows.length, 2, `expected both accounts saved, found: ${rows.map((row) => row.id).join(', ')}`);
    assert.notEqual(rows[0].id, rows[1].id);
  });
});

test('a refused grant reports the portal’s own wording and saves nothing', async () => {
  const connectionStore = new InMemoryConnectionStore();
  const { service, key } = await buildService((request) => {
    if (request.url.endsWith('/api/oauth/device/code')) return { data: DEVICE };
    return { status: 400, data: { error: 'access_denied', error_description: 'The user refused the request.' } };
  }, { connectionStore });
  await withServer(service, async (base) => {
    const started = await (await startFlow(base, key)).json();
    const status = await (await fetch(`${base}/v1/oauth/nous/session/${started.sessionId}`, { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(status.status, 'failed');
    assert.match(status.error, /refused the request/);
    assert.equal((await connectionStore.list()).length, 0, 'nothing is written for a refused grant');
  });
});

test('a mint that fails still saves the connection, with the access token as the bearer', async () => {
  const connectionStore = new InMemoryConnectionStore();
  const answer = completedSignIn();
  const { service, key } = await buildService((request) => {
    if (request.url.endsWith('/api/oauth/agent-key')) return { status: 500, data: {} };
    return answer(request);
  }, { connectionStore });
  await withServer(service, async (base) => {
    const started = await (await startFlow(base, key)).json();
    const status = await (await fetch(`${base}/v1/oauth/nous/session/${started.sessionId}`, { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(status.status, 'connected');
    const saved = (await connectionStore.list()).find((connection) => connection.providerId === 'nous');
    const credential = await connectionStore.get(saved.id);
    assert.equal(credential.value, 'at-1', 'a convenience token failing must not discard a working sign-in');
  });
});

test('an unknown session is 404, and a malformed one is refused before any lookup', async () => {
  const { service, key } = await buildService(completedSignIn());
  await withServer(service, async (base) => {
    const headers = { authorization: `Bearer ${key}` };
    const unknown = await fetch(`${base}/v1/oauth/nous/session/${'a'.repeat(24)}`, { headers });
    assert.equal(unknown.status, 404);
    for (const crafted of ['../../keys', 'short', 'has spaces', '%2e%2e%2fkeys']) {
      const response = await fetch(`${base}/v1/oauth/nous/session/${encodeURIComponent(crafted)}`, { headers });
      assert.equal(response.status, 400, `${crafted} must be refused as a shape, not looked up`);
    }
  });
});

test('the start route is behind the management gate', async () => {
  const { service } = await buildService(completedSignIn());
  await withServer(service, async (base) => {
    const response = await fetch(`${base}/v1/oauth/nous/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401, 'a sign-in asks Nous for a grant, so it is not free to start');
  });
});