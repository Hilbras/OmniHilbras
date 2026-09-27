import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryConnectionStore, createProviderRegistry, loadGatewayConfig } from '../dist/index.js';

/** A secret store that keeps what it is given, so a connect can be refreshed afterwards. */
const secrets = new Map();
const secretStore = {
  get: async (connectionId, providerId) => secrets.get(`${connectionId}:${providerId}`),
  set: async (connectionId, providerId, credential) => {
    secrets.set(`${connectionId}:${providerId}`, credential);
  },
};

/**
 * The ChatGPT connect flow's two halves: checking an export, and saving one.
 *
 * The check opens chatgpt.com and stores nothing, and both are asserted here. Storing would
 * make it a half-connect; not opening the page would make it a button labelled "Check cookie"
 * that accepts a dead session, which is the failure it exists to prevent.
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

/**
 * A service whose ChatGPT Web browser is stubbed out.
 *
 * Verifying a session means opening chatgpt.com, so the driver is replaced through the
 * service's own option. That is what makes these tests cheap; the real browser path is
 * verified by running it, not by a unit test.
 */
function service(options = {}) {
  return new GatewayService(createProviderRegistry(loadGatewayConfig({})), { get: async () => undefined }, undefined, undefined, {
    chatGptWebDriver: {
      available: async () => ({ ok: true }),
      ask: async () => ({ text: '' }),
      verify: async () => ({ ok: true }),
      ...options,
    },
  });
}

test('checking an export verifies the session, reports the models, and stores nothing', async () => {
  // The driver is asked to verify, which is what a button called "Check cookie" has to mean:
  // a parse alone accepts a dead token, so a check that only parsed would be a check that lies.
  let verified = 0;
  const gateway = service({ verify: async () => { verified += 1; return { ok: true }; } });
  const result = await gateway.checkChatGptWeb(export_());
  assert.equal(result.planType, 'free');
  assert.equal(result.isFreePlan, true);
  // The plan is reported, not enforced: a free account is offered the whole set and the page
  // decides. The dialog shows this so the user can see what will be offered before saving.
  assert.equal(result.models.length, 13);
  assert.equal(verified, 1);
  // Nothing was written: the check is the answer to "will this work", not a half-connect.
  assert.equal((await gateway.listConnections()).length, 0);
});

test('a paid export is offered the full ladder', async () => {
  // The thing a user actually wants to know before committing a whole-account session: which
  // models this particular account gets.
  const result = await service().checkChatGptWeb(export_({ account: { planType: 'chatgptplus' } }));
  assert.equal(result.isFreePlan, false);
  assert.equal(result.models.length, 13);
  assert.ok(result.models.some((m) => m.id === 'gpt-5.6-sol-pro'));
  assert.ok(result.models.some((m) => m.id === 'gpt-5.5-pro-extended'));
});

test('an export that does not say its plan is unknown, not free', async () => {
  // Assuming free would hide ten models the account may well be entitled to. Assuming paid
  // would offer eleven it may not be. The honest answer is to say so and show everything.
  const result = await service().checkChatGptWeb(export_({ account: undefined }));
  assert.equal(result.planType, null);
  assert.equal(result.isFreePlan, false);
  assert.equal(result.models.length, 13);
});

test('a paste with no session token is refused by name, not as an auth failure', async () => {
  // A Cookie header with the wrong cookie in it is the most likely bad paste, and saying
  // "unauthorized" would send the user looking for a problem that is not there.
  await assert.rejects(() => service().checkChatGptWeb('some_other_cookie=abc123'), /no __Secure-next-auth\.session-token in it/);
  // The header the dialog tells you to paste is accepted, so the common case is not the
  // one that fails. And because a header carries no plan, the answer is the full set with
  // the plan reported as unstated — the page is the authority on what the account gets.
  const ok = await service().checkChatGptWeb('__Secure-next-auth.session-token=abc; oai-did=xyz');
  assert.equal(ok.planType, null);
  assert.equal(ok.models.length, 13);
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


test('a session the page refuses is reported as itself, not as a successful check', async () => {
  // The whole reason the check opens a page: an expired or challenged session parses fine and
  // only the page knows. Silently passing it is how "connected but every request fails" starts.
  const gateway = service({
    verify: async () => {
      throw Object.assign(new Error('That ChatGPT session has expired. Export a new one.'), {
        code: 'AUTHENTICATION_FAILED',
        publicMessage: 'That ChatGPT session has expired. Export a new one.',
      });
    },
  });
  await assert.rejects(() => gateway.checkChatGptWeb(export_()), /has expired/);
  // And nothing was stored on the way out.
  assert.equal((await gateway.listConnections()).length, 0);
});
