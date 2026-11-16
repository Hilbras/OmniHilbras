import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptBackup, encryptBackup } from '../dist/src/core/backup.js';
import { InMemoryMitmStore } from '../dist/src/core/mitm.js';
import { InMemoryProviderNodeStore } from '../dist/src/core/provider-nodes.js';
import { InMemoryProxyPoolStore } from '../dist/src/core/proxy-pools.js';
import { InMemorySkillStore } from '../dist/src/core/skills.js';
import { InMemoryTunnelStore } from '../dist/src/core/tunnels.js';
import { InMemoryUsageStore } from '../dist/src/core/usage-store.js';
import { InMemoryVirtualModelStore } from '../dist/src/core/virtual-models.js';
import { InMemoryWorkspaceStore } from '../dist/src/core/workspaces.js';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * What an exported file actually contains, read back by decrypting it rather than by trusting the button.
 *
 * The version-1 payload carried three sections of the eleven an installation persists — connections, their
 * strategies and the API keys — so a restore rebuilt the connections and left the usage history, the
 * virtual models and five more stores on the machine the backup came from, while the dashboard reported
 * success. These tests exist so that gap cannot come back quietly: a store added to the gateway and not to
 * the export fails here rather than in a user's restore.
 */

const passphrase = 'correct horse battery';

/** One gateway holding a record in every store a backup carries. */
async function fullGateway() {
  const connections = new InMemoryConnectionStore();
  await connections.save({
    id: 'alpha',
    providerId: 'openrouter',
    name: 'Alpha',
    endpoint: 'https://openrouter.ai/api/v1',
    priority: 1,
    proxyPool: 'none',
  }, { type: 'api-key', value: 'sk-alpha-secret' });
  await connections.save({
    id: 'keyless',
    providerId: 'ollama',
    name: 'Local',
    endpoint: 'http://127.0.0.1:11434/v1',
    priority: 2,
    proxyPool: 'none',
  }, { type: 'none' });

  const apiKeys = new InMemoryApiKeyStore();
  await apiKeys.create('laptop');

  const usageStore = new InMemoryUsageStore();
  await usageStore.record({ at: new Date().toISOString(), model: 'gpt-6-luna', providerId: 'openrouter', connectionId: 'alpha', outcome: 'success', attempts: 1, latencyMs: 120 });

  const virtualModels = new InMemoryVirtualModelStore();
  await virtualModels.save({ id: 'oh/free-fallback', name: 'Free fallback', targets: [{ connectionId: 'alpha', upstreamModelId: 'gpt-6-luna' }] });

  const skills = new InMemorySkillStore();
  await skills.save({ id: 'review', name: 'Review', content: 'Read the diff.' });
  const workspaces = new InMemoryWorkspaceStore();
  await workspaces.save({ id: 'ws-1', name: 'Workspace' });
  const tunnels = new InMemoryTunnelStore();
  await tunnels.save({ id: 'tn-1', name: 'Tunnel' });
  const mitm = new InMemoryMitmStore();
  await mitm.save({ id: 'm-1', name: 'Policy' });
  const proxyPools = new InMemoryProxyPoolStore();
  await proxyPools.save({ id: 'pp-1', name: 'Pool' });
  const providerNodes = new InMemoryProviderNodeStore();
  await providerNodes.save({ id: 'pn-1', name: 'Node' });

  const service = new GatewayService(new ProviderRegistry(), connections, connections, apiKeys, {
    usageStore,
    virtualModels,
    skills,
    workspaces,
    tunnels,
    mitm,
    proxyPools,
    providerNodes,
  });
  return { service, connections, apiKeys, usageStore, virtualModels, skills, workspaces, tunnels, mitm, proxyPools, providerNodes };
}

const sections = ['connections', 'apiKeys', 'usage', 'virtualModels', 'skills', 'workspaces', 'tunnels', 'proxyPools', 'providerNodes', 'mitm'];

test('an export carries a section for every store the gateway persists', async () => {
  const { service } = await fullGateway();
  const payload = decryptBackup(await service.exportBackup(passphrase), passphrase);
  assert.equal(payload.format, 'omnihilbras-gateway-backup');
  assert.equal(payload.version, 2);
  for (const name of sections) {
    assert.notEqual(payload[name], undefined, `the ${name} section did not travel`);
  }
  assert.equal(payload.connections.connections.length, 2);
  assert.equal(payload.apiKeys.keys.length, 1);
  assert.equal(payload.usage.records.length, 1);
  assert.equal(payload.virtualModels.models.length, 1);
  assert.equal(payload.skills.skills.length, 1);
  assert.equal(payload.connections.aliases !== undefined, true, 'the alias map is not carried');
});

