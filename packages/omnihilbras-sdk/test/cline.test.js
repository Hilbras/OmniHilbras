import assert from 'node:assert/strict';
import test from 'node:test';
import { CLINE_OAUTH, ClineAdapter, clineExpiryToIso, decodeClineCode, providerErrorDetail, toClineAccessToken } from '@hilbras/omnihilbras';

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
  assert.equal(requests.length, 2, 'refresh, then the catalog check');
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

test('a provider error keeps a safe excerpt of what the provider said', () => {
  assert.equal(providerErrorDetail({ message: 'code is expired' }), 'code is expired');
  assert.equal(providerErrorDetail({ error: { message: 'bad client' } }), 'bad client');
  assert.equal(providerErrorDetail({ error_description: 'redirect mismatch' }), 'redirect mismatch');
  assert.equal(providerErrorDetail('plain text failure'), 'plain text failure');
  assert.equal(providerErrorDetail({ nothing: 'useful' }), undefined);
  assert.equal(providerErrorDetail(undefined), undefined);
});

test('a provider error excerpt never carries a token', () => {
  const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.' + 'A'.repeat(40);
  const detail = providerErrorDetail({ message: `token ${jwt} rejected` });
  assert.equal(detail.includes(jwt), false, 'the token is not echoed back');
  assert.match(detail, /\[redacted\]/);
  assert.equal(providerErrorDetail({ message: `key sk-abcdefghijklmnopqrstuvwx failed` }).includes('sk-abcdefghijklmnopqrstuvwx'), false);
});

test('a provider error excerpt is short and printable', () => {
  assert.equal(providerErrorDetail({ message: 'x'.repeat(5000) })?.length, 200);
  assert.equal(providerErrorDetail({ message: 'line\nbreak\u0000null' }), 'line break null');
});

test('a Cline expiry in epoch seconds is not mistaken for 1970', () => {
  const seconds = Math.floor(Date.now() / 1000) + 3600;
  const fromSeconds = clineExpiryToIso(seconds);
  assert.ok(new Date(fromSeconds).getTime() > Date.now(), 'a seconds expiry lands in the future');
  // A value already in milliseconds must not be rescaled.
  assert.equal(clineExpiryToIso(seconds * 1000), fromSeconds);
  assert.equal(clineExpiryToIso('2030-01-01T00:00:00.000Z'), '2030-01-01T00:00:00.000Z');
  assert.equal(clineExpiryToIso(0), undefined);
  assert.equal(clineExpiryToIso(Number.NaN), undefined);
});

test('a token whose expiry is in seconds is not refreshed straight away', async () => {
  const requests = [];
  const adapter = new ClineAdapter({
    transport: {
      async request(request) {
        requests.push(request);
        return { status: 200, headers: new Headers(), data: { id: 'acc_1' } };
      },
      stream() { throw new Error('not used'); },
    },
    refreshSkewMs: 60_000,
  });
  // What Cline actually sends: a JWT-shaped token and a seconds expiry an hour out.
  const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
  await adapter.validateCredential({
    type: 'oauth',
    value: jwt,
    refreshToken: 'r1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  assert.equal(requests.length, 1, 'no refresh for a token that is still valid');
  assert.equal(requests[0].url, 'https://api.cline.bot/api/v1/users/me');
  assert.equal(requests[0].headers.Authorization, `Bearer workos:${jwt}`);
});

test('an embedded token payload with a seconds expiry decodes correctly', () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const code = Buffer.from(JSON.stringify({ accessToken: 'jwt', refreshToken: 'r', expiresAt })).toString('base64');
  const tokens = decodeClineCode(code);
  assert.ok(new Date(tokens.expiresAt).getTime() > Date.now(), 'the expiry is in the future, not 1970');
});

test('every Cline endpoint lives under /api/v1', () => {
  // Cline serves its API under /api/v1. Getting the base URL wrong makes the
  // generic `models` path resolve to api.cline.bot/models, which 404s.
  assert.equal(CLINE_OAUTH.apiBasePath, 'https://api.cline.bot/api/v1');
  assert.equal(CLINE_OAUTH.modelsUrl, 'https://api.cline.bot/api/v1/models');
  assert.equal(new URL('models', `${CLINE_OAUTH.apiBasePath}/`).toString(), CLINE_OAUTH.modelsUrl);
  assert.equal(new URL('chat/completions', `${CLINE_OAUTH.apiBasePath}/`).toString(), 'https://api.cline.bot/api/v1/chat/completions');
  for (const url of [CLINE_OAUTH.authorizeUrl, CLINE_OAUTH.tokenUrl, CLINE_OAUTH.refreshUrl, CLINE_OAUTH.modelsUrl, CLINE_OAUTH.accountUrl]) {
    assert.match(url, /^https:\/\/api\.cline\.bot\/api\/v1\//, `${url} is under /api/v1`);
  }
});

test('the catalog is public, so it cannot be what validates a token', async () => {
  // Recorded because it is the reason the two endpoints are used differently:
  // Cline answers 200 on /api/v1/models with no valid token at all.
  const requests = [];
  const adapter = new ClineAdapter({
    transport: {
      async request(request) {
        requests.push(request);
        return { status: 200, headers: new Headers(), data: { data: [] } };
      },
      stream() { throw new Error('not used'); },
    },
  });
  await adapter.validateCredential({ type: 'oauth', value: 'jwt' });
  assert.equal(requests[0].url, CLINE_OAUTH.accountUrl, 'validation uses the endpoint that checks auth');
  assert.notEqual(requests[0].url, CLINE_OAUTH.modelsUrl);
});

test('validating a token calls the account endpoint', async () => {
  const requests = [];
  const adapter = new ClineAdapter({
    transport: {
      async request(request) {
        requests.push(request);
        return { status: 200, headers: new Headers(), data: { data: [] } };
      },
      stream() { throw new Error('not used'); },
    },
  });
  await adapter.validateCredential({ type: 'oauth', value: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.sig' });
  assert.equal(requests[0].url, 'https://api.cline.bot/api/v1/users/me');
  assert.equal(requests[0].headers.Authorization, 'Bearer workos:eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.sig');
});

test('listing models goes to the /api/v1 catalog', async () => {
  const requests = [];
  const adapter = new ClineAdapter({
    transport: {
      async request(request) {
        requests.push(request);
        return { status: 200, headers: new Headers(), data: { data: [{ id: 'anthropic/claude-sonnet-4.6' }] } };
      },
      stream() { throw new Error('not used'); },
    },
  });
  const models = await adapter.listModels({ credential: { type: 'oauth', value: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.sig' } });
  assert.equal(requests[0].url, 'https://api.cline.bot/api/v1/models');
  assert.equal(models.some((m) => m.id === 'anthropic/claude-sonnet-4.6'), true);
});
