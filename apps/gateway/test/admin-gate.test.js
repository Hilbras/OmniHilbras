import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, LocalApiKeyStore, createGatewayServer } from '../dist/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The management surface must require the key when key enforcement is on.
 *
 * ## What this exists for
 *
 * `handleInferenceRoute` was the only consumer of `ctx.auth` in the entire route layer. It gated
 * `/v1/models` and `/v1/chat/completions`; nothing else checked anything. The routes that **mint credentials**
 * and **switch the gate off** therefore sat outside it entirely.
 *
 * Measured against a running gateway with no `Origin` and no `Authorization` — a plain local process:
 *
 * ```
 * 200  GET  /v1/connections                    → every configured connection and its endpoint
 * 201  POST /v1/keys                           → {"key":"ohk_..."}, the full secret
 * 200  PUT  /v1/settings/require-api-key       → {"requireApiKey":false}
 * ```
 *
 * The minted key is accepted by the one gate that does exist, so minting alone is a full bypass of the
 * LLM surface — and disabling enforcement needs no credential at all, and persists.
 *
 * ## The property, not the route list
 *
 * Asserted over the prefixes rather than by enumerating every route, because the failure mode being
 * guarded is *a route added later that forgets*. A new management route under a known prefix is covered
 * automatically; a genuinely new prefix must be added to `MANAGEMENT_PREFIXES`, and the first test fails if
 * that list and the router disagree.
 */

/** Starts a gateway on an ephemeral port with key enforcement explicitly on or off. */
async function startGateway(t, { enforced, store } = {}) {
  const apiKeys = store ?? new InMemoryApiKeyStore();
  if (enforced !== undefined) await apiKeys.setEnforced(enforced);
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({ ollama: { type: 'api-key', value: 'x' } }), new InMemoryConnectionStore(), apiKeys);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base, apiKeys, service };
}

