import assert from 'node:assert/strict';
import test from 'node:test';
import { ClineAdapter, decodeClineCode, toClineAccessToken } from '@hilbras/omnihilbras';

test('WorkOS JWTs are prefixed and other tokens are left alone', () => {
  assert.equal(toClineAccessToken('eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.sig'), 'workos:eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.sig');
  // Already prefixed tokens are not prefixed twice.
  assert.equal(toClineAccessToken('workos:eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.sig'), 'workos:eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.sig');
  // A ClinePass key is not a JWT and must be sent verbatim.
  assert.equal(toClineAccessToken('clp_live_abc123'), 'clp_live_abc123');
  assert.equal(toClineAccessToken('   '), '');
});

test('an embedded token payload is decoded from base64 or raw JSON', () => {
  const json = { accessToken: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.sig', refreshToken: 'r1', expiresAt: '2030-01-01T00:00:00.000Z', email: 'dev@example.com' };
  const encoded = Buffer.from(JSON.stringify(json)).toString('base64');
  const fromBase64 = decodeClineCode(encoded);
  assert.equal(fromBase64.accessToken, json.accessToken);
  assert.equal(fromBase64.refreshToken, 'r1');
  assert.equal(fromBase64.email, 'dev@example.com');

  const fromJson = decodeClineCode(JSON.stringify(json));
  assert.equal(fromJson.accessToken, json.accessToken);

  const nested = decodeClineCode(JSON.stringify({ data: { accessToken: 'nested-token', userInfo: { email: 'n@e.w' } } }));
  assert.equal(nested.accessToken, 'nested-token');
  assert.equal(nested.email, 'n@e.w');

  // A plain authorization code is not a token payload.
  assert.equal(decodeClineCode('plain-code'), undefined);
  assert.equal(decodeClineCode(''), undefined);
});

test('an expired token is refreshed once and the new token is persisted', async () => {
  const requests = [];
  const refreshed = [];
  const adapter = new ClineAdapter({
    transport: {
      async request(request) {
        requests.push(request);
        if (request.url.endsWith('/auth/refresh')) {
          return { status: 200, headers: new Headers(), data: { accessToken: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIyIn0.new', refreshToken: 'r2', expiresAt: '2030-01-01T00:00:00.000Z' } };
        }
        return { status: 200, headers: new Headers(), data: { id: 'acc_1' } };
      },
      stream() { throw new Error('not used'); },
    },
    onTokensRefreshed: (tokens) => { refreshed.push(tokens); },
    refreshSkewMs: 0,
  });

  const result = await adapter.validateCredential({
    type: 'oauth',
    value: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.old',
    refreshToken: 'r1',
    expiresAt: '2020-01-01T00:00:00.000Z',
  });

  assert.equal(result.status, 'valid');
  assert.equal(requests.length, 2, 'refresh, then the account check');
  assert.equal(requests[0].url, 'https://api.cline.bot/api/v1/auth/refresh');
  const body = JSON.parse(requests[0].body);
  assert.equal(body.grant_type, 'refresh_token');
  assert.equal(body.refresh_token, 'r1');
  assert.equal(refreshed.length, 1, 'the renewed token is written back to the vault');
  assert.equal(refreshed[0].accessToken, 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIyIn0.new');
  assert.equal(requests[1].headers.Authorization, 'Bearer workos:eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIyIn0.new');
});

test('a token with no refresh token is used as-is', async () => {
  const requests = [];
  const adapter = new ClineAdapter({
    transport: {
      async request(request) {
        requests.push(request);
        return { status: 200, headers: new Headers(), data: { id: 'acc_1' } };
      },
      stream() { throw new Error('not used'); },
    },
  });
  await adapter.validateCredential({ type: 'oauth', value: 'clp_live_key' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.cline.bot/api/v1/users/me');
  assert.equal(requests[0].headers.Authorization, 'Bearer clp_live_key');
});

test('a missing token fails before any request is sent', async () => {
  let called = false;
  const adapter = new ClineAdapter({
    transport: { async request() { called = true; return { status: 200, headers: new Headers(), data: {} }; }, stream() { throw new Error('not used'); } },
  });
  await assert.rejects(() => adapter.validateCredential(undefined), /A Cline access token is required/);
  await assert.rejects(() => adapter.validateCredential({ type: 'none' }), /A Cline access token is required/);
  assert.equal(called, false, 'no request without a token');
});

test('the account probe failure surfaces as an authentication error', async () => {
  const { ProviderError } = await import('@hilbras/omnihilbras');
  const adapter = new ClineAdapter({
    transport: {
      async request() { throw new ProviderError('AUTHENTICATION_FAILED', 'Cline rejected the token', { providerId: 'cline' }); },
      stream() { throw new Error('not used'); },
    },
  });
  await assert.rejects(() => adapter.validateCredential({ type: 'oauth', value: 'bad' }), (error) => error instanceof ProviderError && error.code === 'AUTHENTICATION_FAILED');
  const health = await adapter.healthCheck({ credential: { type: 'oauth', value: 'bad' } });
  assert.equal(health.status, 'unavailable');
});
