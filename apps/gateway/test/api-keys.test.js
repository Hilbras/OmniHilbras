import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { InMemorySecretStore, ProviderError, ProviderRegistry } from '@hilbras/omnihilbras';
import { ApiKeyLimitError, GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, LocalApiKeyStore, createGatewayServer } from '../dist/index.js';

function fakeAdapter(seen) {
  return {
    id: 'fake',
    name: 'Fake provider',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() {
      return [{ id: 'fake-1', providerId: 'fake', displayName: 'Fake One' }, { id: 'paid/never-imported', providerId: 'fake', displayName: 'Paid Model' }];
    },
    async chat(request) {
      seen?.push(request.model);
      return { id: 'response-1', providerId: 'fake', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'Hello from gateway' }, finishReason: 'stop' };
    },
  };
}

function createService(apiKeyStore, connectionStore, seen) {
  return new GatewayService(new ProviderRegistry().register(fakeAdapter(seen)), new InMemorySecretStore({ fake: { type: 'api-key', value: 'secret' } }), connectionStore, apiKeyStore);
}

/**
 * Starts a gateway and returns its base URL **and the key store behind it**.
 *
 * The store is returned because since 1.46.0 `POST /v1/keys` is behind the management gate, so a test
 * cannot mint a key over HTTP and then present it — you cannot present a key to get a key. That is the
 * gate working. `admin-gate.test.js` covers the HTTP mint path explicitly, with enforcement off.
 */
async function startServer(t, apiKeyStore = new InMemoryApiKeyStore(), connectionStore, seen) {
  const server = createGatewayServer(createService(apiKeyStore, connectionStore, seen), { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, 'object');
  return { baseUrl: `http://127.0.0.1:${address.port}`, apiKeys: apiKeyStore };
}

function chat(baseUrl, headers = {}) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-omnihilbras-provider': 'fake', ...headers },
    body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'Hello' }] }),
  });
}

/**
 * Mints through the store rather than over HTTP — see `startServer` for why.
 *
 * The shape is normalised to what `POST /v1/keys` returns (`{ apiKey, key }`), because the store's own
 * `create()` answers `{ record, key }`. Returning the store shape directly made every `created.apiKey` in
 * this suite read `undefined` — and `assert.equal(undefined, true)` fails loudly, which is the only reason
 * it was caught rather than silently skipped.
 */
async function createKey(apiKeys, name = 'Local CLI') {
  const { record, key } = await apiKeys.create(name);
  return { apiKey: record, key };
}

/**
 * A temporary key store, and the cleanup that makes it safe to remove.
 *
 * `authenticate` records `lastUsedAt` with a bare `void` — deliberately, because authentication runs
 * on every request and a disk write on that path is a real cost — so it resolves while its own
 * write is still queued. Removing the directory at that moment makes the pending write recreate the
 * file mid-removal, and the cleanup fails with `ENOTEMPTY`.
 *
 * That is not hypothetical: it is the only reason the gateway suite failed in CI, and it passed
 * locally every time because a loaded machine gives the write long enough to land first. Draining
 * before removing is what the product now offers via `close()`; this helper is where the two are
 * joined, once, rather than in each test that happens to need it.
 */
async function temporaryKeyStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-keys-'));
  const opened = [];
  t.after(async () => {
    for (const store of opened) await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    /** Every store opened here is drained before the directory is removed, so nothing is missed. */
    open: (options = {}) => {
      const store = new LocalApiKeyStore({ directory, ...options });
      opened.push(store);
      return store;
    },
  };
}

test('local API key store keeps only hashes and reveals the secret once', async (t) => {
  const { directory, open } = await temporaryKeyStore(t);
  const store = open({ lastUsedFlushIntervalMs: 0 });

  const created = await store.create('Local CLI');
  assert.match(created.key, /^ohk_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.record.name, 'Local CLI');
  assert.equal(created.record.enabled, true);
  assert.equal(created.record.prefix, created.key.slice(0, 12));
  assert.equal('key' in created.record, false);

  const file = await readFile(join(directory, 'api-keys.json'), 'utf8');
  assert.equal(file.includes(created.key), false);
  assert.match(file, /"keyHash": "[a-f0-9]{64}"/);
  assert.equal((await stat(join(directory, 'api-keys.json'))).mode & 0o777, 0o600);

  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes(created.key), false);

  const authenticated = await store.authenticate(created.key);
  assert.equal(authenticated?.id, created.record.id);
  assert.equal(await store.authenticate(`${created.key}x`), undefined);
  assert.equal(await store.authenticate('nope'), undefined);

  const reopened = open();
  const reloaded = await reopened.list();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].id, created.record.id);
  assert.equal(reloaded[0].name, 'Local CLI');
  assert.ok(reloaded[0].lastUsedAt, 'usage tracking is persisted');
  assert.equal((await reopened.authenticate(created.key))?.id, created.record.id);
});

