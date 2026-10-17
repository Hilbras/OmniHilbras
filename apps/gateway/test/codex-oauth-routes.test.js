import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX, InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';
import { GatewayService, InMemoryConnectionStore, createGatewayServer, CodexSessionStore, beginCodexSignIn, completeCodexSignIn, resolveCodexConfig } from '../dist/index.js';

const callbackPath = '/v1/oauth/codex/callback';
const redirectUri = `http://127.0.0.1:8787${callbackPath}`;
const publicBaseUrl = 'http://127.0.0.1:8787';

function createService(codex = { clientId: 'id', redirectUri }, transport = successfulTransport()) {
  return new GatewayService(
    new ProviderRegistry(),
    new InMemorySecretStore({}),
    new InMemoryConnectionStore(),
    undefined,
    { config: { codex }, transport },
  );
}

function successfulTransport() {
  const calls = [];
  return {
    calls,
    async request(input) {
      calls.push(input);
      return { data: { access_token: 'access-secret', refresh_token: 'refresh-secret', id_token: 'id-secret', expires_in: 3600 } };
    },
    stream() {
      throw new Error('not used');
    },
  };
}

async function startServer(t, service, options = {}) {
  const server = createGatewayServer(service, { publicBaseUrl, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function startCodexSignIn(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/oauth/codex/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 201);
  const started = await response.json();
  started.state = new URL(started.verificationUrl).searchParams.get('state');
  assert.ok(started.state);
  return started;
}

function crossSite() {
  return { headers: { 'sec-fetch-site': 'cross-site' } };
}

function signInStatus(baseUrl, sessionId) {
  return fetch(`${baseUrl}/v1/oauth/codex/session/${sessionId}`);
}

/** A free loopback port, so the registered-port listener can be exercised without colliding. */
async function freePort() {
  const { createServer } = await import('node:http');
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('with no local configuration a sign-in starts on the public Codex client and its registered redirect', async (t) => {
  // The setup wall this removes: previously both variables had to be set before anything worked, and
  // the failure surfaced as an internal error. This is the path a fresh install takes.
  // `publicBaseUrl` carries port 1455 so no fixed port is bound here — the listener itself is
  // exercised separately on a free port, which keeps this suite runnable on any machine.
  const baseUrl = await startServer(t, createService({}, successfulTransport()), { publicBaseUrl: `http://127.0.0.1:${CODEX.publicRedirectPort}` });
  const response = await fetch(`${baseUrl}/v1/oauth/codex/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 201);
  const started = await response.json();
  const authorize = new URL(started.verificationUrl);
  assert.equal(authorize.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(authorize.searchParams.get('redirect_uri'), CODEX.publicRedirectUri);
  assert.equal((await (await signInStatus(baseUrl, started.sessionId)).json()).status, 'pending');
});

test('the registered-port listener answers one callback and then releases the port', async (t) => {
  const { CodexCallbackListener } = await import('../dist/index.js');
  const port = await freePort();
  const seen = [];
  const listener = new CodexCallbackListener(async (pathname, params) => { seen.push([pathname, params.get('state')]); return { ok: true, message: 'Connected to Codex.' }; });
  await listener.open(port, '127.0.0.1');
  t.after(() => listener.close());

  const response = await fetch(`http://127.0.0.1:${port}/auth/callback?code=one-time&state=the-state`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /Connected to Codex/);
  assert.doesNotMatch(page, /one-time|the-state/, 'the page renders the outcome and nothing else');
  assert.deepEqual(seen, [['/auth/callback', 'the-state']]);

  // Closed after serving, so the fixed registered port is not held for the gateway's lifetime.
  await assert.rejects(fetch(`http://127.0.0.1:${port}/auth/callback?state=second`));
});

test('a busy registered port is reported, never silently ignored', async (t) => {
  const { CodexCallbackListener } = await import('../dist/index.js');
  const port = await freePort();
  const holder = new CodexCallbackListener(async () => ({ ok: true, message: 'x' }));
  await holder.open(port, '127.0.0.1');
  t.after(() => holder.close());
  const second = new CodexCallbackListener(async () => ({ ok: true, message: 'x' }));
  // Silently continuing would send the browser to a URL nobody is serving and fail with no explanation.
  await assert.rejects(second.open(port, '127.0.0.1'));
});

test('a half-configured Codex sign-in is refused by name, not as an internal fault', async (t) => {
  // The reported symptom was "the gateway encountered an unexpected error", because a configuration
  // refusal was thrown as a plain Error and the envelope replaced it with a generic sentence. The
  // operator-gated route may now say which setting decides this — it names the variable, never its
  // value, and the transport secrets stay out of the response either way.
  for (const [label, config, expected] of [
    ['missing client id', { redirectUri }, /CLIENT_ID/],
    ['missing redirect URI', { clientId: 'id' }, /REDIRECT_URI/],
  ]) {
    const baseUrl = await startServer(t, createService(config));
    const response = await fetch(`${baseUrl}/v1/oauth/codex/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 500, label);
    const body = await response.text();
    assert.doesNotMatch(body, /access-secret|refresh-secret|id-secret/, label);
    assert.match(body, expected, `${label} names the setting to change`);
  }
});

test('an overridden redirect that cannot work is still refused by name', async (t) => {
  for (const [label, config, expected] of [
    ['malformed redirect URI', { clientId: 'id', redirectUri: 'not a URL' }, /valid absolute URL/],
    ['redirect origin mismatch', { clientId: 'id', redirectUri: 'http://localhost:8787/v1/oauth/codex/callback' }, /origin must match/],
    ['unsafe redirect scheme', { clientId: 'id', redirectUri: 'https://127.0.0.1:8787/v1/oauth/codex/callback' }, /HTTP on a loopback host/],
  ]) {
    const baseUrl = await startServer(t, createService(config));
    const response = await fetch(`${baseUrl}/v1/oauth/codex/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 500, label);
    const body = await response.text();
    assert.doesNotMatch(body, /access-secret|refresh-secret|id-secret/, label);
    assert.match(body, expected, `${label} explains itself`);
  }
});

test('the exchange presents the client the sign-in started with, not whatever config says now', async () => {
  // The bug this pins: authorize fell back to the public client while the exchange read
  // `config.codex.clientId`, which is unset with no local configuration, so it posted an empty
  // string and OpenAI refused with "Invalid 'client_id': empty string".
  // Driven through the session store directly rather than over HTTP, so it exercises the pairing
  // without binding the real registered port.
  const transport = successfulTransport();
  const store = new CodexSessionStore();
  const redirect = resolveCodexConfig({ publicBaseUrl });
  const started = beginCodexSignIn({ store, ...redirect });
  const state = new URL(started.verificationUrl).searchParams.get('state');
  assert.equal(new URL(started.verificationUrl).searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');

  const status = await completeCodexSignIn({
    store,
    sessionId: started.sessionId,
    code: 'authorization-code',
    state,
    transport,
    saveConnection: async () => ({ name: 'Codex' }),
  });
  assert.equal(status.status, 'connected');
  const sent = new URLSearchParams(transport.calls[0].body);
  assert.equal(sent.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(sent.get('redirect_uri'), CODEX.publicRedirectUri);
});

test('Codex callback without a valid matching state never exchanges the code', async (t) => {
  const transport = successfulTransport();
  const baseUrl = await startServer(t, createService(undefined, transport));
  const started = await startCodexSignIn(baseUrl);

  for (const state of ['', 'not-the-state']) {
    const query = new URLSearchParams({ code: 'authorization-code' });
    if (state) query.set('state', state);
    const response = await fetch(`${baseUrl}${callbackPath}?${query}`, crossSite());
    assert.equal(response.status, 200);
    assert.match(await response.text(), /did not identify a Codex sign-in/i);
    assert.equal(transport.calls.length, 0);
  }
  assert.equal((await (await signInStatus(baseUrl, started.sessionId)).json()).status, 'pending');
});

test('the callback state selects its own session and exchanges only that session', async (t) => {
  const transport = successfulTransport();
  const service = createService(undefined, transport);
  const baseUrl = await startServer(t, service);
  const first = await startCodexSignIn(baseUrl);
  const second = await startCodexSignIn(baseUrl);

  const response = await fetch(`${baseUrl}${callbackPath}?code=authorization-code&state=${encodeURIComponent(second.state)}`, crossSite());
  assert.match(await response.text(), /Connected to Codex/);
  // The token exchange, then the model catalog the saved connection is built from.
  assert.equal(transport.calls.filter((call) => call.url === 'https://auth.openai.com/oauth/token').length, 1);
  const exchange = transport.calls.find((call) => call.url === 'https://auth.openai.com/oauth/token');
  assert.equal(new URLSearchParams(exchange.body).get('code'), 'authorization-code');
  assert.equal(new URLSearchParams(exchange.body).get('redirect_uri'), redirectUri);
  assert.equal((await (await signInStatus(baseUrl, first.sessionId)).json()).status, 'pending');
  assert.equal((await (await signInStatus(baseUrl, second.sessionId)).json()).status, 'connected');
});

test('a provider error fails only its matching Codex session without exchanging', async (t) => {
  const transport = successfulTransport();
  const baseUrl = await startServer(t, createService(undefined, transport));
  const first = await startCodexSignIn(baseUrl);
  const second = await startCodexSignIn(baseUrl);

  const response = await fetch(`${baseUrl}${callbackPath}?error=access_denied&state=${encodeURIComponent(first.state)}`, crossSite());
  const html = await response.text();
  assert.match(html, /sign-in was not approved/i);
  assert.equal(html.includes('access_denied'), false);
  assert.equal((await (await signInStatus(baseUrl, first.sessionId)).json()).status, 'failed');
  assert.equal((await (await signInStatus(baseUrl, second.sessionId)).json()).status, 'pending');
  assert.equal(transport.calls.length, 0);
});

test('replaying a Codex callback exchanges once and never exposes OAuth secrets', async (t) => {
  const transport = successfulTransport();
  const baseUrl = await startServer(t, createService(undefined, transport));
  const started = await startCodexSignIn(baseUrl);
  const url = `${baseUrl}${callbackPath}?code=authorization-code&state=${encodeURIComponent(started.state)}`;
  const first = await fetch(url, crossSite());
  assert.match(await first.text(), /Connected to Codex/);
  const replay = await fetch(url, crossSite());
  assert.match(await replay.text(), /did not identify a Codex sign-in/i);
  // Exactly one exchange however many times the callback is replayed. The catalog read is counted
  // separately because a replay must not spend a second one either.
  assert.equal(transport.calls.filter((call) => call.url === 'https://auth.openai.com/oauth/token').length, 1);

  const statusResponse = await signInStatus(baseUrl, started.sessionId);
  const statusText = await statusResponse.text();
  assert.equal(statusResponse.status, 200);
  assert.equal(JSON.parse(statusText).status, 'connected');
  for (const secret of ['access-secret', 'refresh-secret', 'id-secret', 'authorization-code']) {
    assert.equal(statusText.includes(secret), false, `status does not include ${secret}`);
  }
  assert.equal(JSON.stringify(await (await fetch(url, crossSite())).text()).includes('refresh-secret'), false);
});

test('startup rejects a redirect URI that differs from the listener origin', async () => {
  const { startGatewayServer } = await import('../dist/index.js');
  await assert.rejects(() => startGatewayServer({
    config: {
      host: '127.0.0.1', port: 8787, timeoutMs: 1000, healthIntervalMs: 0, failureThreshold: 1,
      recoveryCooldownMs: 1000, corsOrigins: [], dataDir: '/tmp/omnihilbras-codex-test',
      codex: { clientId: 'id', redirectUri: 'http://localhost:8787/v1/oauth/codex/callback' },
      openai: { baseUrl: 'https://api.openai.com/v1' }, anthropic: { baseUrl: 'https://api.anthropic.com' },
      compatible: { id: 'openai-compatible', baseUrl: 'https://example.com/v1' },
    },
    env: {},
    connectionStore: new InMemoryConnectionStore(),
  }), /origin must match/);
});

test('the canonical Codex callback serves a safe failure when OAuth is unconfigured', async (t) => {
  const transport = successfulTransport();
  const baseUrl = await startServer(t, createService(undefined, transport), { dashboardToken: 'dashboard-secret' });
  const response = await fetch(`${baseUrl}${callbackPath}?code=authorization-code&state=unknown`, crossSite());
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /did not identify a Codex sign-in/i);
  assert.doesNotMatch(html, /authorization-code|unknown/);
  assert.equal(transport.calls.length, 0);
});

test('only the exact Codex callback path and GET method are exempt', async (t) => {
  const transport = successfulTransport();
  const service = createService(undefined, transport);
  const baseUrl = await startServer(t, service, { dashboardToken: 'dashboard-secret' });
  const accepted = await fetch(`${baseUrl}${callbackPath}?code=x&state=unknown`, crossSite());
  assert.equal(accepted.status, 200);

  for (const path of [`${callbackPath}/extra`, '/v1/oauth/codex/callback-other']) {
    const response = await fetch(`${baseUrl}${path}?code=x&state=unknown`, crossSite());
    assert.equal(response.status, 403, path);
  }
  const post = await fetch(`${baseUrl}${callbackPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({}),
  });
  assert.equal(post.status, 403);
  assert.equal(transport.calls.length, 0);
});

test('only a valid configured callback redirect is accepted at startup', async (t) => {
  const { startGatewayServer } = await import('../dist/index.js');
  for (const redirect of [
    'not-a-url',
    'https://127.0.0.1:8787/v1/oauth/codex/callback',
    'http://127.0.0.1:8787/v1/oauth/codex/session/forged',
  ]) {
    await assert.rejects(() => startGatewayServer({
      config: {
        host: '127.0.0.1', port: 8787, timeoutMs: 1000, healthIntervalMs: 0, failureThreshold: 1,
        recoveryCooldownMs: 1000, corsOrigins: [], dataDir: '/tmp/omnihilbras-codex-test',
        codex: { clientId: 'id', redirectUri: redirect },
        openai: { baseUrl: 'https://api.openai.com/v1' }, anthropic: { baseUrl: 'https://api.anthropic.com' },
        compatible: { id: 'openai-compatible', baseUrl: 'https://example.com/v1' },
      },
      env: {},
      connectionStore: new InMemoryConnectionStore(),
    }));
  }
});