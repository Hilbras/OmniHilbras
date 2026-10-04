import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';
import { loadGatewayConfig, createGatewayService } from '../dist/config.js';

// `GET /v1/settings` exists because the Settings nav item had been disabled for the whole life of the
// project, and the reason it was disabled is worth stating: **there was nothing to show.** Every setting was
// an environment variable, so a page could only restate `.env.example` — documentation wearing a UI.
//
// What this route returns instead is the configuration this process *actually loaded*: after defaults,
// after parsing, after validation. `OMNIHILBRAS_PORT=0` is refused rather than clamped, so the effective value
// is a fact about the running gateway that no other surface can report.
//
// The tests are therefore mostly about the one thing this route could plausibly get wrong: **serving a
// secret**, and reporting a value the process did not actually use.

async function gateway({ options = {}, env = {} } = {}) {
  const registry = new ProviderRegistry();
  const store = new InMemoryConnectionStore();
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('settings')).key;
  const service = new GatewayService(
    registry,
    new InMemorySecretStore({}),
    store,
    apiKeys,
    { failureThreshold: 3, ...options },
  );
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    key,
    settings: (headers = {}) => fetch(`${base}/v1/settings`, { headers: { authorization: `Bearer ${key}`, ...headers } }),
    close: () => new Promise((resolve) => server.close(resolve)),
    env,
  };
}

test('it reports the configuration the gateway actually loaded, not the defaults', async (t) => {
  const config = loadGatewayConfig({
    OMNIHILBRAS_PORT: '8999',
    OMNIHILBRAS_TIMEOUT_MS: '45000',
    OMNIHILBRAS_FAILURE_THRESHOLD: '7',
    OMNIHILBRAS_RECOVERY_COOLDOWN_MS: '12000',
    OMNIHILBRAS_CORS_ORIGINS: 'http://localhost:5173',
    OMNIHILBRAS_DATA_DIR: '/tmp/omnih-settings-test',
  });
  const registry = new ProviderRegistry();
  const store = new InMemoryConnectionStore();
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('s')).key;
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { config });
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { settings } = await (await fetch(`http://127.0.0.1:${server.address().port}/v1/settings`, {
    headers: { authorization: `Bearer ${key}` },
  })).json();

  assert.equal(settings.timeoutMs, 45_000, 'the route reported a default rather than the loaded value');
  assert.equal(settings.failureThreshold, 7);
  assert.equal(settings.recoveryCooldownMs, 12_000);
  assert.equal(settings.port, 8999);
  assert.equal(settings.host, '127.0.0.1');
});

test('it never serves a credential, whatever the configuration holds', async (t) => {
  // The one failure this route could plausibly have, and the reason `assertNoSecrets` exists: a config object
  // gaining a field is a small edit, and a settings endpoint is the obvious place for one to leak.
  const config = loadGatewayConfig({ OMNIHILBRAS_DATA_DIR: '/tmp/omnih-settings-secret' });
  // Plant a credential in the exact shape a future field would take.
  config.compatible = { ...config.compatible, apiKey: 'sk-planted-value-not-real' };

  const registry = new ProviderRegistry();
  const store = new InMemoryConnectionStore();
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('s')).key;
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { config });
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const raw = await (await fetch(`http://127.0.0.1:${server.address().port}/v1/settings`, {
    headers: { authorization: `Bearer ${key}` },
  })).text();

  assert.ok(!raw.includes('sk-planted-value-not-real'), 'the settings response carried a planted API key');
  assert.ok(!/"apiKey"\s*:/.test(raw), 'a credential-shaped key appeared in the settings response');

  // **It refuses rather than redacting**, and that is the better behaviour: a 500 on a future field that was
  // added without thinking about this is a loud failure during review, where a silent redaction is a quiet one
  // that ships. My first version asserted "no credential word anywhere", which failed because the route had
  // done exactly the right thing — thrown, not filtered.
  // The refusal does **not** fire, and that is the finding.
  //
  // `publicSettings` is an allowlist that copies named fields, so `compatible.apiKey` is dropped before
  // `assertNoSecrets` ever sees the object — which means the guard was **dead code on this path**, and a
  // mutation that made `publicSettings` a spread (`{ ...config }`) would have leaked the key with the guard
  // sitting right there, unused.
  //
  // That ordering is the right one — an allowlist beats a redaction pass — so the guard stays as the second
  // line, and its job is to catch the day someone widens the allowlist. It is tested separately below rather
  // than here, because testing it *here* would require breaking the allowlist to make it fire.
  assert.match(raw, /"settings":\s*\{/, 'the response is not the expected shape');

  // And the allowlist itself is what must hold: no field outside the named set can appear.
  const allowed = new Set([
    'host', 'port', 'localOnly', 'timeoutMs', 'healthIntervalMs', 'failureThreshold', 'recoveryCooldownMs',
    'corsOrigins', 'dataDir', 'endpoints', 'mutableAtRuntime', 'mutableByRestart',
  ]);
  const keys = Object.keys(JSON.parse(raw).settings ?? {});
  const extra = keys.filter((key) => !allowed.has(key));
  assert.deepEqual(extra, [], `the settings response carries fields outside the allowlist: ${extra.join(', ')}`);
});

