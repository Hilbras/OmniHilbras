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
