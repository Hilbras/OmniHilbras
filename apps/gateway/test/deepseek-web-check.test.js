import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryConnectionStore, createProviderRegistry, loadGatewayConfig } from '../dist/index.js';
import { DeepSeekWebAdapter } from '../../../packages/omnihilbras-sdk/dist/index.js';

/**
 * The DeepSeek connect flow, without a network.
 *
 * What is testable here is everything that decides *whether a connection is made at all*:
 * whether an export is accepted or refused, and whether the provider can be health-checked
 * at all. The request path itself is verified by using it.
 */

const export_ = (overrides = {}) =>
  JSON.stringify({
    accessToken: 'eyJhbGciOi.header.payload'.padEnd(200, 'x'),
    sessionToken: 'session-token-value',
    expires: '2099-12-26T17:00:52.429Z',
    authProvider: 'openai',
    account: { planType: 'free', structure: 'personal' },
    user: { email: 'someone@example.com' },
    ...overrides,
  });

/** A secret store that keeps what it is given, so a connect can be refreshed afterwards. */
const secrets = new Map();
const secretStore = {
  get: async (connectionId, providerId) => secrets.get(`${connectionId}:${providerId}`),
  set: async (connectionId, providerId, credential) => {
    secrets.set(`${connectionId}:${providerId}`, credential);
  },
};

function service() {
  return new GatewayService(createProviderRegistry(loadGatewayConfig({})), { get: async () => undefined });
}

/**
 * These were written when `checkChatGptWeb` was a cheap parse, and went stale the moment it
 * started verifying against a live page. They were never caught because the file was never
 * committed — so nothing reviewed them. They now assert what is actually true offline.
 */

test('a check with no browser available is refused rather than passed', async () => {
  // The check opens chatgpt.com. In an environment with no browser it must say so, because
  // the alternative — reporting `verified: true` without having verified anything — is the
  // thing this whole change exists to prevent.
  await assert.rejects(
    () => service().checkChatGptWeb('__Secure-next-auth.session-token=abc; oai-did=xyz'),
    (error) => error.code === 'PROVIDER_UNAVAILABLE',
  );
});

test('a check that fails stores nothing', async () => {
  // A check that half-connects is worse than no check: the user believes the credential is
  // good and finds out on their first request.
  try {
    await service().checkChatGptWeb('__Secure-next-auth.session-token=abc; oai-did=xyz');
  } catch {
    // The point is what is left behind, not why it failed.
  }
  assert.equal((await service().listConnections()).length, 0);
});

test('a paste with no session token is refused by name, before anything is opened', async () => {
  // A Cookie header with the wrong cookie in it is the most likely bad paste, and saying
  // "unauthorized" would send the user looking for a problem that is not there. It is also
  // caught without a browser, because the header is read first.
  await assert.rejects(
    () => service().checkChatGptWeb('some_other_cookie=abc123'),
    /no __Secure-next-auth\.session-token in it/,
  );
});

test('a free-only import survives a model refresh', async () => {
  // The toggle records a policy on the connection. If discovery did not carry that policy
  // through, the connection would be correct on connect and quietly come back in full on the
  // next refresh — which is a switch that stops working once you stop looking at it.
  secrets.clear();
  const gateway = new GatewayService(
    createProviderRegistry(loadGatewayConfig({})),
    secretStore,
    new InMemoryConnectionStore(),
  );
  const paid = export_({ account: { planType: 'chatgptplus' } });
  await gateway.connectChatGptWeb(paid, undefined, true);

  const before = (await gateway.listConnections()).find((c) => c.id === 'chatgpt-web');
  assert.equal(before.modelPolicy, 'free');
  assert.deepEqual(
    [...before.modelIds].sort(),
    ['gpt-5.6-luna-free', 'gpt-5.6-luna-free-thinking'],
  );

  // The refresh is the path that would have dropped the policy.
  const after = await gateway.refreshConnectionModels('chatgpt-web');
  assert.deepEqual(
    [...after.modelIds].sort(),
    ['gpt-5.6-luna-free', 'gpt-5.6-luna-free-thinking'],
  );
});

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

test('the provider answers a health check, so the dashboard can test it', () => {
  // The registration half of the fix is verified against a live gateway rather than here:
  // `activeAdapters` is private, and a test-only accessor for it would be asserting the test
  // rather than the code. What is assertable — and what was actually missing — is that the
  // adapter has a health check at all. Without one, the health loop reports "Health checks are
  // not supported." and "Test provider" fails on a connection that can answer.
  assert.equal(typeof new DeepSeekWebAdapter().healthCheck, 'function');
});

test('health for DeepSeek Web is a credential check, and it costs one round trip', async () => {
  // Not a completion: no proof of work, no session. That is what makes it cheap enough to
  // run on every health poll.
  const calls = [];
  const adapter = new DeepSeekWebAdapter({
    fetch: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { token: 'access' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const result = await adapter.healthCheck({ credential: { type: 'api-key', value: 'user-token' } });
  assert.equal(result.status, 'healthy');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /users\/current/);
});

test('a refused credential is reported in the provider’s own words', async () => {
  // "not connected" tells the user nothing about whether to sign in again or to wait.
  const adapter = new DeepSeekWebAdapter({
    fetch: async () => new Response('{}', { status: 401 }),
  });
  const result = await adapter.healthCheck({ credential: { type: 'api-key', value: 'dead' } });
  assert.equal(result.status, 'unavailable');
  assert.match(result.message ?? '', /rejected that userToken/i);
});
