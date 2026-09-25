import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { InMemorySecretStore, ProviderError, ProviderRegistry } from '@omnihilbras/sdk';
import { ApiKeyLimitError, GatewayService, InMemoryApiKeyStore, LocalApiKeyStore, createGatewayServer } from '../dist/index.js';

function createService(apiKeyStore) {
  const adapter = {
    id: 'fake',
    name: 'Fake provider',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() {
      return [{ id: 'fake-1', providerId: 'fake', displayName: 'Fake One' }];
    },
    async chat(request) {
      return { id: 'response-1', providerId: 'fake', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'Hello from gateway' }, finishReason: 'stop' };
    },
  };
  return new GatewayService(new ProviderRegistry().register(adapter), new InMemorySecretStore({ fake: { type: 'api-key', value: 'secret' } }), undefined, apiKeyStore);
}

async function startServer(t, apiKeyStore = new InMemoryApiKeyStore()) {
  const server = createGatewayServer(createService(apiKeyStore), { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, 'object');
  return `http://127.0.0.1:${address.port}`;
}

function chat(baseUrl, headers = {}) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-omnihilbras-provider': 'fake', ...headers },
    body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'Hello' }] }),
  });
}

async function createKey(baseUrl, name = 'Local CLI') {
  const response = await fetch(`${baseUrl}/v1/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  assert.equal(response.status, 201);
  return response.json();
}

test('local API key store keeps only hashes and reveals the secret once', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalApiKeyStore({ directory, lastUsedFlushIntervalMs: 0 });

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

  const reopened = new LocalApiKeyStore({ directory });
  const reloaded = await reopened.list();
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].id, created.record.id);
  assert.equal(reloaded[0].name, 'Local CLI');
  assert.ok(reloaded[0].lastUsedAt, 'usage tracking is persisted');
  assert.equal((await reopened.authenticate(created.key))?.id, created.record.id);
});

test('API key store enforces, pauses, and deletes keys', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalApiKeyStore({ directory });

  assert.equal(await store.isEnforced(), true, 'enforcement is on by default');
  const created = await store.create('Local CLI');
  await store.setEnforced(false);
  assert.equal(await new LocalApiKeyStore({ directory }).isEnforced(), false);
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

test('API key store validates names and enforces the key limit', async (t) => {
  const store = new InMemoryApiKeyStore();
  await assert.rejects(() => store.create(''), /between 1 and 80 characters/);
  await assert.rejects(() => store.create('x'.repeat(81)), /between 1 and 80 characters/);
  await assert.rejects(() => store.create('bad\nname'), /between 1 and 80 characters/);
  for (let index = 0; index < 50; index += 1) await store.create(`Key ${index}`);
  await assert.rejects(() => store.create('One too many'), ApiKeyLimitError);
});

test('gateway rejects a corrupt key store instead of silently disabling access', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-keys-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'api-keys.json'), '{ not json', 'utf8');
  const store = new LocalApiKeyStore({ directory });
  await assert.rejects(() => store.list(), /not valid JSON/);
});

test('API key routes create, list, pause, and delete keys without returning secrets', async (t) => {
  const baseUrl = await startServer(t);

  const empty = await (await fetch(`${baseUrl}/v1/keys`)).json();
  assert.deepEqual(empty, { object: 'list', keys: [], requireApiKey: true });

  const created = await createKey(baseUrl);
  assert.match(created.key, /^ohk_/);
  assert.equal(created.apiKey.enabled, true);

  const list = await (await fetch(`${baseUrl}/v1/keys`)).json();
  assert.equal(list.keys.length, 1);
  assert.equal(JSON.stringify(list).includes(created.key), false, 'listing never returns the secret');

  const paused = await fetch(`${baseUrl}/v1/keys/${created.apiKey.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).apiKey.enabled, false);

  const rejected = await fetch(`${baseUrl}/v1/keys/${created.apiKey.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'renamed' }),
  });
  assert.equal(rejected.status, 400);

  const removed = await fetch(`${baseUrl}/v1/keys/${created.apiKey.id}`, { method: 'DELETE' });
  assert.deepEqual(await removed.json(), { deleted: true, id: created.apiKey.id });
  const missing = await fetch(`${baseUrl}/v1/keys/${created.apiKey.id}`, { method: 'DELETE' });
  assert.equal(missing.status, 404);
});

test('public LLM routes require a valid API key by default', async (t) => {
  const baseUrl = await startServer(t);
  const created = await createKey(baseUrl);

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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(paused.status, 200);
  assert.equal((await chat(baseUrl, { authorization: `Bearer ${created.key}` })).status, 401);
});

test('allowlisted dashboard requests stay exempt from API key enforcement', async (t) => {
  const baseUrl = await startServer(t);
  await createKey(baseUrl);

  const dashboard = await chat(baseUrl, { origin: 'http://localhost:5173' });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get('access-control-allow-origin'), 'http://localhost:5173');

  const blockedOrigin = await chat(baseUrl, { origin: 'https://example.com' });
  assert.equal(blockedOrigin.status, 403);
});

test('API key enforcement can be turned off and back on', async (t) => {
  const baseUrl = await startServer(t);
  await createKey(baseUrl);

  const disabled = await fetch(`${baseUrl}/v1/settings/require-api-key`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
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
