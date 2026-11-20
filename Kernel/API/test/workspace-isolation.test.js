import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, LocalConnectionStore } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';

// Phase 9 multi-user foundation (acceptance: "multi-user isolation tested"): a workspace-scoped listing shows
// only that workspace's connections plus unscoped shared ones. The unscoped operator view sees everything.
// The boundary of this phase is stated honestly: this is a listing filter, not per-request authorization on
// every route — that larger threading is deliberately left for a cloud/tenant deployment.

const conn = (id, workspaceId) => ({
  id,
  providerId: 'fake',
  name: id,
  endpoint: 'https://f.example/v1',
  priority: 1,
  enabled: true,
  proxyPool: 'none',
  modelPolicy: 'all',
  modelIds: [],
  customModelIds: [],
  resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 },
  ...(workspaceId === undefined ? {} : { workspaceId }),
});

async function serviceWith(t) {
  const dir = mkdtempSync(join(tmpdir(), 'oh-ws-iso-'));
  const store = new LocalConnectionStore({ directory: dir });
  await store.save(conn('shared'), { type: 'none' });
  await store.save(conn('teamA', 'team-alpha'), { type: 'none' });
  await store.save(conn('teamB', 'team-beta'), { type: 'none' });
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), store, new InMemoryApiKeyStore(), { failureThreshold: 1_000 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return service;
}

const ids = (records) => records.map((record) => record.id).sort();

test('a workspace sees only its own connections plus shared unscoped ones', async (t) => {
  const service = await serviceWith(t);
  assert.deepEqual(ids(await service.listConnectionsForWorkspace('team-alpha')), ['shared', 'teamA']);
  assert.deepEqual(ids(await service.listConnectionsForWorkspace('team-beta')), ['shared', 'teamB']);
  assert.deepEqual(ids(await service.listConnectionsForWorkspace('team-gamma')), ['shared'], 'an unknown workspace sees no scoped connection');
});

test('the unscoped operator view still sees everything', async (t) => {
  const service = await serviceWith(t);
  assert.deepEqual(ids(await service.listConnectionsForWorkspace()), ['shared', 'teamA', 'teamB']);
  assert.deepEqual(ids(await service.listConnections()), ['shared', 'teamA', 'teamB'], 'the existing list is unchanged');
});

test('a malformed workspaceId is refused at normalization', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-ws-bad-'));
  try {
    const store = new LocalConnectionStore({ directory: dir });
    await assert.rejects(
      store.save(conn('bad', '../etc'), { type: 'none' }),
      /workspaceId/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
