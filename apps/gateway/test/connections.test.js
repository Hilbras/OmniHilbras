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
