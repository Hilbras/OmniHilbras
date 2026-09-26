import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderError, ProviderRegistry } from '@hilbras/omnihilbras';
import { GatewayService, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';

/** A gateway with no Cline connection, so only the OAuth surface is reachable. */
function createService() {
  return new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore());
}

async function startServer(t, service = createService(), options = {}) {
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173', publicBaseUrl: 'http://127.0.0.1:8787', ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, 'object');
  return `http://127.0.0.1:${address.port}`;
}

/** Starts a sign-in the way the dashboard does. */
async function startSignIn(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/oauth/cline/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 201);
  return response.json();
}

/** A service whose Cline token exchange succeeds, so a full round trip can run. */
function createConnectedService() {
  const service = createService();
  service.connectCline = async (input) => {
    if (input.code === 'rejected') throw new ProviderError('AUTHENTICATION_FAILED', 'Cline did not accept that sign-in. Try again.', { providerId: 'cline', publicMessage: 'Cline did not accept that sign-in. Try again.' });
    return {
      id: 'cline',
      providerId: 'cline',
      name: 'Cline (dev@example.com)',
      endpoint: 'https://api.cline.bot',
      priority: 1,
      proxyPool: 'none',
      enabled: true,
      hasCredential: true,
      modelPolicy: 'all',
      modelIds: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.4'],
      customModelIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  };
  return service;
}

test('starting a sign-in hands back a session and a state carried in the URL', async (t) => {
  const baseUrl = await startServer(t);
  const started = await startSignIn(baseUrl);
  assert.match(started.sessionId, /^[A-Za-z0-9_-]{20,}$/);
  assert.ok(started.state.length >= 32);
  // The session id rides in the redirect path, because Cline's AuthKit handoff
  // never echoes `state` back.
  assert.equal(started.redirectUri, `http://127.0.0.1:8787/v1/oauth/cline/callback/${started.sessionId}`);
  const url = new URL(started.authUrl);
  assert.equal(url.searchParams.get('state'), started.state, 'a state is still offered');
  assert.equal(url.searchParams.get('redirect_uri'), started.redirectUri);
  assert.equal(url.searchParams.get('callback_url'), started.redirectUri);

  const status = await (await fetch(`${baseUrl}/v1/oauth/cline/session/${started.sessionId}`)).json();
  assert.deepEqual(status, { status: 'pending' });
});

test('a start request with a non-loopback redirect is refused', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/v1/oauth/cline/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirectUri: 'https://evil.example.com/callback' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
});

