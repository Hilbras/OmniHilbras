import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError } from '@hilbras/omnihilbras';
import { beginClineAuthorization, exchangeClineCode, extractClineCode, toClineCredential } from '../dist/index.js';

/** A transport that records requests and answers from a fixed script. */
function fakeTransport(responses) {
  const requests = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request to ${request.url}`);
      if (next.status >= 400) {
        const { ProviderError: PE } = await import('@hilbras/omnihilbras');
        throw new PE('AUTHENTICATION_FAILED', 'denied', { providerId: 'cline' });
      }
      return { status: next.status ?? 200, headers: new Headers(), data: next.data };
    },
    stream() {
      throw new Error('not used');
    },
  };
}

test('the authorization URL is loopback and carries Cline client parameters', () => {
  const result = beginClineAuthorization('http://127.0.0.1:5173/v1/oauth/cline/callback');
  const url = new URL(result.authUrl);
  assert.equal(url.origin + url.pathname, 'https://api.cline.bot/api/v1/auth/authorize');
  assert.equal(url.searchParams.get('client_type'), 'extension');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5173/v1/oauth/cline/callback');
  assert.equal(url.searchParams.get('callback_url'), 'http://127.0.0.1:5173/v1/oauth/cline/callback');
});

test('a non-loopback redirect is rejected', () => {
  assert.throws(() => beginClineAuthorization('https://evil.example.com/callback'), (error) => error instanceof ProviderError && error.code === 'INVALID_REQUEST');
  assert.throws(() => beginClineAuthorization('http://127.0.0.1.evil.com/callback'), (error) => error instanceof ProviderError);
});

test('the pasted value is read as a callback URL, a code#state pair, or a bare code', () => {
  assert.equal(extractClineCode({ code: '', callback: 'http://127.0.0.1:5173/cb?code=abc123&state=xyz', redirectUri: 'http://127.0.0.1:5173/cb' }), 'abc123');
  assert.equal(extractClineCode({ code: 'plain-code', redirectUri: 'http://127.0.0.1:5173/cb' }), 'plain-code');
  assert.equal(extractClineCode({ code: 'code#state', redirectUri: 'http://127.0.0.1:5173/cb' }), 'code');
});

test('a callback URL pointing off-loopback is refused rather than followed', () => {
  assert.throws(
    () => extractClineCode({ code: '', callback: 'https://evil.example.com/?code=stolen', redirectUri: 'http://127.0.0.1:5173/cb' }),
    (error) => error instanceof ProviderError && /loopback/.test(error.message),
  );
});

test('a callback URL without a code is rejected with a usable message', () => {
  assert.throws(
    () => extractClineCode({ code: '', callback: 'http://127.0.0.1:5173/cb?state=xyz', redirectUri: 'http://127.0.0.1:5173/cb' }),
    (error) => error instanceof ProviderError && /no authorization code/.test(error.message),
  );
});

test('an empty paste is a clear request for the value', () => {
  assert.throws(() => extractClineCode({ code: '   ', redirectUri: 'http://127.0.0.1:5173/cb' }), (error) => error instanceof ProviderError && /Paste the callback URL/.test(error.message));
});

test('tokens embedded in the code are used without a token request', async () => {
  const payload = Buffer.from(JSON.stringify({ accessToken: 'workos:jwt', refreshToken: 'r1', expiresAt: '2030-01-01T00:00:00.000Z', email: 'dev@example.com' })).toString('base64');
  const transport = fakeTransport([]);
  const tokens = await exchangeClineCode({ code: payload, redirectUri: 'http://127.0.0.1:5173/cb' }, transport);
  assert.equal(tokens.accessToken, 'workos:jwt');
  assert.equal(tokens.refreshToken, 'r1');
  assert.equal(tokens.email, 'dev@example.com');
  assert.equal(transport.requests.length, 0, 'no token request is needed');
});

test('a bare code is exchanged at the Cline token endpoint', async () => {
  const transport = fakeTransport([{ data: { data: { accessToken: 'jwt-2', refreshToken: 'r2', expiresAt: '2030-01-01T00:00:00.000Z', userInfo: { email: 'a@b.c' } } } }]);
  const tokens = await exchangeClineCode({ code: 'bare-code', redirectUri: 'http://127.0.0.1:5173/cb' }, transport);
  assert.equal(tokens.accessToken, 'jwt-2');
  assert.equal(tokens.refreshToken, 'r2');
  assert.equal(tokens.email, 'a@b.c');
  const [request] = transport.requests;
  assert.equal(request.url, 'https://api.cline.bot/api/v1/auth/token');
  assert.equal(request.headers['content-type'], 'application/json');
  const body = JSON.parse(request.body);
  assert.equal(body.grant_type, 'authorization_code');
  assert.equal(body.code, 'bare-code');
  assert.equal(body.client_type, 'extension');
  assert.equal(body.redirect_uri, 'http://127.0.0.1:5173/cb');
  // No access token is sent to the token endpoint.
  assert.equal(request.headers.Authorization, undefined);
});

test('an exchange that returns no access token fails loudly', async () => {
  const transport = fakeTransport([{ data: { ok: true } }]);
  await assert.rejects(
    () => exchangeClineCode({ code: 'bare', redirectUri: 'http://127.0.0.1:5173/cb' }, transport),
    (error) => error instanceof ProviderError && /did not return an access token/.test(error.message),
  );
});

test('an OAuth credential carries the refresh material into the vault shape', () => {
  const credential = toClineCredential({ accessToken: 'jwt', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z', email: 'x@y.z' });
  assert.deepEqual(credential, { type: 'oauth', value: 'jwt', refreshToken: 'r', expiresAt: '2030-01-01T00:00:00.000Z', email: 'x@y.z' });
  // The token is stored exactly as issued; the `workos:` prefix is a wire
  // detail the adapter adds per request, so it is never persisted.
  assert.equal(credential.value, 'jwt');
});