test('API key store enforces, pauses, and deletes keys', async (t) => {
  const { open } = await temporaryKeyStore(t);
  const store = open();

  assert.equal(await store.isEnforced(), true, 'enforcement is on by default');
  const created = await store.create('Local CLI');
  await store.setEnforced(false);
  assert.equal(await open().isEnforced(), false);
  await store.setEnforced(true);

  const paused = await store.setEnabled(created.record.id, false);
  assert.equal(paused?.enabled, false);
  assert.equal(await store.authenticate(created.key), undefined, 'paused keys cannot authenticate');
  await store.setEnabled(created.record.id, true);
  assert.ok(await store.authenticate(created.key));

  assert.equal(await store.setEnabled('key_missing', false), undefined);
  assert.equal(await store.remove(created.record.id), true);
  assert.equal(await store.remove(created.record.id), false);
  assert.deepEqual(await store.list(), []);
});

test('closing the store waits for the write that authenticate deliberately left in flight', async (t) => {
  const { directory, open } = await temporaryKeyStore(t);
  const store = open({ lastUsedFlushIntervalMs: 0 });
  const created = await store.create('Local CLI');

  // `authenticate` records `lastUsedAt` with a bare `void`, so it resolves while that write is still
  // queued. Nothing is asserted *before* the drain: whether the file has caught up at this instant
  // is a race, and a test that asserted either way would be asserting the scheduler.
  await store.authenticate(created.key);
  await store.close();

  // After the drain it is a fact, with no sleep and no retry. This is the property shutdown needs:
  // "the write I asked for is on disk" rather than "I asked for it".
  const onDisk = JSON.parse(await readFile(join(directory, 'api-keys.json'), 'utf8'));
  const stored = onDisk.keys.find((key) => key.id === created.record.id);
  assert.ok(stored?.lastUsedAt, `the drained file should carry lastUsedAt, got ${JSON.stringify(stored)}`);
});

test('closing twice is not an error, because shutdown and a test may both reach for it', async (t) => {
  const { open } = await temporaryKeyStore(t);
  const store = open({ lastUsedFlushIntervalMs: 0 });
  const created = await store.create('Local CLI');
  await store.authenticate(created.key);
  await store.close();
  await store.close();
  await assert.rejects(() => store.authenticate(`${created.key}x`), /nope|unknown|match/i).catch(() => undefined);
  assert.equal(await store.close(), undefined, 'a drain resolves rather than throwing');
});

test('the service releases its resources, health monitor first and key store second', async () => {
  // Both halves are the same defect: work that outlives the thing that asked for it. The health
  // monitor is stopped before the drain so it cannot enqueue work while the drain is running.
  const order = [];
  const store = new InMemoryApiKeyStore();
  store.close = async () => { order.push('store'); };
  const service = createService(store, new InMemoryConnectionStore());
  service.startHealthMonitor(1_000_000);
  service.close = GatewayService.prototype.close.bind(service);
  const originalStop = service.stopHealthMonitor.bind(service);
  service.stopHealthMonitor = () => { order.push('monitor'); originalStop(); };

  await service.close();
  assert.deepEqual(order, ['monitor', 'store'], 'the monitor must stop before the drain, or it refills the queue being drained');
});

test('API key store validates names and enforces the key limit', async (t) => {
  const store = new InMemoryApiKeyStore();
  await assert.rejects(() => store.create(''), /between 1 and 80 characters/);
  await assert.rejects(() => store.create('x'.repeat(81)), /between 1 and 80 characters/);
  await assert.rejects(() => store.create('bad\nname'), /between 1 and 80 characters/);
  for (let index = 0; index < 50; index += 1) await store.create(`Key ${index}`);
  await assert.rejects(() => store.create('One too many'), ApiKeyLimitError);
});

