import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { InMemoryConnectionStore, LocalConnectionStore } from '../dist/index.js';

const connectionInput = {
  id: 'openrouter',
  providerId: 'openrouter',
  name: 'OpenRouter local',
  endpoint: 'https://openrouter.ai/api/v1',
  priority: 1,
  proxyPool: 'none',
};

test('local connection store encrypts credentials separately from metadata', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-connections-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = 'sk-or-do-not-write-me';
  const store = new LocalConnectionStore({ directory });

  const record = await store.save(connectionInput, { type: 'api-key', value: secret });
  assert.equal(record.hasCredential, true);
  assert.deepEqual(await store.get('openrouter'), { type: 'api-key', value: secret });

  const metadata = await readFile(join(directory, 'connections.json'), 'utf8');
  const encrypted = await readFile(join(directory, 'secrets.enc.json'), 'utf8');
  assert.equal(metadata.includes(secret), false);
  assert.equal(encrypted.includes(secret), false);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'connections.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'secrets.enc.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'secrets.key'))).mode & 0o777, 0o600);

  const reopened = new LocalConnectionStore({ directory });
  assert.deepEqual(await reopened.get('openrouter'), { type: 'api-key', value: secret });
  assert.deepEqual(await reopened.list(), [record]);
});

test('local connection store persists added model IDs without credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 6) });
  await store.save({ ...connectionInput, modelPolicy: 'free', modelIds: ['vendor/free'] }, { type: 'api-key', value: 'model-secret' });
  const updated = await store.updateModels('openrouter', ['vendor/custom']);

  assert.deepEqual(updated.modelIds, ['vendor/free', 'vendor/custom']);
  assert.deepEqual(updated.customModelIds, ['vendor/custom']);
  const reopened = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 6) });
  assert.deepEqual((await reopened.list())[0].modelIds, ['vendor/free', 'vendor/custom']);
  assert.equal((await readFile(join(directory, 'connections.json'), 'utf8')).includes('model-secret'), false);
});

test('local connection store handles duplicate and overflow model additions atomically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-model-limits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 11) });
  const modelIds = Array.from({ length: 2_000 }, (_, index) => `vendor/model-${index}`);
  const customModelIds = Array.from({ length: 2_000 }, (_, index) => `custom/model-${index}`);
  const record = await store.save({ ...connectionInput, modelIds, customModelIds }, { type: 'api-key', value: 'limit-secret' });

  const duplicate = await store.updateModels('openrouter', ['vendor/model-0']);
  assert.equal(duplicate.updatedAt, record.updatedAt);
  assert.deepEqual(duplicate.customModelIds, customModelIds);
  await assert.rejects(() => store.updateModels('openrouter', ['vendor/new-model']), /model catalog exceeds/);
  assert.deepEqual((await store.list())[0].modelIds, [...modelIds, ...customModelIds]);
});

test('local connection store serializes concurrent model additions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-concurrent-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 12) });
  await store.save({ ...connectionInput, modelIds: ['vendor/original'] }, { type: 'api-key', value: 'concurrent-secret' });

  await Promise.all([
    store.updateModels('openrouter', ['vendor/first']),
    store.updateModels('openrouter', ['vendor/second']),
  ]);

  const reopened = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 12) });
  assert.deepEqual((await reopened.list())[0].modelIds, ['vendor/original', 'vendor/first', 'vendor/second']);
  assert.deepEqual((await reopened.list())[0].customModelIds, ['vendor/first', 'vendor/second']);
});

test('local connection store rejects metadata that cannot be reloaded safely', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-large-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 10) });
  const modelIds = Array.from({ length: 1_000 }, (_, index) => `vendor/${'x'.repeat(240)}-${index}`);

  await assert.rejects(() => store.save({ ...connectionInput, modelIds }, { type: 'api-key', value: 'large-secret' }), /size limit/);
  assert.deepEqual(await store.list(), []);
});

test('local connection store fails closed when the master key is wrong', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-wrong-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 7) });
  await store.save(connectionInput, { type: 'api-key', value: 'test-secret' });

  const wrongKeyStore = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 8) });
  await assert.rejects(() => wrongKeyStore.get('openrouter'));
  assert.equal((await readFile(join(directory, 'connections.json'), 'utf8')).includes('test-secret'), false);
});

test('local connection store discards credentials without a metadata record', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-orphan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 9) });
  await store.save(connectionInput, { type: 'api-key', value: 'orphan-secret' });
  await writeFile(join(directory, 'connections.json'), JSON.stringify({ version: 1, connections: [] }) + '\n');

  const reopened = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 9) });
  assert.deepEqual(await reopened.list(), []);
  assert.equal(await reopened.get('openrouter'), undefined);
  assert.equal((await readFile(join(directory, 'secrets.enc.json'), 'utf8')).includes('orphan-secret'), false);
});

test('in-memory connection store keeps metadata and credentials available to the gateway', async () => {
  const store = new InMemoryConnectionStore();
  const record = await store.save(connectionInput, { type: 'api-key', value: 'test-secret' });
  assert.equal(record.id, 'openrouter');
  assert.deepEqual(await store.list(), [record]);
  assert.equal(await store.remove('openrouter'), true);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get('openrouter'), undefined);
});

test('one provider can hold several connections, each with its own credential', async () => {
  const store = new InMemoryConnectionStore();
  const first = await store.save({ id: 'opencode', providerId: 'opencode', name: 'account A', endpoint: 'https://opencode.ai/zen/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-A' });
  const second = await store.save({ id: 'opencode-backup', providerId: 'opencode', name: 'account B', endpoint: 'https://opencode.ai/zen/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-B' });

  assert.equal(first.id, 'opencode');
  assert.equal(second.id, 'opencode-backup');
  assert.equal((await store.list()).length, 2, 'both connections exist');

  // The whole point of keying by connection: neither credential is overwritten.
  assert.deepEqual(await store.get('opencode'), { type: 'api-key', value: 'key-A' });
  assert.deepEqual(await store.get('opencode-backup'), { type: 'api-key', value: 'key-B' });

  const listed = await store.list();
  assert.deepEqual(listed.map((connection) => connection.hasCredential), [true, true], 'both report a credential');
});

test('saving without an id reuses the provider existing connection', async () => {
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'opencode', providerId: 'opencode', name: 'first', endpoint: 'https://opencode.ai/zen/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-A' });
  const again = await store.save({ providerId: 'opencode', name: 'renamed', endpoint: 'https://opencode.ai/zen/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-A2' });
  assert.equal(again.id, 'opencode');
  assert.equal((await store.list()).length, 1, 'no second connection is created');
  assert.deepEqual(await store.get('opencode'), { type: 'api-key', value: 'key-A2' }, 'the credential is replaced');
});

test('a credential is never shared between two connections of one provider', async () => {
  // The dangerous regression: reading by provider id would hand key-A to the
  // connection that holds key-B.
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'opencode', providerId: 'opencode', name: 'A', endpoint: 'https://opencode.ai/zen/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-A' });
  await store.save({ id: 'opencode-backup', providerId: 'opencode', name: 'B', endpoint: 'https://opencode.ai/zen/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-B' });
  await store.remove('opencode');
  assert.deepEqual(await store.get('opencode-backup'), { type: 'api-key', value: 'key-B' }, 'deleting one leaves the other intact');
  assert.equal(await store.get('opencode'), undefined, 'the removed one has no credential');
});
