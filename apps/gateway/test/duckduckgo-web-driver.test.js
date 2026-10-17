import assert from 'node:assert/strict';
import test from 'node:test';
import { createDuckDuckGoWebDriver } from '../dist/duckduckgoWeb.js';

/**
 * The Duck.ai driver, driven by a scripted `fetch`.
 *
 * ## Why the network is not used here
 *
 * The endpoint is rate limited **per address**, and the failures worth testing — a `418 ERR_CHALLENGE`, an
 * `ERR_BN_LIMIT`, the rotated-challenge path — are the ones the live service only sends when it feels like it.
 * Provoking them deliberately costs the anonymous-chat quota that the real turns need, and a test that spent
 * it would be a test that makes the product worse by running. So the protocol was proven live once, by hand
 * (recorded in `tasks/todo.md`), and every branch is exercised here against a scripted response.
 *
 * ## What is actually asserted
 *
 * The two things that must not regress and cannot be seen from the outside: **the raw challenge is never
 * sent** (an unsolved value is answered with 418 and still costs a request), and **a page without the version
 * attributes refuses the turn** rather than falling back to a stale version — which is the defect the source
 * implementation shipped for its entire life.
 */

const HOME = `<html lang="en-US" data-version-tag="serp_20261016_162040_ET" data-version-sha="69b477470b6e1e9a59d7b38f6a2ba83ab3fdd747" class="react">`;
/** A challenge the solver can actually run: the real one is opaque, but its *contract* is three fields. */
const CHALLENGE = Buffer.from(
  `(async function(){ return { client_hashes: ['probe-hash-one'], server_hashes: [], meta: { v: 'fixture' } }; })()`,
  'utf8',
).toString('base64');

const CATALOG = { models: [{ id: 'gpt-5.4-mini', modelName: 'GPT-5.4', accessTier: ['free'] }] };

function scripted(routes) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    seen.push({ path: pathname, method: init.method ?? 'GET', headers, body: init.body });
    const route = routes[pathname];
    if (route === undefined) throw new Error(`the driver asked for an unexpected path: ${pathname}`);
    return typeof route === 'function' ? route(init) : route;
  };
  return { seen, fetchImpl };
}

const htmlResponse = (body, headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sseResponse = (body, headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });

/** The stream as it really arrives: a title pseudo-event first, then cumulative `message` frames. */
const REAL_STREAM = ['data: [CHAT_TITLE:probe]', '', 'data: {"action":"success","message":"por"}', '', 'data: {"message":"t-ok"}', '', 'data: [DONE]', ''].join('\n');

const routesWith = (over = {}) => ({
  '/': () => htmlResponse(HOME),
  '/duckchat/v1/status': () => new Response('{"status":"0"}', { status: 200, headers: { 'x-vqd-hash-1': CHALLENGE } }),
  '/duckchat/v1/chat': () => sseResponse(REAL_STREAM),
  '/duckchat/v1/models': () => jsonResponse(CATALOG),
  ...over,
});

test('a turn assembles the answer from `message` frames and drops the pseudo-events', async () => {
  const { seen, fetchImpl } = scripted(routesWith());
  const driver = createDuckDuckGoWebDriver({ fetch: fetchImpl });

  const result = await driver.ask({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'Reply with exactly: port-ok' }], timeoutMs: 5_000 });

  assert.equal(result.text, 'port-ok', 'the answer comes from `message`, which is where this service puts it');
  assert.equal(result.model, 'gpt-5.4-mini');
  // Homepage, status, chat — in that order, and nothing else.
  assert.deepEqual(seen.map((request) => request.path), ['/', '/duckchat/v1/status', '/duckchat/v1/chat']);
});

