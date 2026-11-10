import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptBackup, encryptBackup } from '../dist/src/core/backup.js';
import { LocalApiKeyStore } from '../dist/src/core/api-keys.js';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * The backup is the only artifact that carries provider credentials. These tests are about the
 * envelope and the API-key state it restores, not about the HTTP verbs.
 */

const payload = {
  format: 'omnihilbras-gateway-backup',
  version: 1,
  connections: [{ connection: { id: 'openrouter', providerId: 'openrouter' }, credential: { type: 'api-key', value: 'sk-secret' } }],
};

test('an encrypted backup round-trips', () => {
  const envelope = encryptBackup(payload, 'correct horse battery');
  assert.equal(envelope.cipher, 'aes-256-gcm');
  assert.equal(JSON.stringify(envelope).includes('sk-secret'), false, 'the credential is in clear in the envelope');
  assert.deepEqual(decryptBackup(envelope, 'correct horse battery'), payload);
});

test('a wrong passphrase, a short one, or a tapped payload is refused', () => {
  const envelope = encryptBackup(payload, 'correct horse battery');
  assert.throws(() => decryptBackup(envelope, 'wrong horse battery'), /could not be decrypted/);
  assert.throws(() => encryptBackup(payload, 'short'), /at least 8/);
  const tampered = { ...envelope, data: Buffer.from('tampered', 'utf8').toString('base64') };
  assert.throws(() => decryptBackup(tampered, 'correct horse battery'), /could not be decrypted/);
  assert.throws(() => decryptBackup({ format: 'other' }, 'correct horse battery'), /not an OmniHilbras backup/);
});

test('a gateway backup carries connections and credentials into a fresh service', async () => {
  const sourceStore = new InMemoryConnectionStore();
  await sourceStore.save({
    id: 'openrouter',
    providerId: 'openrouter',
    name: 'Primary',
    endpoint: 'https://openrouter.ai/api/v1',
    priority: 1,
    proxyPool: 'none',
  }, { type: 'api-key', value: 'sk-or-secret' });
  const source = new GatewayService(new ProviderRegistry(), sourceStore, sourceStore, new InMemoryApiKeyStore());
  const backup = await source.exportBackup('correct horse battery');
  assert.equal(JSON.stringify(backup).includes('sk-or-secret'), false, 'the credential left in clear');

  const targetStore = new InMemoryConnectionStore();
  const target = new GatewayService(new ProviderRegistry(), targetStore, targetStore, new InMemoryApiKeyStore());
  const result = await target.importBackup('correct horse battery', backup);
  assert.equal(result.connections, 1);
  assert.deepEqual(await targetStore.get('openrouter'), { type: 'api-key', value: 'sk-or-secret' });
  assert.equal((await targetStore.list())[0]?.name, 'Primary');
});

test('a wrong passphrase changes nothing on import', async () => {
  const sourceStore = new InMemoryConnectionStore();
  await sourceStore.save({
    id: 'groq', providerId: 'groq', name: 'Main', endpoint: 'https://api.groq.com/openai/v1', priority: 1, proxyPool: 'none',
  }, { type: 'api-key', value: 'gsk-secret' });
  const source = new GatewayService(new ProviderRegistry(), sourceStore, sourceStore, new InMemoryApiKeyStore());
  const backup = await source.exportBackup('correct horse battery');

  const targetStore = new InMemoryConnectionStore();
  const target = new GatewayService(new ProviderRegistry(), targetStore, targetStore, new InMemoryApiKeyStore());
  await assert.rejects(() => target.importBackup('wrong horse battery', backup), /could not be decrypted/);
  assert.deepEqual(await targetStore.list(), []);
});

test('an API-key store exports hashes and re-imports them so the same key still authenticates', async () => {
  const first = await mkdtemp(join(tmpdir(), 'omnihilbras-backup-a-'));
  const second = await mkdtemp(join(tmpdir(), 'omnihilbras-backup-b-'));
  try {
    const source = new LocalApiKeyStore({ directory: first });
    const created = await source.create('laptop');
    await source.setEnforced(false);
    const state = await source.exportState();
    assert.equal(JSON.stringify(state).includes(created.key), false, 'the plaintext key is in the exported state');
    assert.equal(state.keys.length, 1);
    assert.equal(state.requireApiKey, false);

    const target = new LocalApiKeyStore({ directory: second });
    await target.importState(state);
    const matched = await target.authenticate(created.key);
    assert.equal(matched?.name, 'laptop');
    assert.equal(await target.isEnforced(), false);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('an unreadable API-key backup is refused before anything changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-backup-bad-'));
  try {
    const store = new LocalApiKeyStore({ directory });
    const created = await store.create('keep-me');
    await assert.rejects(() => store.importState({ version: 99, requireApiKey: true, keys: [] }), /not readable/);
    assert.equal((await store.authenticate(created.key))?.name, 'keep-me');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
