import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry, InMemorySecretStore } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

/**
 * The Kilo Code, MiniMax Code, and Qoder sign-in flows, through the gateway.
 *
 * They share the device-flow shape but differ in the wire details the adapter owns:
 *
 * - **Kilo Code** answers `202`/`403`/`410` for pending/denied/expired rather than RFC 8628 error codes.
 * - **MiniMax Code** answers its own `{status}` envelope on HTTP 200 and may omit `device_code`.
 * - **Qoder** polls with a nonce and verifier, and its token lands only after `/deviceToken/poll` says so.
 *
 * The properties guarded here are the ones a wire-detail change would quietly break.
 */

function scriptTransport(script) {
  const calls = [];
  const transport = {
    calls,
    async request(request) {
      calls.push(request);
      const answer = script(request);
      return { status: answer?.status ?? 200, headers: new Headers(), data: answer?.data ?? {} };
    },
    async *stream() {},
  };
  return transport;
}

async function buildService(script) {
  const transport = scriptTransport(script);
  const apiKeys = new InMemoryApiKeyStore();
  const { key } = await apiKeys.create('test');
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), apiKeys, { transport });
  return { service, transport, key };
}

function startFlow(base, providerId, key) {
  return fetch(`${base}/v1/oauth/${providerId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: '{}',
  });
}

function poll(base, providerId, sessionId, key) {
  return fetch(`${base}/v1/oauth/${providerId}/session/${sessionId}`, { headers: { authorization: `Bearer ${key}` } });
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

/* ------------------------------------------------------------------ *
 * Kilo Code
 * ------------------------------------------------------------------ */

test('Kilo Code: start shows the user_code and polls with `code`', async () => {
  // Measured against live api.kilo.ai on a fresh grant: `GET …/codes/<code>` returns 202 pending, while
  // `<device_code>` and `<user_code>` both return 410 expired. So the poll key is `code`, and the
  // user-facing code is `user_code`. This drives the poll and asserts both halves, so a future change
  // cannot silently swap them.
  let polledPath;
  const { service, key } = await buildService((request) => {
    if (request.url.endsWith('/device-auth/codes')) {
      return { data: { code: 'POLL-CODE', user_code: '7Y55-A9QJ', device_code: 'DEVICE-CODE-1', verificationUrl: 'https://app.kilo.ai/device-auth?code=7Y55-A9QJ', expiresIn: 300 } };
    }
    if (request.url.includes('/device-auth/codes/')) {
      polledPath = request.url;
      return { status: 202, data: {} };
    }
    return { data: {} };
  });
  await withServer(service, async (base) => {
    const response = await startFlow(base, 'kilocode', key);
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.match(body.sessionId, /^[A-Za-z0-9_-]{16,128}$/);
    assert.equal(body.userCode, '7Y55-A9QJ', 'the readable user_code is shown');
    assert.equal(body.verificationUrl, 'https://app.kilo.ai/device-auth?code=7Y55-A9QJ');
    await poll(base, 'kilocode', body.sessionId, key);
    assert.ok(polledPath.includes('POLL-CODE'), `poll used ${polledPath}, expected the \`code\` value`);
    assert.equal(polledPath.includes('DEVICE-CODE-1'), false, 'the poll must not use device_code');
  });
});

test('Kilo Code: 202 on the poll is pending, not a failure', async () => {
  const { service, key } = await buildService((request) => {
    if (request.url.endsWith('/device-auth/codes')) return { data: { code: 'POLL-1', user_code: 'K1', device_code: 'DEV-1', verificationUrl: 'https://kilocode.ai/device' } };
    if (request.url.includes('/device-auth/codes/POLL-1')) return { status: 202, data: {} };
    return { data: {} };
  });
  await withServer(service, async (base) => {
    const start = await (await startFlow(base, 'kilocode', key)).json();
    const status = await (await poll(base, 'kilocode', start.sessionId, key)).json();
    assert.equal(status.status, 'pending');
  });
});

test('Kilo Code: 403 on the poll reports a denial, not a success', async () => {
  const { service, key } = await buildService((request) => {
    if (request.url.endsWith('/device-auth/codes')) return { data: { code: 'POLL-1', user_code: 'K1', device_code: 'DEV-1', verificationUrl: 'https://kilocode.ai/device' } };
    if (request.url.includes('/device-auth/codes/POLL-1')) return { status: 403, data: {} };
    return { data: {} };
  });
  await withServer(service, async (base) => {
    const start = await (await startFlow(base, 'kilocode', key)).json();
    const status = await (await poll(base, 'kilocode', start.sessionId, key)).json();
    assert.equal(status.status, 'failed');
    assert.match(status.error, /denied/i);
  });
});

/* ------------------------------------------------------------------ *
 * MiniMax Code (both regions)
 * ------------------------------------------------------------------ */

