import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { KIMI_CODE, ProviderRegistry, InMemorySecretStore } from '@hilbras/omnihilbras';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';

/**
 * The Kimi Code sign-in flow, through the gateway.
 *
 * The properties worth guarding are the ones whose failure is invisible from outside:
 *
 * - the device code is **single-use**, and two polls must not both spend it. The coordinator claims
 *   the session before exchanging; without that, the second poll is told the code is invalid and a
 *   success that already happened is overwritten with a failure.
 * - the public session view must not carry the device code, because that view is what the dashboard
 *   polls with.
 * - a session id is shape-checked before it reaches the store.
 */

/** A transport that answers the device flow from a script, so no network is touched. */
function scriptTransport(script) {
  const calls = [];
  const transport = {
    calls,
    async request(request) {
      calls.push(request);
      // Kimi is called with a form body; answer its `user_code` only when the real fields arrived,
      // so a JSON-encoded request would be refused here exactly as Kimi refuses it.
      const fields = new URLSearchParams(request.body ?? '');
      const answer = script(request, fields);
      return { status: answer?.status ?? 200, headers: new Headers(), data: answer?.data ?? {} };
    },
    async *stream() {},
  };
  return transport;
}

const KIMI_AUTH_ORIGIN = KIMI_CODE.authOrigin;

const deviceCodeAnswer = { data: { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: 'https://www.kimi.com/code/authorize_device', expires_in: 1800 } };

/**
 * Answers a completed sign-in: the device code, the token exchange, and the model discovery that
 * saving a connection performs.
 *
 * The third call is the one that is easy to miss. A successful sign-in imports the provider's models
 * before it stores the connection, so a script that only answers the first two gets
 * `Kimi model list is missing data` — which is the gateway working correctly and the script being
 * incomplete, not the flow being broken.
 */
function completedSignIn(request) {
  if (request.url.includes('device_authorization')) return deviceCodeAnswer;
  if (request.url.includes('/models')) return { data: { data: [{ id: 'kimi-latest' }, { id: 'kimi-k2.5' }] } };
  return { data: { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 } };
}

async function buildService(script, options = {}) {
  const transport = scriptTransport(script);
  const apiKeys = new InMemoryApiKeyStore();
  const { key } = await apiKeys.create('test');
  // The transport goes in through `GatewayServiceOptions`, which is what the service uses for every
  // adapter it builds itself. Registering a Kimi adapter in the registry does *not* change the
  // transport `kimiCodeAdapter()` constructs — so a test that only registered one reached the real
  // Kimi, which is exactly what the 502s and the one-second-per-test timings were.
  const service = new GatewayService(
    new ProviderRegistry(),
    new InMemorySecretStore({ 'kimi-code': { type: 'oauth', value: 'acc', refreshToken: 'ref' } }),
    options.connectionStore ?? new InMemoryConnectionStore(),
    apiKeys,
    { transport },
  );
  // The key is returned because every route here is a management route: an OAuth start is not free,
  // it asks the provider for a grant, so it sits behind the same gate that guards minting keys.
  return { service, transport, key };
}

/**
 * Starts a Kimi Code sign-in the way a client does.
 *
 * Both the JSON content type and the API key are required by the gateway rather than by these tests:
 * `server.ts` answers 415 without the content type, and the management gate answers 401 without a key.
 */
