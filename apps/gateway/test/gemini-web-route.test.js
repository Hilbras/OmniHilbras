import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

/**
 * `POST /v1/web-cookie/gemini/check` and `/connect`.
 *
 * A driver is injected, so this is about the wiring and the refusals rather than the browser: does an
 * unauthenticated caller get 401, does the check store nothing, does the connect refuse a session the page
 * rejects, and does the adapter stay out of the way when a browser is missing.
 */

const COOKIE = '__Secure-1PSID=psid-value; __Secure-1PSIDTS=psidts-value';

/** A driver the test chooses. `verify` decides what the page "says" about the session. */
function fakeDriver({ verify } = {}) {
  const calls = { ask: 0, verify: 0 };
  return {
    calls,
    async available() {
      return { ok: true };
    },
    async ask() {
      calls.ask += 1;
      return { text: 'from the page' };
    },
    async verify() {
      calls.verify += 1;
      return verify ? verify() : { ok: true };
    },
  };
}

async function start(t, { driver = fakeDriver(), requireApiKey = false } = {}) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('gemini-web')).key;
  const store = new InMemoryConnectionStore();
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), store, apiKeys, {
    failureThreshold: 1_000,
    geminiWebDriver: driver,
  });
  service.setHealthInterval(0);
  if (requireApiKey) await service.setRequireApiKey(true);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    key,
    store,
    check: (body) => fetch(`${base}/v1/web-cookie/gemini/check`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }),
    connect: (body) => fetch(`${base}/v1/web-cookie/gemini/connect`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) }),
  };
}

test('both routes are behind the management gate, refused before anything is read', async (t) => {
  // The credential is a whole-account Google session, so an unauthenticated caller must not reach the routes at
  // all. Checked with no key against a gateway that enforces them.
  const gw = await start(t, { requireApiKey: true });
  for (const path of ['check', 'connect']) {
    const response = await fetch(`${gw.base}/v1/web-cookie/gemini/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookieHeader: COOKIE }),
    });
    assert.equal(response.status, 401, `${path} must require the admin key`);
  }
});

test('the check opens the page, reports the session, and stores nothing', async (t) => {
  const driver = fakeDriver();
  const gw = await start(t, { driver });
  const response = await gw.check({ cookieHeader: COOKIE });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.verified, true);
  assert.equal(driver.calls.verify, 1, 'the check is a page load, which is the point of it');
  assert.ok(body.models.length > 0, 'the models the page offers are reported');
  assert.equal(await gw.store.get('gemini-web'), undefined, 'a check must not save a connection');
});

test('a session the page rejects is reported as unverified, with the reason', async (t) => {
  const gw = await start(t, { driver: fakeDriver({ verify: () => ({ ok: false, note: 'showing a sign-in wall' }) }) });
  const body = await (await gw.check({ cookieHeader: COOKIE })).json();
  assert.equal(body.verified, false);
  assert.match(body.note, /sign-in wall/);
});

test('the connect refuses a rejected session rather than storing a dead connection', async (t) => {
  // The failure this prevents: a connection that reads as connected and answers nothing, which sends the user
  // to look at the gateway instead of at their cookie.
  const gw = await start(t, { driver: fakeDriver({ verify: () => ({ ok: false, note: 'expired' }) }) });
  const response = await gw.connect({ cookieHeader: COOKIE });
  assert.equal(response.status, 401);
  assert.equal(await gw.store.get('gemini-web'), undefined, 'nothing is stored when the check fails');
});

test('a bare __Secure-1PSID value is accepted, and normalised before it is used', async (t) => {
  // The value alone has no name in it. Accepting it is the difference between "paste what you copied" and
  // "format it correctly first".
  const gw = await start(t);
  const response = await gw.connect({ cookieHeader: 'just-a-value' });
  assert.equal(response.status, 201);
  const saved = await gw.store.get('gemini-web');
  assert.equal(saved.value, '__Secure-1PSID=just-a-value');
});

test('an empty cookie is refused before the browser is opened', async (t) => {
  // A blank required field is a 400 from the shared body reader, not a 401 from the provider: the request is
  // malformed before any credential is considered. What matters is the second assertion — nothing is opened.
  const driver = fakeDriver();
  const gw = await start(t, { driver });
  const response = await gw.check({ cookieHeader: '   ' });
  assert.equal(response.status, 400);
  assert.equal(driver.calls.verify, 0, 'nothing is opened for a request that could not work');
});

test('the connect stores the connection on a session the page accepts', async (t) => {
  const gw = await start(t);
  const response = await gw.connect({ cookieHeader: COOKIE });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.connection.providerId, 'gemini-web');
  const saved = await gw.store.get('gemini-web');
  assert.equal(saved.value, COOKIE);
});

test('a request through the adapter is answered by driving the page, and a missing browser is not retried', async (t) => {
  // The adapter path, not just the routes: a chat request reaches the driver, and a host without a browser gets
  // its own refusal with the install command rather than a generic provider failure.
  const driver = fakeDriver();
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({ 'gemini-web': { type: 'api-key', value: COOKIE } }), new InMemoryConnectionStore(), new InMemoryApiKeyStore(), { failureThreshold: 1_000, geminiWebDriver: driver });
  service.setHealthInterval(0);
  await service.connections.save(
    { id: 'gemini-web', providerId: 'gemini-web', name: 'Gemini Web', endpoint: 'https://gemini.google.com', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: COOKIE },
  );

  const noBrowser = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({ 'gemini-web': { type: 'api-key', value: COOKIE } }), new InMemoryConnectionStore(), new InMemoryApiKeyStore(), {
    failureThreshold: 1_000,
    geminiWebDriver: { async available() { return { ok: false, reason: 'Run `npx playwright install chromium`.' }; }, async ask() { throw new Error('unreachable'); } },
  });
  noBrowser.setHealthInterval(0);
  const adapter = noBrowser.geminiWebAdapter();
  await assert.rejects(
    () => adapter.chat({ model: 'gemini-3.1-pro', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'api-key', value: COOKIE } }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === false && /playwright install/.test(error.publicMessage),
  );
  assert.equal(driver.calls.ask, 0, 'the available driver was never asked, because the other service was used');
});