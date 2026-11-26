import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { LocalAuditStore } from '../dist/src/core/audit.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

async function start(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omni-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditStore = new LocalAuditStore({ directory });
  const apiKeys = new InMemoryApiKeyStore();
  const owner = await apiKeys.create('Owner');
  const viewer = await apiKeys.create('Viewer', undefined, 'viewer');
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), apiKeys, { auditStore });
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, owner, viewer, service };
}

test('a management write is audited with actor, action, target and status', async (t) => {
  const { base, owner, service } = await start(t);
  const response = await fetch(`${base}/v1/connections/keyless`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${owner.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Keyless', endpoint: 'http://127.0.0.1:9', credential: 'none' }),
  });
  assert.equal(response.status, 200);

  let records = [];
  for (let attempt = 0; attempt < 20 && records.length === 0; attempt += 1) {
    records = await service.listAudit(10);
    if (records.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(records.length, 1);
  assert.equal(records[0].actor, `key:${owner.record.id}`);
  assert.equal(records[0].action, 'PUT');
  assert.equal(records[0].target, '/v1/connections/keyless');
  assert.equal(records[0].outcome, 200);
  assert.equal(JSON.stringify(records[0]).includes('Keyless'), false, 'the audit record must not carry the request body');
});

test('only an owner may read the audit trail', async (t) => {
  const { base, owner, viewer } = await start(t);
  const ownerRead = await fetch(`${base}/v1/audit`, { headers: { authorization: `Bearer ${owner.key}` } });
  assert.equal(ownerRead.status, 200);
  const viewerRead = await fetch(`${base}/v1/audit`, { headers: { authorization: `Bearer ${viewer.key}` } });
  assert.equal(viewerRead.status, 403);
  const badLimit = await fetch(`${base}/v1/audit?limit=0`, { headers: { authorization: `Bearer ${owner.key}` } });
  assert.equal(badLimit.status, 400);
});