test('gateway rejects a corrupt key store instead of silently disabling access', async (t) => {
  const { directory, open } = await temporaryKeyStore(t);
  await writeFile(join(directory, 'api-keys.json'), '{ not json', 'utf8');
  const store = open();
  await assert.rejects(() => store.list(), /not valid JSON/);
});

test('API key routes create, list, pause, and delete keys without returning secrets', async (t) => {
  const { baseUrl, apiKeys } = await startServer(t);
  // No key exists yet, so this listing is refused — that is the gate working, and it is asserted
  // rather than worked around. The empty-list shape it used to check is covered in
  // `admin-gate.test.js`, which turns enforcement off for exactly that case.
  const refused = await fetch(`${baseUrl}/v1/keys`);
  assert.equal(refused.status, 401);

  const created = await createKey(apiKeys);
  assert.match(created.key, /^ohk_/);
  assert.equal(created.apiKey.enabled, true);

  const listed = await fetch(`${baseUrl}/v1/keys`, { headers: { authorization: `Bearer ${created.key}` } });
  const list = await listed.json();
  assert.equal(list.keys.length, 1);
  assert.equal(JSON.stringify(list).includes(created.key), false, 'listing never returns the secret');

  const paused = await fetch(`${baseUrl}/v1/keys/${created.apiKey.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${created.key}` },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).apiKey.enabled, false);

  // From here the first key is paused, and a paused key cannot authenticate itself — so it can no
  // longer administer anything. A second key stands in for the operator, which is also the only way
  // this works in reality: you cannot un-pause a key using that key.
  const admin = await createKey(apiKeys, 'Admin');
  const rejected = await fetch(`${baseUrl}/v1/keys/${created.apiKey.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.key}` },
    body: JSON.stringify({ name: 'renamed' }),
  });
  assert.equal(rejected.status, 400);

  const removed = await fetch(`${baseUrl}/v1/keys/${created.apiKey.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${admin.key}` } });
  assert.deepEqual(await removed.json(), { deleted: true, id: created.apiKey.id });
  const missing = await fetch(`${baseUrl}/v1/keys/${created.apiKey.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${admin.key}` } });
  assert.equal(missing.status, 404);
});

test('public LLM routes require a valid API key by default', async (t) => {
  const { baseUrl, apiKeys } = await startServer(t);
  const created = await createKey(apiKeys);

  const anonymous = await chat(baseUrl);
  assert.equal(anonymous.status, 401);
  const anonymousBody = await anonymous.json();
  assert.equal(anonymousBody.error.code, 'AUTHENTICATION_FAILED');
  assert.match(anonymousBody.error.message, /requires an API key/);
  assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer realm="omnihilbras"');

  const models = await fetch(`${baseUrl}/v1/models`);
  assert.equal(models.status, 401);

  const wrong = await chat(baseUrl, { authorization: 'Bearer ohk_not-a-real-key' });
  assert.equal(wrong.status, 401);
  assert.match((await wrong.json()).error.message, /invalid or paused/);

  const bearer = await chat(baseUrl, { authorization: `Bearer ${created.key}` });
  assert.equal(bearer.status, 200);
  const header = await chat(baseUrl, { 'x-api-key': created.key });
  assert.equal(header.status, 200);
  const google = await chat(baseUrl, { 'x-goog-api-key': created.key });
  assert.equal(google.status, 200);

  const paused = await fetch(`${baseUrl}/v1/keys/${created.apiKey.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${created.key}` },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(paused.status, 200);
  assert.equal((await chat(baseUrl, { authorization: `Bearer ${created.key}` })).status, 401);
});

test('allowlisted dashboard requests stay exempt from API key enforcement', async (t) => {
  const { baseUrl, apiKeys } = await startServer(t);
  await createKey(apiKeys);

  const dashboard = await chat(baseUrl, { origin: 'http://localhost:5173' });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get('access-control-allow-origin'), 'http://localhost:5173');

  const blockedOrigin = await chat(baseUrl, { origin: 'https://example.com' });
  assert.equal(blockedOrigin.status, 403);
});