for (const providerId of ['minimax-code', 'minimax-code-global']) {
  test(`MiniMax Code (${providerId}): start returns a code and a verification URL`, async () => {
    const { service, key } = await buildService((request) => {
      if (request.url.includes('/oauth2/device/code')) {
        return { data: { user_code: 'MM-1234', device_code: 'mm-dev', verification_uri: 'https://account.minimax.io/user/code', expires_in: 600 } };
      }
      return { data: {} };
    });
    await withServer(service, async (base) => {
      const response = await startFlow(base, providerId, key);
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.userCode, 'MM-1234');
      assert.equal(body.verificationUrl, 'https://account.minimax.io/user/code');
    });
  });

  test(`MiniMax Code (${providerId}): the poll sends device_code (not user_code) and reads the {status} envelope`, async () => {
    // Measured live: POST /oauth2/token with `user_code` is refused `invalid_request: device_code and
    // code_verifier are required`. So the poll must carry `device_code`, and this asserts it does.
    let tokenBody = '';
    const { service, key } = await buildService((request) => {
      if (request.url.includes('/oauth2/device/code')) return { data: { user_code: 'MM-1', device_code: 'mm-dev', verification_uri: 'https://account.minimax.io/user/code' } };
      if (request.url.includes('/oauth2/token')) {
        tokenBody = request.body ?? '';
        return { data: { status: 'pending' } };
      }
      return { data: {} };
    });
    await withServer(service, async (base) => {
      const start = await (await startFlow(base, providerId, key)).json();
      const status = await (await poll(base, providerId, start.sessionId, key)).json();
      assert.equal(status.status, 'pending');
      const fields = new URLSearchParams(tokenBody);
      assert.equal(fields.get('device_code'), 'mm-dev', 'the poll must carry device_code');
      assert.equal(fields.has('user_code'), false, 'and must not swap in user_code');
      assert.ok(fields.get('code_verifier'), 'and must carry the PKCE verifier');
    });
  });

  test(`MiniMax Code (${providerId}): a denied {status} envelope fails with a reason`, async () => {
    const { service, key } = await buildService((request) => {
      if (request.url.includes('/oauth2/device/code')) return { data: { user_code: 'MM-1', device_code: 'mm-dev', verification_uri: 'https://account.minimax.io/user/code' } };
      if (request.url.includes('/oauth2/token')) return { data: { status: 'denied' } };
      return { data: {} };
    });
    await withServer(service, async (base) => {
      const start = await (await startFlow(base, providerId, key)).json();
      const status = await (await poll(base, providerId, start.sessionId, key)).json();
      assert.equal(status.status, 'failed');
      assert.match(status.error, /denied/i);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Qoder
 * ------------------------------------------------------------------ */

test('Qoder: start returns a nonce-derived user code and a verification URL', async () => {
  const { service, key } = await buildService(() => ({ data: {} }));
  await withServer(service, async (base) => {
    const response = await startFlow(base, 'qoder', key);
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.match(body.sessionId, /^[A-Za-z0-9_-]{16,128}$/);
    assert.match(body.verificationUrl, /^https:\/\/qoder\.com\/device\/selectAccounts\?/);
    assert.match(body.verificationUrl, /challenge_method=S256/);
    assert.ok(body.userCode);
  });
});

test('Qoder: 202 on the poll is pending, not a failure', async () => {
  const { service, key } = await buildService((request) => {
    if (request.url.includes('/deviceToken/poll')) return { status: 202, data: {} };
    return { data: {} };
  });
  await withServer(service, async (base) => {
    const start = await (await startFlow(base, 'qoder', key)).json();
    const status = await (await poll(base, 'qoder', start.sessionId, key)).json();
    assert.equal(status.status, 'pending');
  });
});

test('Qoder: a token on the poll connects and saves nothing until the model save', async () => {
  const connectionStore = new InMemoryConnectionStore();
  const transport = scriptTransport((request) => {
    if (request.url.includes('/deviceToken/poll')) return { data: { token: 'qoder-access', refresh_token: 'qoder-ref', user_id: 'u-1', expires_at: Date.now() + 30 * 24 * 3600 * 1000 } };
    if (request.url.includes('/userinfo')) return { data: { name: 'Qoder User', email: 'q@example.com' } };
    // Model discovery that saving a connection performs.
    if (request.url.includes('/model/list')) return { data: { data: [{ key: 'auto' }, { key: 'ultimate' }] } };
    return { data: {} };
  });
  const apiKeys = new InMemoryApiKeyStore();
  const { key } = await apiKeys.create('test');
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), connectionStore, apiKeys, { transport });
  await withServer(service, async (base) => {
    const start = await (await startFlow(base, 'qoder', key)).json();
    const status = await (await poll(base, 'qoder', start.sessionId, key)).json();
    assert.equal(status.status, 'connected');
    const saved = (await connectionStore.list()).find((c) => c.providerId === 'qoder');
    assert.ok(saved, 'the connection is saved');
  });
});