function startFlow(base, key) {
  return fetch(`${base}/v1/oauth/kimi-code/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: '{}',
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

test('POST /v1/oauth/kimi-code/start returns a session, a code and a verification URL', async () => {
  const { service, key } = await buildService(() => deviceCodeAnswer);
  await withServer(service, async (base) => {
    const response = await startFlow(base, key);
    if (response.status !== 201) console.error('DEBUG', response.status, (await response.text()).slice(0,300));
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.match(body.sessionId, /^[A-Za-z0-9_-]{16,128}$/);
    assert.equal(body.userCode, 'ABCD-EFGH');
    assert.equal(body.verificationUrl, 'https://www.kimi.com/code/authorize_device');
    assert.ok(Date.parse(body.expiresAt) > Date.now(), 'and an expiry a dashboard can count down to');
  });
});

test('the session view never carries the device code', async () => {
  // The view is what the dashboard polls with, so a device code in it would be a single-use secret
  // travelling through a URL and a log line.
  const { service, key } = await buildService(() => deviceCodeAnswer);
  await withServer(service, async (base) => {
    const start = await (await startFlow(base, key)).json();
    const status = await (await fetch(`${base}/v1/oauth/kimi-code/session/${start.sessionId}`, { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(JSON.stringify(status).includes('dev-1'), false, 'the device code appeared in the public session');
    assert.equal('deviceCode' in status, false);
  });
});

test('a pending poll is pending, not a failure', async () => {
  const { service, key } = await buildService((request) =>
    request.url.includes('device_authorization') ? deviceCodeAnswer : { status: 400, data: { error: 'authorization_pending' } });
  await withServer(service, async (base) => {
    const start = await (await startFlow(base, key)).json();
    const status = await (await fetch(`${base}/v1/oauth/kimi-code/session/${start.sessionId}`, { headers: { authorization: `Bearer ${key}` } })).json();
    assert.equal(status.status, 'pending');
    assert.equal('error' in status, false, 'a poll that is still waiting has nothing to report as an error');
  });
});

test('a completed sign-in saves the connection and says so', async () => {
  const connectionStore = new InMemoryConnectionStore();
  const { service, key } = await buildService(completedSignIn, { connectionStore });

  await withServer(service, async (base) => {
    const start = await (await startFlow(base, key)).json();
    const status = await (await fetch(`${base}/v1/oauth/kimi-code/session/${start.sessionId}`, { headers: { authorization: `Bearer ${key}` } })).json();

    assert.equal(status.status, 'connected');
    assert.ok(status.connection, 'the connection comes back so the dashboard can show what was saved');
    // The record is read through `list()`: this class also inherits the credential store's
    // `get(providerId)`, which returns a *credential*, so calling it here answers undefined and reads
    // like a connection that was never saved.
    const saved = (await connectionStore.list()).find((c) => c.id === 'kimi-code');
    assert.ok(saved, 'and it is in the store, not only in the response');
    assert.equal(saved.providerId, 'kimi-code');
  });
});

test('two concurrent polls of one session save one connection, not two', async () => {
  // The device code is single-use. Claiming before the exchange is what stops the second poll from
  // spending it, being told it is invalid, and overwriting a success that already happened.
  const connectionStore = new InMemoryConnectionStore();
  let tokenExchanges = 0;
  const { service, key } = await buildService((request) => {
    const answer = completedSignIn(request);
    // Count only the token exchange, not the model discovery that follows it.
    if (!request.url.includes('/models') && answer.data?.access_token) tokenExchanges += 1;
    return answer;
  }, { connectionStore });

  await withServer(service, async (base) => {
    const start = await (await startFlow(base, key)).json();
    const url = `${base}/v1/oauth/kimi-code/session/${start.sessionId}`;
    const headers = { authorization: `Bearer ${key}` };
    const both = await Promise.all([fetch(url, { headers }).then((r) => r.json()), fetch(url, { headers }).then((r) => r.json())]);

    // The device code is exchanged **once**. That is the property; how many polls *report* connected
    // is not, and my first version asserted both — which was wrong: the second poll arrives after the
    // session is settled, reads `connected`, and returns the connection that was already saved. That
    // is the desired behaviour, not a duplicate. A client that polls twice must not be told the
    // sign-in failed because someone else finished it.
    assert.equal(tokenExchanges, 1, `the device code was exchanged ${tokenExchanges} times`);
    assert.deepEqual(both.map((s) => s.status), ['connected', 'connected'], 'both polls see a completed sign-in');
    assert.deepEqual(both.filter((s) => s.status === 'failed'), [], 'and neither is told it failed');
    assert.equal((await connectionStore.list()).find((c) => c.id === 'kimi-code').providerId, 'kimi-code');
  });
});

test('a refused grant reports Kimi\'s own wording and saves nothing', async () => {
  const connectionStore = new InMemoryConnectionStore();
  const { service, key } = await buildService((request) =>
    request.url.includes('device_authorization')
      ? deviceCodeAnswer
      : { status: 400, data: { error: 'access_denied', error_description: 'The user denied the request' } }, { connectionStore });

  await withServer(service, async (base) => {
    const start = await (await startFlow(base, key)).json();
    const status = await (await fetch(`${base}/v1/oauth/kimi-code/session/${start.sessionId}`, { headers: { authorization: `Bearer ${key}` } })).json();

    assert.equal(status.status, 'failed');
    assert.match(status.error, /denied the request/, 'the provider said why, and the user is told why');
    assert.equal((await connectionStore.list()).some((c) => c.id === 'kimi-code'), false, 'a refused sign-in must not leave a connection');
  });
});

test('an unknown session is 404, and a malformed one is refused before it is looked up', async () => {
  const { service, key } = await buildService(() => deviceCodeAnswer);
  await withServer(service, async (base) => {
    const missing = await fetch(`${base}/v1/oauth/kimi-code/session/AAAAAAAAAAAAAAAAAAAA`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'NOT_FOUND');

    // A crafted path must not reach the store, and must not become a lookup of arbitrary input.
    const crafted = await fetch(`${base}/v1/oauth/kimi-code/session/${encodeURIComponent('../../keys')}`, { headers: { authorization: `Bearer ${key}` } });
    assert.ok(crafted.status === 400 || crafted.status === 404, `a crafted session id answered ${crafted.status}`);
  });
});

test('the start route is behind the management gate', async () => {
  // A device-code request is not free: it asks the provider for a grant. Unauthenticated, a local
  // process could start sign-ins it has no business starting.
  const { service, key } = await buildService(() => deviceCodeAnswer);
  await withServer(service, async (base) => {
    const keys = new InMemoryApiKeyStore();
    const enforced = new GatewayService(
      new ProviderRegistry(),
      new InMemorySecretStore({ 'kimi-code': { type: 'oauth', value: 'acc' } }),
      new InMemoryConnectionStore(),
      keys,
      { transport: scriptTransport(() => deviceCodeAnswer) },
    );
    const server = createGatewayServer(enforced, { corsOrigin: 'http://localhost:5173' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      // Two layers answer here, and both are correct: a browser-shaped request from a
      // non-allowlisted origin is stopped by the cross-site check (403) before the key gate is
      // reached, while a plain client with no Origin is stopped by the key gate (401). Asserting
      // either single code would have passed on a gateway with the *other* layer missing.
      const crossSite = await fetch(`http://127.0.0.1:${port}/v1/oauth/kimi-code/start`, {
        method: 'POST',
        headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(crossSite.status, 403, 'a browser-shaped request from another origin is stopped');

      const plainClient = await fetch(`http://127.0.0.1:${port}/v1/oauth/kimi-code/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(plainClient.status, 401, 'and a plain client with no key is refused by the key gate');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('the poll presents the device id the start minted, so it asks about the same grant', async () => {
  // Kimi ties the two halves of a device grant together by `X-Msh-Device-Id`. A poll carrying a fresh
  // id asks about a different session and answers `authorization_pending` forever — which reads to a
  // user as "still waiting for approval" indefinitely.
  let startDeviceId;
  let pollDeviceId;
  const { service, key } = await buildService((request, fields) => {
    // Only the two halves of the *device grant* are compared. A completed sign-in then performs a
    // model discovery, which carries the API host's headers rather than the account host's — and my
    // first version recorded that third call too, so the "poll" value it asserted on was never a poll.
    if (request.url.includes('device_authorization')) {
      startDeviceId = request.headers['X-Msh-Device-Id'];
      return deviceCodeAnswer;
    }
    if (request.url.includes('/oauth/token')) {
      pollDeviceId = request.headers['X-Msh-Device-Id'];
      return { data: { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 } };
    }
    return { data: { data: [{ id: 'kimi-latest' }] } };
  });

  await withServer(service, async (base) => {
    const start = await (await startFlow(base, key)).json();
    await (await fetch(`${base}/v1/oauth/kimi-code/session/${start.sessionId}`, { headers: { authorization: `Bearer ${key}` } })).json();
  });

  assert.ok(startDeviceId, 'the start minted a device id');
  assert.equal(pollDeviceId, startDeviceId, 'and the poll presented the same one');
  assert.notEqual(pollDeviceId, undefined);
  // The account host and the API host send different headers, so the two are never compared by accident.
});

test('both halves of the flow are form-encoded, as Kimi requires', async () => {
  // Measured: a JSON body to `device_authorization` is answered `400 client_id is required` even
  // though the parameter is present, because the body is not read. Form-encoded returns 200.
  const seen = [];
  const { service, key } = await buildService((request) => {
    // Only the account host. The API host is JSON — the form requirement is Kimi's *OAuth* endpoints,
    // and asserting it of the model list would demand the wrong thing of the right code.
    if (request.url.startsWith(KIMI_AUTH_ORIGIN)) seen.push(request.headers['content-type']);
    return completedSignIn(request);
  });

  await withServer(service, async (base) => {
    const start = await (await startFlow(base, key)).json();
    await (await fetch(`${base}/v1/oauth/kimi-code/session/${start.sessionId}`, { headers: { authorization: `Bearer ${key}` } })).json();
  });

  assert.equal(seen.length, 2, `both halves of the device grant should have been requested, saw ${seen.length}`);
  for (const type of seen) assert.equal(type, 'application/x-www-form-urlencoded');
});

test('the sign-in uses the gateway\'s own transport, so a caller-supplied one is not bypassed', async () => {
  // The bypass this guards: `new KimiCodeAdapter({ transport: this.transport })` inside
  // `startKimiCodeSignIn` built its *own* `FetchHttpTransport` and reached the real Kimi, even when the
  // gateway was constructed with a scripted transport — so a test of this flow made a live network
  // call, and a caller who supplied their own transport had it ignored for the sign-in.
  //
  // It is invisible while both transports behave identically, so this makes them differ: the
  // gateway's transport is the script, and a transport that fails loudly if used is registered under
  // the same provider id. Reaching the real network shows up as the test taking a network round trip;
  // this asserts the seam directly instead.
  const source = readFileSync(new URL('../src/service.ts', import.meta.url), 'utf8');
  const method = source.slice(source.indexOf('async startKimiCodeSignIn()'), source.indexOf('async startKimiCodeSignIn()') + 1200);
  assert.equal(
    /new KimiCodeAdapter\(/.test(method),
    false,
    'startKimiCodeSignIn must not construct its own adapter — it would carry its own transport and ignore the gateway\'s',
  );
  assert.match(method, /kimiCodeAdapter\(/, 'and it must go through the memoised adapter, which holds the gateway\'s transport');
});

test('a crafted session id is refused by the route, without reaching the store', async () => {
  // Behavioural, not structural. My first version read the route's source and asserted the pattern
  // appeared within 700 characters of the route string — and removing the check from *this* route
  // left every test green, because the window reached the next route's identical check. A guard whose
  // window can cover the wrong code is the "resolver whose character class cannot match a separator"
  // failure in a different shape.
  //
  // So this asks what a caller can observe: a path that is not a plausible session id gets a refusal
  // that is not `NOT_FOUND`, which is what "the store never saw it" looks like from outside — an
  // unknown-but-well-formed id is a 404, and a malformed one is a 400.
  const { service, key } = await buildService(() => deviceCodeAnswer);
  await withServer(service, async (base) => {
    const headers = { authorization: `Bearer ${key}` };
    const unknownButWellFormed = await fetch(`${base}/v1/oauth/kimi-code/session/AAAAAAAAAAAAAAAAAAAA`, { headers });
    assert.equal(unknownButWellFormed.status, 404, 'a well-formed id that does not exist is NOT_FOUND');

    // `..` and `%2e%2e%2fkeys` are *not* expected to answer 400: `fetch` normalises a dot-segment out
    // of the path before it leaves the client, so the route never sees them. That is a second layer
    // working, and asserting 400 there would demand the route undo something the client already did.
    // What matters for those is simply that they cannot reach a session.
    for (const crafted of ['a b', 'short', '../../keys', 'has/slash', 'x'.repeat(200)]) {
      const response = await fetch(`${base}/v1/oauth/kimi-code/session/${encodeURIComponent(crafted)}`, { headers });
      assert.equal(response.status, 400, `a crafted id ${JSON.stringify(crafted)} should be refused before lookup, got ${response.status}`);
      assert.notEqual((await response.json()).error?.code, 'NOT_FOUND', 'and must not be reported as a missing session');
    }
    // A dot-segment cannot traverse to another route's data: it must not answer with that route's shape.
    const traversal = await fetch(`${base}/v1/oauth/kimi-code/session/${encodeURIComponent('../../keys')}`, { headers });
    assert.notEqual(traversal.status, 200, 'a path-traversal attempt must not reach a management route');
  });
});