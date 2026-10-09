import assert from 'node:assert/strict';
import test from 'node:test';
import { CLINE_PASS_MODEL_PREFIX, ClinePassAdapter, ProviderError } from '@hilbras/omnihilbras';

/**
 * A transport that records what was sent and answers from a routing table.
 *
 * `ProviderError` is returned rather than thrown for the error cases because that is what
 * `FetchHttpTransport` does with a 4xx — the adapter sees a thrown error and has to decide whether it
 * is an auth failure, and a mock that threw a bare `Error` would let a broken mapping pass.
 */
function stubTransport(routes) {
  const requests = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      const route = routes[request.url];
      if (!route) throw new Error(`unstubbed ${request.method} ${request.url}`);
      if (route instanceof Error) throw route;
      return { status: route.status ?? 200, headers: new Headers(), data: route.data };
    },
    stream() {
      throw new Error('not used');
    },
  };
}

// A Cline token, because ClinePass shares Cline's one credential — it is the same account, reached by
// the same sign-in. It is a WorkOS JWT, so it is sent with the `workos:` prefix Cline requires.
const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
const token = { type: 'oauth', value: jwt, refreshToken: 'r1', expiresAt: '2030-01-01T00:00:00.000Z' };

test('a ClinePass request carries Cline’s client headers and the shared token', async () => {
  const transport = stubTransport({ 'https://api.cline.bot/api/v1/users/me': { data: { id: 'acc_1' } } });
  const adapter = new ClinePassAdapter({ transport });

  const result = await adapter.validateCredential(token);

  assert.equal(result.status, 'valid');
  const sent = transport.requests[0];
  assert.equal(sent.headers.Authorization, `Bearer workos:${jwt}`);
  assert.equal(sent.headers['X-CLIENT-TYPE'], 'OmniHilbras');
  assert.equal(sent.headers['HTTP-Referer'], 'https://cline.bot');
  assert.ok(sent.headers['X-CLIENT-VERSION'], 'the client version Cline attributes the request by is required');
});

test('an expired shared token is renewed, so a ClinePass connection keeps working', async () => {
  // The reason this adapter subclasses ClineAdapter: a shared connection carries Cline's OAuth token
  // with its own expiry, so without inheritance a ClinePass request would send a dead token verbatim.
  const requests = [];
  const refreshed = [];
  const adapter = new ClinePassAdapter({
    transport: {
      async request(request) {
        requests.push(request);
        if (request.url.endsWith('/auth/refresh')) {
          return { status: 200, headers: new Headers(), data: { success: true, data: { accessToken: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIyIn0.new', refreshToken: 'r2', expiresAt: '2030-01-01T00:00:00.000Z' } } };
        }
        return { status: 200, headers: new Headers(), data: { id: 'acc_1' } };
      },
      stream() { throw new Error('not used'); },
    },
    onTokensRefreshed: (tokens) => { refreshed.push(tokens); },
    refreshSkewMs: 0,
  });

  await adapter.validateCredential({ type: 'oauth', value: jwt, refreshToken: 'r1', expiresAt: '2020-01-01T00:00:00.000Z' });

  assert.equal(requests[0].url, 'https://api.cline.bot/api/v1/auth/refresh');
  assert.equal(refreshed.length, 1, 'the renewed token is written back to the one shared vault entry');
  assert.equal(requests[1].headers.Authorization, 'Bearer workos:eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIyIn0.new');
});

test('the ClinePass list is the recommended feed’s clinePass tier, so the free tier cannot leak in', async () => {
  // The general catalog is not the list: for an unsubscribed account it carries no `cline-pass/` ids, and
  // Cline's own client reads this feed for the tier. Only the clinePass tier is taken, filtered to the prefix.
  const transport = stubTransport({
    'https://api.cline.bot/api/v1/ai/cline/recommended-models': {
      data: {
        recommended: [{ id: 'anthropic/claude-sonnet-5.5' }],
        free: [{ id: 'cline-free/mimo-v2.6-flash' }],
        clinePass: [{ id: 'cline-pass/qwen3.7-max' }, { id: 'cline-pass/glm-5.3' }, { id: 'cline-pass/qwen3.7-max' }],
      },
    },
  });
  const adapter = new ClinePassAdapter({ transport });

  const models = await adapter.listModels({ credential: token });

  assert.deepEqual(models.map((model) => model.id), ['cline-pass/qwen3.7-max', 'cline-pass/glm-5.3']);
  assert.ok(models.every((model) => model.id.startsWith(CLINE_PASS_MODEL_PREFIX)));
  assert.ok(models.every((model) => model.providerId === 'clinepass'));
  assert.equal(transport.requests[0].url, 'https://api.cline.bot/api/v1/ai/cline/recommended-models');
});

test('an account with no ClinePass tier gets an empty list, not the general catalog', async () => {
  const transport = stubTransport({
    'https://api.cline.bot/api/v1/ai/cline/recommended-models': { data: { recommended: [], free: [], clinePass: [] } },
  });
  assert.deepEqual(await new ClinePassAdapter({ transport }).listModels({ credential: token }), []);
});

test('a chat failure is reported as ClinePass and keeps what Cline said', async () => {
  const transport = stubTransport({
    'https://api.cline.bot/api/v1/chat/completions': {
      status: 200,
      data: { success: false, message: 'no access to clinepass subscription models yet. subscribe to clinepass' },
    },
  });
  const adapter = new ClinePassAdapter({ transport });

  await assert.rejects(
    () => adapter.chat({ model: 'cline-pass/qwen3.7-max', messages: [{ role: 'user', content: 'hi' }] }, { credential: token }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      // The provider id is what the operator acts on. Reading `cline` here would send them to the wrong
      // card, and the two are distinct cards even though they share one credential.
      assert.equal(error.providerId ?? error.details?.providerId, 'clinepass');
      assert.match(error.message, /subscribe to clinepass/);
      return true;
    },
  );
});

test('a missing token is refused before any request is made', async () => {
  const transport = stubTransport({});
  const adapter = new ClinePassAdapter({ transport });

  await assert.rejects(
    () => adapter.validateCredential(undefined),
    (error) => {
      assert.equal(error.code, 'AUTHENTICATION_FAILED');
      // The remedy is to sign into Cline — ClinePass has no sign-in of its own but is not keyless.
      assert.match(error.message, /Cline access token is required/);
      return true;
    },
  );
  assert.equal(transport.requests.length, 0, 'an empty token must not reach the network');
});

test('the health check names the live token, and a failure says why', async () => {
  const refused = stubTransport({
    'https://api.cline.bot/api/v1/users/me': new ProviderError('AUTHENTICATION_FAILED', 'no', { providerId: 'clinepass' }),
  });
  const health = await new ClinePassAdapter({ transport: refused }).healthCheck({ credential: token });

  assert.equal(health.status, 'unavailable');
  assert.equal(health.verified, 'credential');
  // Named ClinePass, not Cline, and it keeps the instruction that is actually correct here: ClinePass
  // shares Cline's sign-in, so "sign in again" is the right remedy in a way it was not when this was a
  // pasted key.
  assert.match(health.message, /ClinePass rejected the token/);
  assert.match(health.message, /sign in again/i);
});
