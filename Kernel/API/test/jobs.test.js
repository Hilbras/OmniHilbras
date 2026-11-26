import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { LocalJobStore } from '../dist/src/core/jobs.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omni-jobs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a job run is durable across a restart and keeps its duration and outcome', async (t) => {
  const directory = await tempDir(t);
  const first = new LocalJobStore({ directory });
  await first.record({ name: 'health', durationMs: 12, outcome: 'ok', detail: '2 providers' });
  const reopened = new LocalJobStore({ directory });
  const [run] = await reopened.list();
  assert.equal(run?.name, 'health');
  assert.equal(run?.durationMs, 12);
  assert.equal(run?.outcome, 'ok');
  assert.equal(run?.detail, '2 providers');
});

test('a health sweep records itself, and the route is owner-only', async (t) => {
  const directory = await tempDir(t);
  const jobStore = new LocalJobStore({ directory });
  const apiKeys = new InMemoryApiKeyStore();
  const owner = await apiKeys.create('Owner');
  const viewer = await apiKeys.create('Viewer', undefined, 'viewer');
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), apiKeys, { jobStore });
  await service.refreshHealth();

  let runs = [];
  for (let attempt = 0; attempt < 40 && runs.length === 0; attempt += 1) {
    runs = await service.listJobs();
    if (runs.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(runs[0]?.name, 'health');
  assert.equal(runs[0]?.outcome, 'ok');
  assert.ok((runs[0]?.durationMs ?? -1) >= 0);

  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ownerRead = await fetch(`${base}/v1/jobs`, { headers: { authorization: `Bearer ${owner.key}` } });
  assert.equal(ownerRead.status, 200);
  assert.ok((await ownerRead.json()).data.some((run) => run.name === 'health'));
  const viewerRead = await fetch(`${base}/v1/jobs`, { headers: { authorization: `Bearer ${viewer.key}` } });
  assert.equal(viewerRead.status, 403);
  const badLimit = await fetch(`${base}/v1/jobs?limit=0`, { headers: { authorization: `Bearer ${owner.key}` } });
  assert.equal(badLimit.status, 400);
});
