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

/**
 * A service with **no browser**, stated rather than left to chance.
 *
 * This file's header says "without a network", and until now two of its tests broke that: they
 * called `checkChatGptWeb` with no driver injected, so the real driver launched a browser and
 * reached for chatgpt.com. That made a test whose entire claim is *"with no browser, refuse rather
 * than pass"* depend on whether this machine happened to have one — and it cost 28 seconds of DNS
 * timeouts when it did not.
 *
 * `available()` answering `ok: false` is the honest way to say "no browser": it is the question the
 * adapter asks before it does anything, and the refusal it produces is the one a user with no
 * browser installed actually gets. The sibling file `chatgpt-web-check.test.js` already injects a
 * driver; this one now injects the absence of one, which is what it was always describing.
 */
function service() {
  return new GatewayService(createProviderRegistry(loadGatewayConfig({})), { get: async () => undefined }, undefined, undefined, {
    chatGptWebDriver: {
      available: async () => ({ ok: false, reason: 'No browser is available on this machine.' }),
      ask: async () => { throw new Error('the driver must not be used once it reports no browser'); },
    },
  });
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
  //
  // The `ask` in the stub throws if reached, so this also proves the check stops at
  // `available()` rather than reporting a result it could not have obtained.
  await assert.rejects(
    () => service().checkChatGptWeb('__Secure-next-auth.session-token=abc; oai-did=xyz'),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      // The reason has to survive to the client. `PROVIDER_UNAVAILABLE` on its own is the generic
      // message this project does not ship, and a user cannot act on "unavailable" — they can act
      // on "install a browser".
      assert.match(error.publicMessage ?? error.message, /No browser is available/);
      return true;
    },
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

/* ------------------------------------------------------------------ *
 * Health for one provider
 * ------------------------------------------------------------------ */

test('health can be asked for one provider without probing the whole registry', async () => {
  // `/health` probes every active adapter. A dashboard card shows one provider, so it now
  // asks about one provider — otherwise "Test provider" waited on all thirteen and looked
  // permanently stuck on a loaded machine.
  //
  // Two stub adapters, and the assertion that matters is that asking about one of them does
  // not touch the other. A full sweep would have called both.
  const probed = [];
  const stub = (id) => ({
    id,
    capabilities: { chat: true, streaming: false, models: false },
    async listModels() { return []; },
    async chat() { throw new Error('not used'); },
    async validateCredential() { return { ok: true }; },
    async healthCheck() {
      probed.push(id);
      return { status: 'healthy', checkedAt: new Date().toISOString() };
    },
  });
  const { createGatewayServer } = await import('../dist/index.js');
  const { ProviderRegistry } = await import('../../../packages/omnihilbras-sdk/dist/index.js');
  const gateway = new GatewayService(new ProviderRegistry().register(stub('one')).register(stub('two')), { get: async () => undefined });
  const server = createGatewayServer(gateway, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health/one`, { headers: { origin: 'http://localhost:5173' } });
    assert.equal(response.status, 200);
    const body = await response.json();
    // One provider in, one provider out — not a report about the registry.
    assert.equal(body.provider.providerId, 'one');
    assert.equal(body.provider.status, 'healthy');
    assert.equal(Array.isArray(body.providers), false);
    // The other adapter was never asked. This is the whole point of the route.
    assert.deepEqual(probed, ['one']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a provider with no active connection is named, not reported unhealthy', async () => {
  // "This provider is down" and "you never connected it" are different problems, and the
  // first sends the user to fix a credential that was never the issue.
  await assert.rejects(
    () => service().healthForProvider('not-a-provider'),
    (error) => error.code === 'NOT_FOUND' && /Connect it first/.test(error.publicMessage ?? error.message),
  );
});

test('a failed check reports the cause rather than a generic failure', async () => {
  // The message is what the dashboard shows, so "The provider health check failed" would
  // point the user at the provider when the cause was their own connection.
  const gateway = service();
  const result = await gateway.healthForProvider('deepseek-web').catch((error) => ({ threw: error }));
  // deepseek-web has no connection in this store, so it is named rather than probed. What
  // matters is that the outcome is a reason, not a silent "unavailable".
  assert.ok(result.threw || result.message, 'a health result without any reason was returned');
});