/** A request with no Origin and no Authorization — what any local process can send. */
function bare(base, method, path, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

const MANAGEMENT = [
  ['GET', '/v1/connections'],
  ['POST', '/v1/keys', { name: 'probe' }],
  ['PUT', '/v1/settings/require-api-key', { requireApiKey: false }],
];

test('the management surface refuses an unauthenticated caller when enforcement is on', async (t) => {
  const { base } = await startGateway(t, { enforced: true });
  for (const [method, path, body] of MANAGEMENT) {
    const response = await bare(base, method, path, body);
    assert.equal(response.status, 401, `${method} ${path} answered ${response.status} with no credential`);
    const payload = await response.json();
    assert.match(JSON.stringify(payload), /API key/i, `${method} ${path} must say what is missing`);
  }
});

test('a minted key is what opens the management surface', async (t) => {
  // Minted with enforcement OFF, because that is the only way to obtain the first key — a bootstrap
  // step. Everything after it is gated.
  const { base, apiKeys } = await startGateway(t, { enforced: false });
  const created = await apiKeys.create('operator');
  const auth = { authorization: `Bearer ${created.key}`, 'content-type': 'application/json' };

  await apiKeys.setEnforced(true);

  const refused = await bare(base, 'GET', '/v1/connections');
  assert.equal(refused.status, 401, 'still refused without the key');

  const allowed = await fetch(`${base}/v1/connections`, { headers: { authorization: `Bearer ${created.key}` } });
  assert.equal(allowed.status, 200, `the key must open it, got ${allowed.status}`);
  assert.equal((await allowed.json()).object, 'list');
  void auth;
});

test('enforcement off leaves the management surface open, which is the documented local mode', async (t) => {
  // The gate must not change local mode. If this fails, the fix has broken the product's default.
  const { base } = await startGateway(t, { enforced: false });
  for (const [method, path, body] of MANAGEMENT) {
    const response = await bare(base, method, path, body);
    assert.notEqual(response.status, 401, `${method} ${path} must stay open while enforcement is off`);
  }
});

test('the LLM surface is still gated exactly as before', async (t) => {
  // The regression this could cause: gating the management surface and accidentally widening or narrowing
  // the inference gate. Both directions are asserted.
  const { base } = await startGateway(t, { enforced: true });
  assert.equal((await bare(base, 'GET', '/v1/models')).status, 401, 'models must still require a key');

  const { base: open } = await startGateway(t, { enforced: false });
  assert.notEqual((await bare(open, 'GET', '/v1/models')).status, 401, 'models must be open in local mode');
});

test('the prefix list and the router agree, so a new management route cannot be added outside it', async (t) => {
  // The guard above is only as good as `MANAGEMENT_PREFIXES`. This reads the server source and checks that
  // every path the route modules actually serve under a `/v1/` prefix is either a management prefix or
  // deliberately excluded — otherwise a new prefix is a new hole with no test failure.
  const { readFileSync, readdirSync } = await import('node:fs');
  const routesDir = new URL('../src/routes/', import.meta.url);
  const served = new Set();
  for (const file of readdirSync(routesDir)) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(new URL(file, routesDir), 'utf8');
    for (const match of source.matchAll(/pathname\s*(?:===|\.startsWith\()\s*'(\/v1\/[a-z-]+)/g)) {
      served.add(match[1]);
    }
  }
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const declared = new Set([...server.matchAll(/'(\/v1\/[a-z-]+)'/g)].map((m) => m[1]));
  // The inference surface, which `handleInferenceRoute` gates itself. Matched by prefix because the
  // scan sees `/v1/chat` (the shape in the source) rather than the full `/v1/chat/completions`.
  // `/v1/embeddings` joins these for the same reason `/v1/models` and `/v1/chat` are here: it is part
  // of the inference surface, which `handleInferenceRoute` gates through `isPublicLlmRoute` rather
  // than through the prefix list. Putting it in `MANAGEMENT_PREFIXES` instead would be a *second*
  // gate on the same route — the 1.46.0 shape, where a route protected in one place and exempt in
  // another is a route whose protection depends on which check runs first.
  const excluded = new Set(['/v1/models', '/v1/chat', '/v1/embeddings']);
  for (const prefix of served) {
    if (excluded.has(prefix)) continue;
    assert.ok(
      declared.has(prefix),
      `${prefix} is served but is not in MANAGEMENT_PREFIXES — an unauthenticated caller would reach it`,
    );
  }
  assert.ok(served.size > 0, 'the scan found no routes at all, so it proves nothing');
  void t;
});

/**
 * ## The one carve-out, and its two halves (1.75.2)
 *
 * `/v1/oauth` is on the management list and the provider callbacks live under it. The callback is the one
 * request in the product that *cannot* present an `Authorization` header — it is a top-level navigation
 * the provider sends the browser to — so the gate did not secure it, it made it unreachable. Measured on a
 * gateway with enforcement on, no key, cross-site headers:
 *
 * ```
 * 401  GET /v1/oauth/cline/callback/<id>?code=…
 *      {"error":{"code":"AUTHENTICATION_FAILED","message":"This gateway requires an API key…"}}
 * ```
 *
 * Which is why an earlier probe of this exact flow could not see the defect: that gateway ran with
 * `requireApiKey: false`, where `authorize()` returns before it can refuse anything.
 */

/** The request a provider redirect makes: a top-level navigation, cross-site, no Origin, no key. */
function navigation(base, path) {
  return fetch(`${base}${path}`, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
}

const SESSION_ID = 'a'.repeat(43) + '0123456789abcdefghij';

const CALLBACKS = [
  ['cline', `/v1/oauth/cline/callback/${SESSION_ID}?code=made-up-code`],
  ['claude-code', `/v1/oauth/claude-code/callback/${SESSION_ID}?code=granted#state`],
];

test('the provider callback is reachable with enforcement on, because a browser navigation cannot carry a key', async (t) => {
  const { base } = await startGateway(t, { enforced: true });
  for (const [name, path] of CALLBACKS) {
    const response = await navigation(base, path);
    assert.equal(response.status, 200, `${name} callback answered ${response.status} for a navigation that has no key`);
    const page = await response.text();
    assert.match(response.headers.get('content-type') ?? '', /text\/html/, `${name} must answer with the page, not a JSON error`);
    assert.match(page, /<!doctype html>/i, `${name} must render its result page`);
    assert.doesNotMatch(page, /AUTHENTICATION_FAILED|requires an API key/, `${name} must never show the admin gate's message`);
  }
});

test('the carve-out is the callback paths only — the siblings that mint and carry credentials stay gated', async (t) => {
  // The shape of a lazy fix is a prefix exemption: `/v1/oauth/*`, which would open `/exchange` — the route
  // that turns a code into a live connection — and `/session/*`, which carries the connected record back.
  const { base } = await startGateway(t, { enforced: true });
  const siblings = [
    ['POST', '/v1/oauth/cline/start', { redirectUri: `http://127.0.0.1:0/v1/oauth/cline/callback/${SESSION_ID}` }],
    ['POST', '/v1/oauth/cline/exchange', { code: 'made-up-code' }],
    ['GET', `/v1/oauth/cline/session/${SESSION_ID}`, undefined],
    ['POST', '/v1/oauth/claude-code/start', {}],
    ['GET', `/v1/oauth/claude-code/session/${SESSION_ID}`, undefined],
    ['POST', '/v1/oauth/opencode-console/start', {}],
    ['GET', `/v1/oauth/opencode-console/session/${SESSION_ID}`, undefined],
  ];
  for (const [method, path, body] of siblings) {
    const response = await bare(base, method, path, body);
    assert.equal(response.status, 401, `${method} ${path} answered ${response.status} — the exemption leaked past the callback paths`);
  }
});

test('the carve-out is GET-only, so the callback path itself is not an open management prefix', async (t) => {
  // `isOauthCallbackNavigation` checks the method. Without that, a POST to the same path would skip the
  // gate on the strength of its URL alone. Sent without `sec-fetch-site` and with a JSON content type, so
  // the cross-site and media-type guards — which answer earlier and for unrelated reasons — stay out of it.
  const { base } = await startGateway(t, { enforced: true });
  const response = await bare(base, 'POST', `/v1/oauth/cline/callback/${SESSION_ID}`, { code: 'made-up-code' });
  assert.equal(response.status, 401, `POST to the callback path answered ${response.status} with no key`);
});

test('what the carve-out exposes is a status page, not the session', async (t) => {
  // The reason the exemption is tolerable. The callback answers with prose and no credential, and the
  // route holding the connected record is still gated — so reaching the callback buys an attacker nothing.
  const { base, apiKeys } = await startGateway(t, { enforced: true });
  const created = await apiKeys.create('operator');
  const response = await navigation(base, `/v1/oauth/cline/callback/${SESSION_ID}?code=made-up-code`);
  const page = await response.text();
  assert.doesNotMatch(page, new RegExp(created.key), 'the callback must not echo a gateway key');
  assert.doesNotMatch(page, /ohk_/, 'the callback must not emit anything key-shaped');
  assert.match(page, /Start (the sign-in|again)|already been used|expired/i, `the page must say the sign-in did not complete, got: ${page.slice(0, 200)}`);

  const session = await bare(base, 'GET', `/v1/oauth/cline/session/${SESSION_ID}`);
  assert.equal(session.status, 401, 'the session route must stay gated even once the callback is reachable');
});

test('both guards exempt the callback from the same predicate, so they cannot drift apart', async (t) => {
  // The cross-site guard and the admin gate are two checks on the same path. If only one of them learned
  // about the callback, a later edit could re-close the feature or leave it half-open without a test
  // failing. This reads the source because the property *is* "both call the same predicate".
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const guard = source.match(/if \(isManagementPath\([^)]*\) && [^\n]*/)?.[0] ?? '';
  assert.match(guard, /!isOauthCallbackNavigation\(request\)/, 'the management gate must exempt the callback navigation');
  assert.match(source, /!isOauthCallbackNavigation\(request\) && isCrossSiteRequest/, 'the cross-site guard must exempt the same navigation');
  void t;
});

test('a file-backed key store enforces the same rule end to end', async (t) => {
  // `InMemoryApiKeyStore` is a test double. The real store is the one on disk, so the gate is checked
  // against it too — the shape of this defect is a double that agrees with a broken implementation.
  const directory = mkdtempSync(join(tmpdir(), 'admin-gate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new LocalApiKeyStore({ directory });
  await store.setEnforced(true);
  const { base } = await startGateway(t, { store });

  const refused = await bare(base, 'POST', '/v1/keys', { name: 'probe' });
  assert.equal(refused.status, 401, 'the real store must refuse an unauthenticated mint');

  const created = await store.create('operator');
  const allowed = await fetch(`${base}/v1/keys`, { headers: { authorization: `Bearer ${created.key}` } });
  assert.equal(allowed.status, 200, `the real store must accept its own key, got ${allowed.status}`);
});
