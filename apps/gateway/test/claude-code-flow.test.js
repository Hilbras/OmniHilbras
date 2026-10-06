import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry, InMemorySecretStore } from '@hilbras/omnihilbras';
import { GatewayService, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';

/**
 * The Claude Code sign-in flow, through the gateway.
 *
 * The properties worth guarding are the ones whose failure is invisible from outside:
 *
 * - the **PKCE verifier never leaves the gateway**. It is the value that proves the exchange, and the
 *   session view is what a browser polls with, so a verifier in it is a secret in a URL and a log line.
 * - the session id rides in the **redirect path**, so a callback can be tied to its verifier even when
 *   the provider does not echo `state`. Without it, a callback that carried no state had no way to say
 *   which sign-in it belonged to.
 * - the **raw query** is handed over rather than the parsed `code`, because Claude repeats the code
 *   after a `#` and both halves are needed.
 * - the session id is shape-checked before it reaches the store.
 */

/** A transport that answers the token exchange and the catalog from a script, so no network is touched. */
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

/**
 * Answers a completed sign-in: the token exchange and the model discovery that saving a connection runs.
 *
 * The model call is the one that is easy to miss. A successful sign-in imports the provider's models
 * before it stores the connection, so a script that only answers the exchange gets
 * `Claude model list is missing data.` — which is the gateway working correctly and the script incomplete.
 */
function completedSignIn(request) {
  if (request.url.includes('/v1/models')) return { data: { data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-1' }] } };
  return { data: { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 } };
}

async function buildService(script) {
  const transport = scriptTransport(script);
  const connectionStore = new InMemoryConnectionStore();
  // No API-key store, exactly as `oauth-routes.test.js` builds it. The management gate calls
  // `authorizePublicRequest`, which returns early when there is no store — so the flows below are
  // reached without a key, and this test is about the sign-in rather than about key enforcement.
  const service = new GatewayService(
    new ProviderRegistry(),
    new InMemorySecretStore({}),
    connectionStore,
    undefined,
    { transport },
  );
  return { service, transport, connectionStore };
}

function headers() {
  return { 'content-type': 'application/json' };
}

async function withServer(service, run) {
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173', publicBaseUrl: 'http://127.0.0.1:8787' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Starts a sign-in the way the dashboard does. */
async function startSignIn(base) {
  return (await fetch(`${base}/v1/oauth/claude-code/start`, { method: 'POST', headers: headers(), body: '{}' })).json();
}

/** Opens the callback a browser would open. `sec-fetch-site: cross-site` matches a top-level navigation. */
function callback(base, sessionId, query) {
  return fetch(`${base}/v1/oauth/claude-code/callback/${sessionId}?${query}`, { headers: { 'sec-fetch-site': 'cross-site' } });
}

/** The public session view, which the dashboard polls. */
function session(base, sessionId) {
  return fetch(`${base}/v1/oauth/claude-code/session/${sessionId}`).then((response) => response.json());
}

test('POST /v1/oauth/claude-code/start returns a session and an authorize URL carrying PKCE', async () => {
  const { service } = await buildService(completedSignIn);
  await withServer(service, async (base) => {
    const response = await fetch(`${base}/v1/oauth/claude-code/start`, { method: 'POST', headers: headers(), body: '{}' });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.match(body.sessionId, /^[A-Za-z0-9_-]{16,128}$/);

    const url = new URL(body.verificationUrl);
    assert.equal(url.origin + url.pathname, 'https://claude.ai/oauth/authorize');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code'), 'true');
    // The session id is in the redirect path, which is what ties a callback to its verifier.
    assert.equal(url.searchParams.get('redirect_uri'), `http://127.0.0.1:8787/v1/oauth/claude-code/callback/${body.sessionId}`);
  });
});

test('the session view never carries the PKCE verifier', async () => {
  // The view is what a browser polls with, so a verifier in it is a secret travelling through a URL.
  const { service } = await buildService(completedSignIn);
  await withServer(service, async (base) => {
    const start = await startSignIn(base);
    const status = await session(base, start.sessionId);
    assert.equal(status.status, 'pending');
    assert.equal('codeVerifier' in status, false);
    assert.equal(JSON.stringify(status).toLowerCase().includes('verifier'), false);
  });
});

test('a well-formed id that does not exist is 404, and an implausible one is refused before lookup', async () => {
  const { service } = await buildService(completedSignIn);
  await withServer(service, async (base) => {
    const missing = await fetch(`${base}/v1/oauth/claude-code/session/${'a'.repeat(20)}`);
    assert.equal(missing.status, 404);

    const bad = await fetch(`${base}/v1/oauth/claude-code/session/short`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'INVALID_REQUEST');
  });
});
test('a browser callback finishes the sign-in with nothing to paste, and the code is never shown back', async () => {
  const { service } = await buildService(completedSignIn);
  await withServer(service, async (base) => {
    const start = await startSignIn(base);
    const page = await callback(base, start.sessionId, 'code=granted');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Claude Code/);
    assert.equal(html.includes('granted'), false, 'the code is never shown back to the browser');

    const status = await session(base, start.sessionId);
    assert.equal(status.status, 'connected');
    assert.equal(status.connection.name, 'Claude Code');
    assert.deepEqual(status.connection.modelIds, ['claude-sonnet-4-5', 'claude-opus-4-1']);
    assert.equal(JSON.stringify(status).toLowerCase().includes('token'), false, 'the status carries no credential');
  });
});

test('the exchange sends the verifier minted at the start, and `code#state` survives the split', async () => {
  // Claude repeats the code after a `#`, so the route reassembles `code#state` and
  // `splitCallbackFragment` separates the halves. A route that passed `url.search` whole would hand the
  // exchange `code=granted` — the parameter *name* becomes part of the code, which Claude refuses with
  // `invalid_grant` for a code that was right.
  const { service, transport } = await buildService(completedSignIn);
  await withServer(service, async (base) => {
    const start = await startSignIn(base);
    // The state echoed back is the one the authorize URL carried, which is what the gateway checks.
    const state = new URL(start.verificationUrl).searchParams.get('state');
    await callback(base, start.sessionId, `code=the-code%23${encodeURIComponent(state)}`);

    const exchange = transport.calls.find((call) => call.url.includes('/v1/oauth/token'));
    const body = JSON.parse(exchange.body);
    assert.equal(body.code, 'the-code', 'the code is the half before the #, not the query parameter');
    assert.equal(body.state, state, 'and the echoed state is the other half');
    assert.equal(typeof body.code_verifier, 'string');
    assert.ok(body.code_verifier.length >= 43, 'the verifier is a real RFC 7636 value, not a placeholder');
    assert.equal(body.redirect_uri, `http://127.0.0.1:8787/v1/oauth/claude-code/callback/${start.sessionId}`);
  });
});

test('a callback carrying a crossed state is refused rather than exchanged', async () => {
  const { service, transport } = await buildService(completedSignIn);
  await withServer(service, async (base) => {
    const start = await startSignIn(base);
    await callback(base, start.sessionId, 'code=the-code%23a-different-state');

    assert.equal(transport.calls.some((call) => call.url.includes('/v1/oauth/token')), false, 'a crossed state must not spend the code');
    const status = await session(base, start.sessionId);
    assert.equal(status.status, 'failed');
    assert.match(status.error, /different sign-in/);
  });
});

test('a refused exchange reports Claude\'s own wording and saves nothing', async () => {
  const { service, connectionStore } = await buildService((request) =>
    request.url.includes('/v1/oauth/token')
      ? { status: 400, data: { error: 'invalid_grant', error_description: 'code_verifier does not match' } }
      : completedSignIn(request));

  await withServer(service, async (base) => {
    const start = await startSignIn(base);
    await callback(base, start.sessionId, 'code=the-code');

    const status = await session(base, start.sessionId);
    assert.equal(status.status, 'failed');
    assert.match(status.error, /code_verifier does not match/, 'the provider said why, and the user is told why');
    assert.deepEqual(await connectionStore.list(), [], 'a failed exchange saves nothing');
  });
});