test('the solved challenge is sent, and the raw one never is', async () => {
  const { seen, fetchImpl } = scripted(routesWith());
  const driver = createDuckDuckGoWebDriver({ fetch: fetchImpl });
  await driver.ask({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5_000 });

  const chat = seen.find((request) => request.path === '/duckchat/v1/chat');
  const sent = chat.headers['x-vqd-hash-1'];
  assert.ok(sent, 'the header must be present');
  assert.notEqual(sent, CHALLENGE, 'the raw challenge must never be forwarded — 418, and the call still costs quota');

  // And what was sent is the solved payload: the three fields the service checks, with hashes it did not give.
  const decoded = JSON.parse(Buffer.from(sent, 'base64').toString('utf8'));
  assert.equal(decoded.client_hashes.length, 1);
  assert.notEqual(decoded.client_hashes[0], 'probe-hash-one', 'the hashes are re-encoded');
  assert.equal(decoded.meta.origin, 'https://duck.ai');
  assert.ok(decoded.meta.stack.length > 0);
});

test('the version token is assembled from the two attributes, and its absence refuses the turn', async () => {
  const { seen, fetchImpl } = scripted(routesWith());
  const driver = createDuckDuckGoWebDriver({ fetch: fetchImpl });
  await driver.ask({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5_000 });

  const chat = seen.find((request) => request.path === '/duckchat/v1/chat');
  assert.equal(chat.headers['x-fe-version'], 'serp_20261016_162040_ET-69b477470b6e1e9a59d7b38f6a2ba83ab3fdd747');

  // A page without either attribute is "cannot say". A stale version looks like a measurement, which is
  // exactly what the source implementation shipped: it never matched, and sent an old hardcoded value on
  // every single request.
  const { fetchImpl: staleFetch } = scripted(routesWith({ '/': () => htmlResponse('<html class="react">') }));
  const stale = createDuckDuckGoWebDriver({ fetch: staleFetch });
  await assert.rejects(
    () => stale.ask({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5_000 }),
    /data-version-tag/,
  );
});

test('a cookie is sent when there is one, and no Cookie header when there is not', async () => {
  // A name that is **not** one of the five seeded cookies, so "the paste arrived" cannot be confused with
  // "the jar was seeded" — which is exactly how my first version of this test passed while proving nothing.
  const pasted = 'my_session=abc123; cf_clearance=def456';
  for (const [cookieHeader, expected] of [[undefined, undefined], [pasted, pasted]]) {
    const { seen, fetchImpl } = scripted(routesWith());
    const driver = createDuckDuckGoWebDriver({ fetch: fetchImpl });
    await driver.ask({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5_000, ...(cookieHeader ? { cookieHeader } : {}) });
    const chat = seen.find((request) => request.path === '/duckchat/v1/chat');
    // The jar is never empty — it carries the five values the real page has before it signs anything — so the
    // assertion is about the *pasted* pair, not about the presence of a header.
    if (expected === undefined) assert.doesNotMatch(chat.headers.cookie ?? '', /my_session=abc123/);
    else assert.match(chat.headers.cookie, /my_session=abc123/);
  }
});

test('the request body carries the mandatory effort and a real RSA key', async () => {
  const { seen, fetchImpl } = scripted(routesWith());
  const driver = createDuckDuckGoWebDriver({ fetch: fetchImpl });
  await driver.ask({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5_000 });

  const chat = seen.find((request) => request.path === '/duckchat/v1/chat');
  const body = JSON.parse(chat.body);
  assert.equal(body.model, 'gpt-5.4-mini');
  // Sent on every request: the source records a 400 without it, and every request that succeeded sent it.
  assert.equal(body.reasoningEffort, 'none');
  assert.deepEqual(body.metadata.toolChoice, { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false });
  // Generated here rather than in the SDK, because `node:crypto` may not enter anything the dashboard loads.
  assert.equal(body.durableStream.publicKey.kty, 'RSA');
  assert.equal(body.durableStream.publicKey.alg, 'RSA-OAEP-256');
  assert.equal(body.durableStream.publicKey.n.length > 100, true, 'a real modulus, not a placeholder');
  assert.match(body.durableStream.messageId, /^[0-9a-f-]{36}$/);
});

