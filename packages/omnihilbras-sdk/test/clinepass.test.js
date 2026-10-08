import assert from 'node:assert/strict';
import test from 'node:test';
import { CLINE_PASS_MODEL_PREFIX, ClinePassAdapter, ProviderError, clinePassFailureReason } from '@hilbras/omnihilbras';

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

const key = { type: 'api-key', value: 'a-key-that-is-not-a-jwt' };

test('the key is sent verbatim as a bearer token, with Cline’s client headers', async () => {
  const transport = stubTransport({ 'https://api.cline.bot/api/v1/users/me': { data: { id: 'acc_1' } } });
  const adapter = new ClinePassAdapter({ transport });

  const result = await adapter.validateCredential(key);

  assert.equal(result.status, 'valid');
  const sent = transport.requests[0];
  assert.equal(sent.headers.Authorization, 'Bearer a-key-that-is-not-a-jwt');
  // A non-JWT must not be given the `workos:` prefix. Doing so would produce a key-shaped value the
  // API has never seen, and the 401 that follows reads like a wrong key rather than a rewritten one.
  assert.equal(sent.headers['X-CLIENT-TYPE'], 'OmniHilbras');
  assert.equal(sent.headers['HTTP-Referer'], 'https://cline.bot');
  assert.ok(sent.headers['X-CLIENT-VERSION'], 'the client version Cline attributes the request by is required');
});

test('only ClinePass models are listed, so a connection cannot offer the free tier', async () => {
  const transport = stubTransport({
    'https://api.cline.bot/api/v1/models': {
      data: {
        data: [
          { id: 'cline-pass/qwen3.7-max' },
          { id: 'cline/gpt-5' },
          { id: 'cline-pass/glm-5.3' },
        ],
      },
    },
  });
  const adapter = new ClinePassAdapter({ transport });

  const models = await adapter.listModels({ credential: key });

  assert.deepEqual(models.map((model) => model.id), ['cline-pass/qwen3.7-max', 'cline-pass/glm-5.3']);
  assert.ok(models.every((model) => model.id.startsWith(CLINE_PASS_MODEL_PREFIX)));
  assert.ok(models.every((model) => model.providerId === 'clinepass'));
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
    () => adapter.chat({ model: 'cline-pass/qwen3.7-max', messages: [{ role: 'user', content: 'hi' }] }, { credential: key }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      // The provider id is what the operator acts on. Reading `cline` here would send them to fix the
      // wrong connection, and the two are stored separately.
      assert.equal(error.providerId ?? error.details?.providerId, 'clinepass');
      assert.match(error.message, /subscribe to clinepass/);
      return true;
    },
  );
});

test('a missing key is refused before any request is made', async () => {
  const transport = stubTransport({});
  const adapter = new ClinePassAdapter({ transport });

  await assert.rejects(
    () => adapter.validateCredential(undefined),
    (error) => {
      assert.equal(error.code, 'AUTHENTICATION_FAILED');
      // "Sign in again" is the wrong instruction here: ClinePass has no sign-in in this product.
      assert.match(error.message, /API key is required/);
      return true;
    },
  );
  assert.equal(transport.requests.length, 0, 'an empty key must not reach the network');
});

test('the health check carries the reason, and never claims a key has not expired', async () => {
  const refused = stubTransport({
    'https://api.cline.bot/api/v1/users/me': new ProviderError('AUTHENTICATION_FAILED', 'no', { providerId: 'clinepass' }),
  });
  const health = await new ClinePassAdapter({ transport: refused }).healthCheck({ credential: key });

  assert.equal(health.status, 'unavailable');
  assert.equal(health.verified, 'credential');
  assert.match(health.message, /rejected the key/);

  // `undefined`, not `false`. An API key has no expiry to read, and reporting `false` would let a
  // revoked key look healthy for as long as the gateway ran.
  assert.equal(new ClinePassAdapter().isCredentialExpired(key), undefined);
  assert.equal(clinePassFailureReason(new Error('boom')), 'The ClinePass health check failed.');
});