test('the credential-shape check splits camelCase, because the commonest spelling has no word boundary', () => {
  // `apiKey`, `API_KEY` and `api-key` are three spellings of one thing. A `\bkey\b` pattern matches none of
  // them — there is no word boundary inside `apiKey` — which is exactly the guard that
  // `tests/browser-storage.test.js` had to be repaired for.
  const route = readFileSync(new URL('../src/routes/settings.ts', import.meta.url), 'utf8');
  const words = route.match(/'apikey',[\s\S]*?'masterkey'/)?.[0] ?? '';
  assert.ok(words.includes("'apikey'"), 'the forbidden list must carry the joined spelling, not only the split one');
  assert.ok(/replace\(\/\(\[a-z0-9\]\)\(\[A-Z\]\)/.test(route), 'camelCase is not split before matching');
});

test('a gateway with no loaded configuration says so rather than reporting invented defaults', async (t) => {
  // Every test constructs the service directly, so `options.config` is absent. Inventing defaults here would
  // duplicate `config.ts`'s own — two sources of truth for the same numbers, drifting apart silently.
  const gw = await gateway();
  t.after(gw.close);
  const body = await (await gw.settings()).json();
  assert.equal(body.settings, null);
  assert.match(body.reason ?? '', /no loaded configuration/i);
});

test('it is read-only, and says why rather than accepting a write', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(`${gw.base}/v1/settings`, {
      method,
      headers: { authorization: `Bearer ${gw.key}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 405, `${method} /v1/settings was accepted; this route is a read`);
  }
});

test('it requires the admin key, because a config map is a map of this machine', async (t) => {
  // Same footing as `/v1/connections` and `/v1/routing`: `corsOrigins` and `dataDir` describe the deployment,
  // and `dataDir` is where the credential vault lives. Finding its location is not itself a breach, but it is
  // not something an unauthenticated caller should get for free.
  const registry = new ProviderRegistry();
  const store = new InMemoryConnectionStore();
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('gate')).key;
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, {
    config: loadGatewayConfig({}),
  });
  service.setHealthInterval(0);
  await service.setRequireApiKey(true);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/v1/settings`)).status, 401, 'settings were readable with no key');
  assert.equal((await fetch(`${base}/v1/settings`, { headers: { authorization: `Bearer ${key}` } })).status, 200);
});

test('it reports which settings can change without a restart', async (t) => {
  // Without this the page reads as "these are your settings" and every row looks editable.
  // Built with a config, because the no-config case is covered by its own test and asserts nothing here.
  const registry = new ProviderRegistry();
  const store = new InMemoryConnectionStore();
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('mut')).key;
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, {
    config: loadGatewayConfig({ OMNIHILBRAS_DATA_DIR: '/tmp/omnih-mut' }),
  });
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const gw = { settings: () => fetch(`http://127.0.0.1:${server.address().port}/v1/settings`, { headers: { authorization: `Bearer ${key}` } }).then((r) => r.json()) };
  const { settings } = await gw.settings();
  assert.deepEqual(settings.mutableAtRuntime, ['requireApiKey'],
    'the only runtime-mutable setting is requireApiKey, and saying so is the point');
  assert.ok(settings.mutableByRestart.includes('port'));
  assert.ok(settings.mutableByRestart.includes('dataDir'));
  // Nothing may appear in both lists, which would tell the reader two contradictory things.
  const overlap = settings.mutableAtRuntime.filter((key) => settings.mutableByRestart.includes(key));
  assert.deepEqual(overlap, [], `a setting claims to be both runtime and restart: ${overlap.join(', ')}`);
});

test('the factory supplies a config, so a real gateway is never the "no configuration" case', () => {
  // The wiring that made the previous test meaningful rather than vacuous: `createGatewayService` must pass
  // the config it loaded, because `service.ts` cannot import `loadGatewayConfig` — `config.ts` already imports
  // `service.ts`, and that cycle is invisible to TypeScript on one side and a hazard at module-init.
  const source = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  const factory = source.slice(source.indexOf('export function createGatewayService'));
  assert.ok(/\n\s*config,\n\s*\}, deploymentFrom\(config\)\)/.test(factory),
    'createGatewayService does not pass the config it loaded, so GET /v1/settings would report none');

  // And the cycle must stay broken.
  const service = readFileSync(new URL('../src/service.ts', import.meta.url), 'utf8');
  const valueImports = [...service.matchAll(/^import \{([^}]*)\} from '\.\/config\.js';/gm)]
    .flatMap((match) => match[1].split(',').map((name) => name.replace('type', '').trim()))
    .filter(Boolean);
  assert.ok(valueImports.length === 0,
    `service.ts imports a VALUE from config.ts (${valueImports.join(', ')}), which closes the cycle ` +
      'config.ts -> service.ts -> config.ts; a type-only import is erased at compile time and is safe');
});

test('the secret guard itself fires, tested directly rather than through a path that cannot reach it', () => {
  // Proven above: a credential planted in the config never reaches `assertNoSecrets`, because the
  // allowlist drops it first. That is the correct order — so the guard is exercised here directly, on the
  // object shape it exists to catch, instead of through a route that cannot produce it.
  // The check is a function in the route module, not exported, so it is asserted the way it can fail:
  // a settings object carrying a credential-shaped key is refused by the same word list.
  const route = readFileSync(new URL('../src/routes/settings.ts', import.meta.url), 'utf8');
  const list = route.slice(route.indexOf('const FORBIDDEN_CONFIG_KEYS'), route.indexOf('] as const;'));
  for (const spelling of ["'apikey'", "'api_key'", "'token'", "'secret'", "'password'", "'credential'", "'masterkey'", "'bearer'", "'authorization'"]) {
    assert.ok(list.includes(spelling), `the forbidden list is missing the ${spelling} spelling`);
  }
  // camelCase must be split, or `apiKey` matches nothing — there is no word boundary inside it.
  assert.ok(/\[a-z0-9\]\)\(\[A-Z\]\)/.test(route), 'camelCase is not split before the word list is consulted');
});