test('a browser callback finishes the sign-in with nothing to paste', async (t) => {
  const service = createConnectedService();
  const baseUrl = await startServer(t, service);
  const started = await startSignIn(baseUrl);

  const page = await fetch(`${baseUrl}/v1/oauth/cline/callback/${started.sessionId}?code=granted`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Cline connected/);
  assert.match(html, /2 models/);
  assert.equal(html.includes('granted'), false, 'the code is never shown back');

  const status = await (await fetch(`${baseUrl}/v1/oauth/cline/session/${started.sessionId}`)).json();
  assert.equal(status.status, 'connected');
  assert.equal(status.connection.name, 'Cline (dev@example.com)');
  assert.deepEqual(status.connection.modelIds, ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.4']);
  assert.equal(JSON.stringify(status).toLowerCase().includes('token'), false, 'the status carries no credential');
});

test('the flow completes even when the provider never echoes the state back', async (t) => {
  const service = createConnectedService();
  const baseUrl = await startServer(t, service);
  const started = await startSignIn(baseUrl);
  assert.ok(started.state, 'a state is still sent to the provider');

  // Cline hands off to WorkOS AuthKit, which drops `state`. The redirect path
  // is the only thing that still identifies the sign-in.
  const page = await fetch(`${baseUrl}/v1/oauth/cline/callback/${started.sessionId}?code=granted`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.match(await page.text(), /Cline connected/);

  const status = await (await fetch(`${baseUrl}/v1/oauth/cline/session/${started.sessionId}`)).json();
  assert.equal(status.status, 'connected');
  assert.equal(status.connection.name, 'Cline (dev@example.com)');
});

test('a state that comes back must match the session in the path', async (t) => {
  const service = createConnectedService();
  let calls = 0;
  service.connectCline = async () => {
    calls += 1;
    return { id: 'cline', providerId: 'cline', name: 'Cline', modelIds: ['m'], customModelIds: [] };
  };
  const baseUrl = await startServer(t, service);
  const first = await startSignIn(baseUrl);
  const second = await startSignIn(baseUrl);

  const crossed = await fetch(`${baseUrl}/v1/oauth/cline/callback/${first.sessionId}?code=granted&state=${encodeURIComponent(second.state)}`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.match(await crossed.text(), /sign-in failed/);
  assert.equal(calls, 0, 'a crossed state exchanges nothing');

  // The mismatched attempt spent nothing, so the real callback still works.
  const retry = await fetch(`${baseUrl}/v1/oauth/cline/callback/${first.sessionId}?code=granted&state=${encodeURIComponent(first.state)}`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.match(await retry.text(), /Cline connected/);
  assert.equal(calls, 1);
});

test('a callback with no session at all points at the paste box', async (t) => {
  const service = createConnectedService();
  let calls = 0;
  service.connectCline = async () => {
    calls += 1;
    return { id: 'cline', providerId: 'cline', name: 'Cline', modelIds: ['m'], customModelIds: [] };
  };
  const baseUrl = await startServer(t, service);
  const page = await fetch(`${baseUrl}/v1/oauth/cline/callback?code=granted`, { headers: { 'sec-fetch-site': 'cross-site' } });
  const html = await page.text();
  assert.match(html, /sign-in failed/);
  assert.match(html, /paste box/i, 'the message says how to finish instead of just failing');
  assert.equal(calls, 0, 'a code with no session is not exchanged');
});

test('a replayed callback path is refused even with the right state', async (t) => {
  const service = createConnectedService();
  let calls = 0;
  service.connectCline = async () => {
    calls += 1;
    return { id: 'cline', providerId: 'cline', name: 'Cline', modelIds: ['m'], customModelIds: [] };
  };
  const baseUrl = await startServer(t, service);
  const started = await startSignIn(baseUrl);
  const url = `${baseUrl}/v1/oauth/cline/callback/${started.sessionId}?code=granted&state=${encodeURIComponent(started.state)}`;
  await fetch(url, { headers: { 'sec-fetch-site': 'cross-site' } });
  const replay = await fetch(url, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.match(await replay.text(), /sign-in failed/);
  assert.equal(calls, 1, 'the code is exchanged once');
});

test('the exchange was given the redirect the sign-in started with', async (t) => {
  const service = createConnectedService();
  const seen = [];
  service.connectCline = async (input) => {
    seen.push(input);
    return { id: 'cline', providerId: 'cline', name: 'Cline', modelIds: ['m'], customModelIds: [] };
  };
  const baseUrl = await startServer(t, service);
  const started = await startSignIn(baseUrl);
  await fetch(`${baseUrl}/v1/oauth/cline/callback/${started.sessionId}?code=granted`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, 'granted');
  // OAuth requires the exchange redirect_uri to equal the authorize one, so the
  // session id in the path has to be there at exchange time too.
  assert.equal(seen[0].redirectUri, started.redirectUri);
  assert.equal(new URL(started.authUrl).searchParams.get('redirect_uri'), seen[0].redirectUri);
});

test('a callback for a session that was never started is refused', async (t) => {
  const service = createConnectedService();
  const baseUrl = await startServer(t, service);
  const started = await startSignIn(baseUrl);
  const page = await fetch(`${baseUrl}/v1/oauth/cline/callback/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?code=attacker-code`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.match(await page.text(), /sign-in failed/);
  assert.deepEqual(await service.listConnections(), [], 'a forged callback creates nothing');
  // The real sign-in is untouched and still waiting.
  const status = await (await fetch(`${baseUrl}/v1/oauth/cline/session/${started.sessionId}`)).json();
  assert.equal(status.status, 'pending');
});

test('a rejected code is reported to the dashboard instead of leaving it waiting', async (t) => {
  const service = createConnectedService();
  const baseUrl = await startServer(t, service);
  const started = await startSignIn(baseUrl);
  const page = await fetch(`${baseUrl}/v1/oauth/cline/callback/${started.sessionId}?code=rejected`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.match(await page.text(), /sign-in failed/);
  const status = await (await fetch(`${baseUrl}/v1/oauth/cline/session/${started.sessionId}`)).json();
  assert.equal(status.status, 'failed');
  assert.match(status.error, /did not accept/);
});

test('an unknown or malformed session id is not a pending sign-in', async (t) => {
  const baseUrl = await startServer(t);
  const unknown = await fetch(`${baseUrl}/v1/oauth/cline/session/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
  assert.equal(unknown.status, 404);
  const malformed = await fetch(`${baseUrl}/v1/oauth/cline/session/short`);
  assert.equal(malformed.status, 400);
});

test('the authorize route hands back a Cline sign-in URL for a loopback callback', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/v1/oauth/cline/authorize`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.redirectUri, 'http://127.0.0.1:8787/v1/oauth/cline/callback');
  const url = new URL(body.authUrl);
  assert.equal(url.origin + url.pathname, 'https://api.cline.bot/api/v1/auth/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), body.redirectUri);
  assert.equal(url.searchParams.get('client_type'), 'extension');
});

test('a redirect that is not loopback is refused', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/v1/oauth/cline/authorize?redirect_uri=https://evil.example.com/callback`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
});

test('the callback page survives the cross-site navigation that reaches it', async (t) => {
  const baseUrl = await startServer(t);
  // A top-level redirect from the provider sends `sec-fetch-site: cross-site`
  // and no Origin, which every other route refuses.
  const response = await fetch(`${baseUrl}/v1/oauth/cline/callback/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?code=abc123`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  // An unknown state is refused, and no code is echoed back into the page.
  assert.equal(html.includes('abc123'), false);
  assert.match(html, /sign-in failed/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  // This origin also holds the local API keys, so the page gets no script.
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(/<script/i.test(html), false);
});

test('the callback page will not reflect markup back into the page', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/v1/oauth/cline/callback?code=${encodeURIComponent('<img src=x onerror=alert(1)>')}`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal(html.includes('<img src=x'), false, 'markup is never reflected');
  assert.equal(html.includes('<script>alert'), false, 'markup is never reflected');
});

test('a provider-side error is reported without leaking the code', async (t) => {
  const service = createService();
  const baseUrl = await startServer(t, service);
  const started = await startSignIn(baseUrl);
  const response = await fetch(`${baseUrl}/v1/oauth/cline/callback/${started.sessionId}?error=${encodeURIComponent('access_denied')}`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  const html = await response.text();
  assert.match(html, /sign-in failed/);
  assert.match(html, /access_denied/);
  // The dashboard is told the outcome, so it stops waiting too.
  const status = await (await fetch(`${baseUrl}/v1/oauth/cline/session/${started.sessionId}`)).json();
  assert.equal(status.status, 'failed');
  assert.match(status.error, /access_denied/);
});

test('a provider error carrying markup cannot inject into the page', async (t) => {
  const baseUrl = await startServer(t);
  const started = await startSignIn(baseUrl);
  const response = await fetch(`${baseUrl}/v1/oauth/cline/callback/${started.sessionId}?error=${encodeURIComponent('<img src=x onerror=alert(1)>')}`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  const html = await response.text();
  assert.equal(html.includes('<img src=x'), false);
});

test('cross-site requests to every other route are still refused', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/v1/models`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'CROSS_SITE_REQUEST_DENIED');
});

test('the exchange route refuses a request with no pasted value', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/v1/oauth/cline/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '  ' }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
});

test('the exchange route rejects unknown fields', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/v1/oauth/cline/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'abc', admin: true }),
  });
  assert.equal(response.status, 400);
});