test('every credential shape survives the round trip, including a connection with none', async () => {
  const source = await fullGateway();
  await source.connections.save({
    id: 'oauth-one',
    providerId: 'kiro',
    name: 'Kiro',
    endpoint: 'https://api.kiro.dev',
    priority: 3,
    proxyPool: 'none',
  }, {
    type: 'oauth',
    value: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: '2030-01-01T00:00:00.000Z',
    email: 'person@example.com',
    orgId: 'org-1',
    orgName: 'Org',
    accountId: 'acct-1',
    oauthClientId: 'client-id',
    oauthClientSecret: 'client-secret',
    region: 'us-east-1',
    name: 'Kiro account',
  });
  const backup = await source.service.exportBackup(passphrase);
  assert.equal(JSON.stringify(backup).includes('sk-alpha-secret'), false, 'a credential left in clear');

  const target = await fullGateway();
  await target.connections.save({ id: 'stale', providerId: 'groq', name: 'Stale', endpoint: 'https://api.groq.com/openai/v1', priority: 9, proxyPool: 'none' }, { type: 'api-key', value: 'gsk-stale' });
  await target.service.importBackup(passphrase, backup);

  assert.deepEqual(await target.connections.get('oauth-one'), {
    type: 'oauth',
    value: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: '2030-01-01T00:00:00.000Z',
    email: 'person@example.com',
    orgId: 'org-1',
    orgName: 'Org',
    accountId: 'acct-1',
    oauthClientId: 'client-id',
    oauthClientSecret: 'client-secret',
    region: 'us-east-1',
    name: 'Kiro account',
  });
  assert.deepEqual(await target.connections.get('keyless'), { type: 'none' });
  assert.equal(await target.connections.get('stale'), undefined, 'the replaced installation kept a connection');
  assert.equal((await target.usageStore.list()).length, 1, 'the usage history did not arrive');
  assert.equal((await target.virtualModels.list()).length, 1, 'the virtual models did not arrive');
  assert.equal((await target.skills.list()).length, 1, 'the skills did not arrive');
});

test('a section that cannot be read refuses the whole import and changes nothing', async () => {
  const source = await fullGateway();
  const payload = decryptBackup(await source.service.exportBackup(passphrase), passphrase);
  payload.usage = { version: 99, records: [] };
  const broken = encryptBackup(payload, passphrase);

  const target = await fullGateway();
  await target.connections.save({ id: 'keep-me', providerId: 'groq', name: 'Keep', endpoint: 'https://api.groq.com/openai/v1', priority: 5, proxyPool: 'none' }, { type: 'api-key', value: 'gsk-keep' });
  const before = (await target.connections.list()).map((connection) => connection.id).sort();

  await assert.rejects(() => target.service.importBackup(passphrase, broken), /usage section is not readable/);
  assert.deepEqual((await target.connections.list()).map((connection) => connection.id).sort(), before, 'a refused import still replaced the connections');
  assert.equal(await target.connections.get('keep-me') !== undefined, true, 'the credential was lost by a refused import');
});

const legacyRecord = {
  priority: 1,
  proxyPool: 'none',
  enabled: true,
  hasCredential: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

test('a version-1 payload still imports, and its keyless connection is no longer dropped', async () => {
  const legacy = encryptBackup({
    format: 'omnihilbras-gateway-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    // The record shape a version-1 file really held: `list()` output, which carries the stored metadata.
    connections: [
      { connection: { ...legacyRecord, id: 'alpha', providerId: 'openrouter', name: 'Alpha', endpoint: 'https://openrouter.ai/api/v1' }, credential: { type: 'api-key', value: 'sk-alpha-secret' } },
      { connection: { ...legacyRecord, id: 'keyless', providerId: 'ollama', name: 'Local', endpoint: 'http://127.0.0.1:11434/v1' } },
    ],
    strategies: { openrouter: 'fastest' },
    apiKeys: { version: 1, requireApiKey: false, keys: [] },
  }, passphrase);

  const target = await fullGateway();
  await target.connections.save({ id: 'stale', providerId: 'groq', name: 'Stale', endpoint: 'https://api.groq.com/openai/v1', priority: 9, proxyPool: 'none' }, { type: 'api-key', value: 'gsk-stale' });
  const result = await target.service.importBackup(passphrase, legacy);

  assert.equal(result.connections, 2);
  assert.equal(result.removed, 3);
  assert.deepEqual(await target.connections.get('alpha'), { type: 'api-key', value: 'sk-alpha-secret' });
  // The record survives, and no credential is invented for it: a file that carried none says nothing about
  // a key, so writing `{ type: 'none' }` here would be the same class of lie as dropping the record.
  assert.deepEqual((await target.connections.list()).map((connection) => connection.id).sort(), ['alpha', 'keyless'], 'the keyless connection vanished again');
  assert.equal(await target.connections.get('keyless'), undefined, 'a credential appeared for a connection the file had none for');
  assert.equal(result.strategies, 1);
  assert.equal(await target.apiKeys.isEnforced(), false);
});

test('a section the file does not carry is left alone rather than cleared', async () => {
  const source = await fullGateway();
  const payload = decryptBackup(await source.service.exportBackup(passphrase), passphrase);
  delete payload.usage;
  const withoutUsage = encryptBackup(payload, passphrase);

  const target = await fullGateway();
  await target.usageStore.record({ at: new Date().toISOString(), model: 'kept', outcome: 'success', attempts: 1, latencyMs: 5 });
  const result = await target.service.importBackup(passphrase, withoutUsage);

  assert.equal((await target.usageStore.list()).length, 2, 'an absent section cleared records the file never mentioned');
  assert.deepEqual(result.notCarried, ['usage']);
});