test('each refusal is classified by its type field, not by its prose', async () => {
  // `ERR_CHALLENGE` and `ERR_BN_LIMIT` share a user-facing message token in the service's own client, so a
  // regex over the body would conflate an expired challenge with an address-level refusal. Only one of those
  // is worth waiting out, and only one is worth the operator's attention.
  const cases = [
    [418, { action: 'error', status: 418, type: 'ERR_CHALLENGE', overrideCode: 'd78d' }, 'challenge'],
    [418, { action: 'error', status: 418, type: 'ERR_BN_LIMIT' }, 'quota'],
    [403, { action: 'error', type: 'ERR_BN_LIMIT' }, 'quota'],
    [429, { action: 'error', type: 'ERR_RATE_LIMIT' }, 'rate-limit'],
    [400, { action: 'error', type: 'ERR_BAD_REQUEST' }, 'bad-request'],
    [500, { message: 'boom' }, 'unavailable'],
  ];
  for (const [status, body, kind] of cases) {
    const { fetchImpl } = scripted(routesWith({ '/duckchat/v1/chat': () => jsonResponse(body, status) }));
    const driver = createDuckDuckGoWebDriver({ fetch: fetchImpl });
    await assert.rejects(
      () => driver.ask({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5_000 }),
      (error) => {
        assert.equal(error.kind, kind, `${status} ${body.type ?? ''} should be ${kind}, got ${error.kind} in ${error.message}`);
        return true;
      },
    );
  }
});

test('a 418 carries the override code a support question needs', async () => {
  const { fetchImpl } = scripted(routesWith({ '/duckchat/v1/chat': () => jsonResponse({ action: 'error', type: 'ERR_CHALLENGE', overrideCode: 'd78d' }, 418) }));
  const driver = createDuckDuckGoWebDriver({ fetch: fetchImpl });
  await assert.rejects(() => driver.ask({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5_000 }), (error) => {
    assert.equal(error.overrideCode, 'd78d');
    assert.match(error.message, /d78d/);
    return true;
  });
});

test('a 200 with no text in it is a failure, not an empty answer', async () => {
  // The service sends `{"action":"success","message":"OK"}` before the answer. A reader that returned on the
  // first frame would hand back an empty string and let the caller believe a turn happened.
  const { fetchImpl } = scripted(routesWith({ '/duckchat/v1/chat': () => sseResponse('data: {"action":"success"}\n\ndata: [DONE]\n') }));
  const driver = createDuckDuckGoWebDriver({ fetch: fetchImpl });
  await assert.rejects(() => driver.ask({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5_000 }), (error) => {
    assert.equal(error.kind, 'unavailable');
    assert.match(error.message, /no text/);
    return true;
  });
});

test('a status with no challenge is reported, and a turn without one is refused', async () => {
  const { fetchImpl } = scripted(routesWith({ '/duckchat/v1/status': () => new Response('{"status":"0"}', { status: 200 }) }));
  const driver = createDuckDuckGoWebDriver({ fetch: fetchImpl });

  // `status` reports the fact: the service decided this request needed no proof.
  assert.deepEqual(await driver.status({ timeoutMs: 5_000 }), { challengeServed: false, solvedMs: 0 });

  // But a *turn* cannot proceed without one: there is nothing to prove the request with, and sending it
  // anyway is the 418 that costs quota.
  await assert.rejects(() => driver.ask({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], timeoutMs: 5_000 }), (error) => {
    assert.equal(error.kind, 'challenge');
    return true;
  });
});

test('the catalog is read with no handshake and no credential', async () => {
  // The one endpoint this service leaves open, and the reason a model list can be read before anything is
  // spent. It must not fetch a challenge first.
  const { seen, fetchImpl } = scripted(routesWith());
  const driver = createDuckDuckGoWebDriver({ fetch: fetchImpl });
  const catalog = await driver.catalog({ timeoutMs: 5_000 });
  assert.deepEqual(catalog, CATALOG);
  assert.deepEqual(seen.map((request) => request.path), ['/duckchat/v1/models']);
});

test('the driver reports itself available, because a vm needs nothing installed', async () => {
  // Unlike the browser drivers, there is no external requirement to be missing — and saying so is what keeps
  // "unavailable" meaning "the service refused us" rather than "this host is not set up".
  const driver = createDuckDuckGoWebDriver({ fetch: async () => new Response('', { status: 200 }) });
  assert.deepEqual(await driver.available(), { ok: true });
});