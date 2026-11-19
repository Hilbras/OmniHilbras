import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore } from '../dist/src/index.js';

/**
 * A write failure on a later section rolls the earlier sections back.
 *
 * Validation-first was already true; the write loop was not atomic. A failure on the usage store left
 * the connections from the backup installed while the caller was told the import failed, which the UI
 * described as “nothing is written at all”.
 */

const passphrase = 'correct horse battery';
const connection = (id, providerId) => ({
  id, providerId, name: id, endpoint: `https://${providerId}.example/v1`,
  priority: 1, proxyPool: 'none', enabled: true, modelIds: [],
});

async function sourceService() {
  const connections = new InMemoryConnectionStore();
  await connections.save(connection('from-backup', 'openrouter'), { type: 'api-key', value: 'sk-source' });
  const usage = new InMemoryUsageStore();
  await usage.record({ at: new Date().toISOString(), model: 'm', providerId: 'openrouter', connectionId: 'from-backup', outcome: 'success', attempts: 1, latencyMs: 1 });
  return new GatewayService(new ProviderRegistry(), connections, connections, new InMemoryApiKeyStore(), { usageStore: usage });
}

test('a backup can be read and counted before anything is written', async () => {
  const source = await sourceService();
  const backup = await source.exportBackup(passphrase);
  const target = new GatewayService(new ProviderRegistry(), new InMemoryConnectionStore(), new InMemoryConnectionStore(), new InMemoryApiKeyStore());
  const preview = await target.verifyBackup(passphrase, backup);
  assert.equal(preview.valid, true);
  assert.equal(preview.sections.connections, 1);
  assert.equal(preview.sections.usage, 1);
  assert.equal((await target.listConnections()).length, 0, 'verification wrote into the target');
});

test('a failed write on a later store leaves the earlier stores untouched', async () => {  const source = await sourceService();
  const backup = await source.exportBackup(passphrase);

  const connections = new InMemoryConnectionStore();
  await connections.save(connection('keep-me', 'groq'), { type: 'api-key', value: 'gsk-keep' });
  const failingUsage = new InMemoryUsageStore();
  failingUsage.importState = async () => { throw new Error('disk full'); };
  const target = new GatewayService(new ProviderRegistry(), connections, connections, new InMemoryApiKeyStore(), { usageStore: failingUsage });

  await assert.rejects(() => target.importBackup(passphrase, backup), /disk full/);
  assert.deepEqual((await connections.list()).map((entry) => entry.id), ['keep-me'], 'the connection store was not rolled back');
});
