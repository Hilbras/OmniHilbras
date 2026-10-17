import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';
import {
  GatewayService,
  InMemoryApiKeyStore,
  InMemoryConnectionStore,
  LocalConnectionStore,
  createGatewayServer,
} from '../dist/index.js';
import { parseGenericConnectionRequest } from '../dist/routes/connections.js';

/**
 * A connection with **no credential at all**, from the request that asks for one to the record that comes back.
 *
 * ## What was broken
 *
 * `parseGenericConnectionRequest` called `parseApiKey` unconditionally, and `parseApiKey` refuses both a
 * missing and an empty string. So the gateway had no way — over HTTP, for any provider — to accept a
 * connection whose provider needs no key, and `Ollama` (the only `auth: 'No key'` card) could not be
 * connected from either dashboard page. Measured against this route before the fix:
 *
 * ```
 * PUT /v1/connections/ollama  {"endpoint": …, "name": …}                 → 400  apiKey is required.
 * PUT /v1/connections/ollama  {"apiKey": "", "endpoint": …, "name": …}   → 400  apiKey must be a non-empty safe string.
 * ```
 *
 * ## Why the shapes are refused rather than guessed
 *
 * `credential: 'none'` is the only way to say it, and it is spelled so it cannot be reached by accident:
 * omitting both fields still fails, sending both is refused instead of resolved by a precedence rule, and
 * any other value is refused. A body that says two things about one credential has no correct reading, and
 * one that says nothing has already been read wrong twice.
 *
 * The turn itself is not routed here — `connection-credential-round-trip.test.js` covers "a keyless
 * connection serves a request, before and after a restart" with a stub adapter. This file is about the door.
 */

const SECRET = { type: 'none' };

/** A stub adapter, so the save's model discovery happens offline and nothing reaches a real endpoint. */
const stubAdapter = {
  id: 'ollama',
  name: 'Ollama',
  capabilities: { chat: true, streaming: false, models: true },
  async listModels() {
    return [{ id: 'llama3.2', providerId: 'ollama' }];
  },
  async healthCheck() {
    return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' };
  },
  async validateCredential() {
    return {};
  },
  async chat() {
    throw new Error('not used');
  },
  async *streamChat() {
    throw new Error('not used');
  },
};

const saveBody = { endpoint: 'http://127.0.0.1:9/v1', name: 'Ollama' };

async function startGateway(t, store) {
  const registry = new ProviderRegistry();
  registry.register(stubAdapter);
  const apiKeys = new InMemoryApiKeyStore();
  await apiKeys.setEnforced(false);
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, service };
}

const save = (base, body) =>
  fetch(`${base}/v1/connections/ollama`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('the request can say "no credential", and only say it one way', () => {
  // Called directly, because this function *is* the decision — the route around it is a four-line wrapper.
  const parsed = parseGenericConnectionRequest({ ...saveBody, credential: 'none' }, 'ollama');
  assert.deepEqual(parsed.credential, SECRET, 'a keyless save is a none credential');

  assert.throws(() => parseGenericConnectionRequest(saveBody, 'ollama'), /apiKey is required/);
  assert.throws(() => parseGenericConnectionRequest({ ...saveBody, apiKey: '' }, 'ollama'), /non-empty safe string/);
  assert.throws(
    () => parseGenericConnectionRequest({ ...saveBody, credential: 'none', apiKey: 'sk-both' }, 'ollama'),
    /not both/,
    'a body naming two credentials has no correct reading',
  );
  assert.throws(() => parseGenericConnectionRequest({ ...saveBody, credential: 'yes' }, 'ollama'), /credential must be 'none'/);
});

test('a keyless provider saves over HTTP, and the record says it has a credential', async (t) => {
  const { base, service } = await startGateway(t, new InMemoryConnectionStore());

  const response = await save(base, { ...saveBody, credential: 'none' });
  // 200, not 201: the generic save is also the update path, so it answers with the record either way.
  assert.equal(response.status, 200, `a keyless save must be accepted: ${await response.text()}`);

  const connections = await service.listConnections();
  assert.equal(connections.length, 1);
  assert.equal(connections[0].providerId, 'ollama');
  // `hasCredential` is what routing filters on, and it means "a credential record exists" — which is true
  // for `{ type: 'none' }`. It is only *false* for a connection with nothing stored at all.
  assert.equal(connections[0].hasCredential, true, 'a keyless connection must be a routing candidate');
});

test('the same save without the field is still refused', async (t) => {
  // The guard against success-by-omission: this is the shape a caller produces by forgetting, and it must
  // keep failing so that `credential: 'none'` stays a deliberate statement rather than an inferred default.
  const { base, service } = await startGateway(t, new InMemoryConnectionStore());

  const response = await save(base, saveBody);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /apiKey is required/);
  assert.deepEqual(await service.listConnections(), [], 'a refused save stores nothing');
});

test('a keyless connection created over HTTP survives a restart of the vault', async (t) => {
  // The end-to-end door: the route writes it, the loader reads it back. Before the vault fix this threw
  // `Encrypted credential payload contains an invalid credential.` and took every connection with it.
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-keyless-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const { base } = await startGateway(t, new LocalConnectionStore({ directory }));
  assert.equal((await save(base, { ...saveBody, credential: 'none' })).status, 200);

  const reopened = new LocalConnectionStore({ directory });
  const connection = (await reopened.list())[0];
  assert.equal(connection?.providerId, 'ollama');
  assert.equal(connection?.hasCredential, true);
  assert.deepEqual(await reopened.get('ollama'), SECRET);
});