import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

/**
 * `POST /v1/web-cookie/duckduckgo/check` and `/connect`.
 *
 * The point of these two routes is what they do **not** require. Every sibling route under `/v1/web-cookie/`
 * refuses to proceed without a credential, because the service behind it reads one. duck.ai does not read a
 * cookie at all — it gates on an anti-bot challenge — so an absent cookie is this provider's normal case and a
 * present one cannot be verified as good or bad. The tests below assert exactly that, plus the gate.
 */

const FREE_MODELS = [
  { id: 'gpt-5.4-mini', modelName: 'GPT-5.4', accessTier: ['free', 'plus'] },
  { id: 'paid-model', modelName: 'Paid', accessTier: ['plus', 'pro'] },
];

/**
 * A driver the test chooses.
 *
 * `challengeServed` is the only thing the check reads for its verdict, and it stands in for "did the endpoint
 * answer with something this gateway could solve" — the real driver answers that by running the challenge.
 */
function fakeDriver({ challengeServed = true, catalogThrows = false } = {}) {
  const calls = { catalog: 0, status: 0 };
  return {
    calls,
    async available() {
      return { ok: true };
    },
    async catalog() {
      calls.catalog += 1;
      if (catalogThrows) throw new Error('the model listing is unavailable');
      return { models: FREE_MODELS };
    },
    async status() {
      calls.status += 1;
      return { challengeServed, solvedMs: 2 };
    },
    async ask() {
      throw new Error('not used by these routes');
    },
  };
}

async function start(t, { driver = fakeDriver(), requireApiKey = false } = {}) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('duckduckgo-web')).key;
  const store = new InMemoryConnectionStore();
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), store, apiKeys, {
    failureThreshold: 1_000,
    duckDuckGoWebDriver: driver,
  });
  service.setHealthInterval(0);
  if (requireApiKey) await service.setRequireApiKey(true);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return {
    base,
    key,
    store,
    check: (body) => post('/v1/web-cookie/duckduckgo/check', body),
    connect: (body) => post('/v1/web-cookie/duckduckgo/connect', body),
  };
}

test('both routes are behind the management gate, refused before anything is read', async (t) => {
  const gw = await start(t, { requireApiKey: true });
  for (const path of ['check', 'connect']) {
    const response = await fetch(`${gw.base}/v1/web-cookie/duckduckgo/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 401, `${path} must require the admin key`);
  }
});

test('a check with no cookie at all succeeds — the credential is optional here', async (t) => {
  // The regression this pins: requiring `cookieHeader` the way every sibling route does would make a keyless
  // connection impossible and would teach the dashboard that the field is mandatory. The service does not read
  // a cookie, so its absence is not a missing input.
  const gw = await start(t);
  const response = await gw.check({});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.verified, true);
  assert.match(body.note, /No cookie was needed/);
  assert.equal(await gw.store.get('duckduckgo-web'), undefined, 'a check must not save a connection');
});

test('a check with an empty or blank cookie is the same case as no cookie, not a 400', async (t) => {
  // `readOptionalString` trims and maps blank to absent, which is what makes a skipped form field land here
  // rather than being refused by the shared body reader.
  for (const cookieHeader of ['', '   ']) {
    const gw = await start(t);
    const response = await gw.check({ cookieHeader });
    assert.equal(response.status, 200, `a blank paste (${JSON.stringify(cookieHeader)}) must be accepted`);
    assert.match((await response.json()).note, /No cookie was needed/);
  }
});

test('a pasted cookie that is not a cookie is refused as a mistake, not treated as absent', async (t) => {
  // The distinction the service draws: an empty paste is normal, a paste that carries text but reads as no
  // cookie is a user error. Collapsing the two would hide the second one.
  const gw = await start(t);
  const response = await gw.check({ cookieHeader: 'there is no equals sign here' });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, 'AUTHENTICATION_FAILED');
  assert.match(body.error.message, /cookie/i);
});

test('a check that was sent a cookie does not claim the cookie is valid', async (t) => {
  // The service cannot verify a cookie it never reads, so the note must say so. A green "cookie looks valid"
  // on a cookie the endpoint ignored is the exact untruth this repo refuses to ship.
  const gw = await start(t);
  const body = await (await gw.check({ cookieHeader: 'dcs=1; ah=wt-wt' })).json();
  assert.equal(body.verified, true);
  assert.match(body.note, /does not prove the cookie is valid/);
});

test('the check reports the free models, and a listing failure is not an endpoint failure', async (t) => {
  const gw = await start(t);
  const body = await (await gw.check({})).json();
  assert.deepEqual(body.models.map((model) => model.id), ['gpt-5.4-mini'], 'only the free tier is offered');

  const broken = await start(t, { driver: fakeDriver({ catalogThrows: true }) });
  const brokenBody = await (await broken.check({})).json();
  assert.equal(brokenBody.verified, true, 'a model listing that could not be read does not fail the check');
  assert.deepEqual(brokenBody.models, []);
});

test('an endpoint that served no solvable challenge is reported unverified, with the reason', async (t) => {
  const gw = await start(t, { driver: fakeDriver({ challengeServed: false }) });
  const body = await (await gw.check({})).json();
  assert.equal(body.verified, false);
  assert.match(body.note, /without serving an anti-bot challenge/);
});

test('the connect refuses an unsolvable endpoint rather than storing a dead connection', async (t) => {
  const gw = await start(t, { driver: fakeDriver({ challengeServed: false }) });
  const response = await gw.connect({});
  assert.equal(response.status, 502, 'PROVIDER_UNAVAILABLE maps to 502');
  assert.equal(await gw.store.get('duckduckgo-web'), undefined, 'nothing is stored when the check fails');
});

test('the connect stores a keyless connection when no cookie is pasted', async (t) => {
  // The credential is `{ type: 'none' }` and not an absent one: `hasCredential` is what `RoutingEngine.plan`
  // filters on, so a connection with no credential at all would be saved and never routed.
  const gw = await start(t);
  const response = await gw.connect({});
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.connection.providerId, 'duckduckgo-web');
  const saved = await gw.store.get('duckduckgo-web');
  assert.deepEqual(saved, { type: 'none' });
});

test('the connect stores a pasted cookie under the same provider id', async (t) => {
  const gw = await start(t);
  const response = await gw.connect({ cookieHeader: 'dcs=1; ah=wt-wt' });
  assert.equal(response.status, 201);
  const saved = await gw.store.get('duckduckgo-web');
  assert.deepEqual(saved, { type: 'api-key', value: 'dcs=1; ah=wt-wt' });
});

test('the adapter routes a saved keyless connection to the driver', async (t) => {
  // The end of the path the card promises: a connection stored with no secret is still routable, and the turn
  // reaches the adapter rather than being dropped by `hasCredential` in `RoutingEngine`.
  const driver = { ...fakeDriver(), async ask({ messages }) { return { text: messages[0].content, model: 'gpt-5.4-mini' }; } };
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), new InMemoryApiKeyStore(), {
    failureThreshold: 1_000,
    duckDuckGoWebDriver: driver,
  });
  service.setHealthInterval(0);
  await service.connections.save(
    { id: 'duckduckgo-web', providerId: 'duckduckgo-web', name: 'Duck.ai', endpoint: 'https://duck.ai', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'none' },
  );
  const response = await service.chat('duckduckgo-web', { model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'answered without a credential' }] });
  assert.equal(response.message.content, 'answered without a credential', 'a `{ type: \'none\' }` connection must still route');
});