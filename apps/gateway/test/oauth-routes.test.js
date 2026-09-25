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
  const response = await fetch(`${baseUrl}/v1/oauth/cline/callback?code=abc123`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  assert.match(html, /abc123/);
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
  assert.match(html, /no authorization code/);
});

test('a provider-side error is reported without a code', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/v1/oauth/cline/callback?error=access_denied`, { headers: { 'sec-fetch-site': 'cross-site' } });
  const html = await response.text();
  assert.match(html, /access_denied/);
  assert.equal(/value="/.test(html), false, 'no field is filled in');
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