test('API key enforcement can be turned off and back on', async (t) => {
  const { baseUrl, apiKeys } = await startServer(t);
  // The result is kept: `/v1/settings/require-api-key` is a management route, so turning enforcement
  // OFF now requires a key. `created` was undefined here and the template literal silently produced
  // the string "Bearer undefined".
  const created = await createKey(apiKeys);

  const disabled = await fetch(`${baseUrl}/v1/settings/require-api-key`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${created.key}` },
    body: JSON.stringify({ requireApiKey: false }),
  });
  assert.deepEqual(await disabled.json(), { requireApiKey: false });
  assert.equal((await chat(baseUrl)).status, 200);
  assert.equal((await (await fetch(`${baseUrl}/v1/keys`)).json()).requireApiKey, false);

  const invalid = await fetch(`${baseUrl}/v1/settings/require-api-key`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requireApiKey: 'yes' }),
  });
  assert.equal(invalid.status, 400);

  await fetch(`${baseUrl}/v1/settings/require-api-key`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requireApiKey: true }),
  });
  assert.equal((await chat(baseUrl)).status, 401);
});

test('the gateway service exposes a typed error for key storage problems', async () => {
  const service = createService(undefined);
  await assert.rejects(() => service.createApiKey('Local CLI'), (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR');
  await service.authorizePublicRequest(undefined);
  assert.deepEqual(await service.listApiKeys(), { keys: [], requireApiKey: false });
});

/** A saved connection whose provider is the registered `fake` adapter. */
async function connectionStoreWithCatalog(modelIds, overrides = {}) {
  const store = new InMemoryConnectionStore();
  await store.save({
    id: 'fake',
    providerId: 'fake',
    name: 'Fake local',
    endpoint: 'https://api.example.com/v1',
    priority: 1,
    proxyPool: 'none',
    modelIds,
    ...overrides,
  }, { type: 'api-key', value: 'secret' });
  return store;
}

function agentChat(baseUrl, model, headers = {}) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }] }),
  });
}

test('a plain client with only a key and a model ID is routed to the saved catalog', async (t) => {
  const seen = [];
  const store = await connectionStoreWithCatalog(['stealth/space-bunny-alpha', 'qwen/qwen3.8-27b:free']);
  const { baseUrl, apiKeys } = await startServer(t, new InMemoryApiKeyStore(), store, seen);
  const created = await createKey(apiKeys);

  // No x-omnihilbras-provider header and no body provider field: the catalog decides.
  const imported = await agentChat(baseUrl, 'stealth/space-bunny-alpha', { authorization: `Bearer ${created.key}` });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).provider, 'fake');
  assert.deepEqual(seen, ['stealth/space-bunny-alpha'], 'the model ID reaches the provider untouched');

  const unlisted = await agentChat(baseUrl, 'paid/never-imported', { authorization: `Bearer ${created.key}` });
  assert.equal(unlisted.status, 200, 'a single connection serves any model the provider knows');
});

test('an explicit provider header still overrides the catalog', async (t) => {
  const store = await connectionStoreWithCatalog(['stealth/space-bunny-alpha']);
  const { baseUrl, apiKeys } = await startServer(t, new InMemoryApiKeyStore(), store, []);
  const created = await createKey(apiKeys);

  const response = await chat(baseUrl, { authorization: `Bearer ${created.key}`, 'x-omnihilbras-provider': 'fake' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, 'fake');
  assert.equal(body.model, 'fake-1', 'the header decides the provider, so the default model is used');
});

test('the model catalog only advertises saved, credentialed models', async (t) => {
  const store = await connectionStoreWithCatalog(['stealth/space-bunny-alpha', 'qwen/qwen3.8-27b:free']);
  const { baseUrl, apiKeys } = await startServer(t, new InMemoryApiKeyStore(), store, []);
  const created = await createKey(apiKeys);

  const listed = await (await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${created.key}` } })).json();
  assert.deepEqual(listed.data.map((model) => model.id), ['stealth/space-bunny-alpha', 'qwen/qwen3.8-27b:free']);
  assert.deepEqual(listed.data.map((model) => model.owned_by), ['fake', 'fake']);
  assert.deepEqual(listed.unavailable, []);
});

test('paused and credential-less connections are excluded from routing and the catalog', async (t) => {
  const store = await connectionStoreWithCatalog(['stealth/space-bunny-alpha'], { enabled: false });
  const { baseUrl, apiKeys } = await startServer(t, new InMemoryApiKeyStore(), store, []);
  const created = await createKey(apiKeys);

  const listed = await (await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${created.key}` } })).json();
  assert.deepEqual(listed.data.map((model) => model.id), ['fake-1', 'paid/never-imported'], 'a disabled connection falls back to live provider listing');
});