test('an off-loopback pasted callback is refused before any exchange', async (t) => {
  const service = createService();
  const baseUrl = await startServer(t, service);
  const response = await fetch(`${baseUrl}/v1/oauth/cline/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'https://evil.example.com/?code=stolen', redirectUri: 'http://127.0.0.1:8787/v1/oauth/cline/callback' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'INVALID_REQUEST');
  assert.match(body.error.message, /loopback/);
  assert.deepEqual(await service.listConnections(), [], 'nothing is stored');
});

test('a token Cline rejects is not stored as a connection', async (t) => {
  const service = createService();
  const transport = {
    async request() {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Cline rejected the sign-in', { providerId: 'cline' });
    },
    stream() {
      throw new Error('not used');
    },
  };
  const wired = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), undefined, { transport });
  const baseUrl = await startServer(t, wired);
  const response = await fetch(`${baseUrl}/v1/oauth/cline/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'bare-code', redirectUri: 'http://127.0.0.1:8787/v1/oauth/cline/callback' }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await service.listConnections(), []);
  assert.deepEqual(await wired.listConnections(), [], 'a failed sign-in leaves no connection behind');
});

test('a token endpoint that is simply unreachable is not reported as a rejected code', async (t) => {
  const service = createService();
  const transport = {
    async request() {
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'connection refused', { providerId: 'cline' });
    },
    stream() {
      throw new Error('not used');
    },
  };
  const wired = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), undefined, { transport });
  const baseUrl = await startServer(t, wired);
  const response = await fetch(`${baseUrl}/v1/oauth/cline/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'bare-code', redirectUri: 'http://127.0.0.1:8787/v1/oauth/cline/callback' }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await wired.listConnections(), []);
});

test("the provider's own reason reaches the operator", async (t) => {
  const service = createService();
  service.connectCline = async () => {
    const { ProviderError } = await import('@hilbras/omnihilbras');
    // What the transport produces for a 4xx that carries a reason.
    throw new ProviderError('PROVIDER_REQUEST_FAILED', 'The provider rejected the request.', {
      providerId: 'cline',
      statusCode: 400,
      details: { providerMessage: 'redirect_uri does not match the registered callback' },
    });
  };
  const baseUrl = await startServer(t, service);
  const started = await startSignIn(baseUrl);
  const page = await fetch(`${baseUrl}/v1/oauth/cline/callback/${started.sessionId}?code=granted`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  const html = await page.text();
  assert.match(html, /redirect_uri does not match/, 'the real reason is shown, not just a generic failure');

  const status = await (await fetch(`${baseUrl}/v1/oauth/cline/session/${started.sessionId}`)).json();
  assert.equal(status.status, 'failed');
  assert.match(status.error, /redirect_uri does not match/);
});
