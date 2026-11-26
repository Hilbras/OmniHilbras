import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore, createGatewayServer } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { principalFromAuth } from '../dist/src/core/principal.js';
import { SpendLedger } from '../dist/src/core/spend-ledger.js';

/**
 * A usage record must say who spent the request. Before 4.1 it could price a request but could not
 * answer "which key", so a shared gateway could not enforce or even report a per-key budget.
 */

function provider() {
  return {
    id: 'p',
    name: 'p',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat() {
      return {
        id: 'r', providerId: 'p', model: 'm', createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: 'ok' }, finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 6 },
      };
    },
  };
}

test('a key request is attributed to the key, its workspace, and is grouped by key', async (t) => {
  const registry = new ProviderRegistry().register(provider());
  const store = new InMemoryConnectionStore();
  await store.save({
    id: 'conn', providerId: 'p', name: 'conn', endpoint: 'https://p.example/v1', priority: 1,
    enabled: true, proxyPool: 'none', modelPolicy: 'all',
    resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 },
  }, { type: 'api-key', value: 'k1' });
  const directory = await mkdtemp(join(tmpdir(), 'omni-attribution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const usage = new InMemoryUsageStore();
  const ledger = new SpendLedger({ directory, flushDelayMs: 0 });
  const apiKeys = new InMemoryApiKeyStore();
  const key = await apiKeys.create('attributed', 'ws');
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000, usageStore: usage, spendLedger: ledger });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;

  const answer = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key.key}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(answer.status, 200);

  const [record] = await usage.list();
  assert.equal(record.actor, 'key');
  assert.equal(record.apiKeyId, key.record.id);
  assert.equal(record.apiKeyPrefix, key.record.prefix);
  assert.equal(record.workspaceId, 'ws');

  const filtered = await usage.list({ apiKeyId: key.record.id });
  assert.equal(filtered.length, 1, 'the usage query cannot filter by key');
  const summary = await usage.summary({ workspaceId: 'ws' });
  assert.equal(summary.byKey?.[0]?.apiKeyId, key.record.id);
  assert.equal(summary.byKey?.[0]?.requests, 1);

  let spend = await fetch(`${base}/v1/spend?scope=key&id=${key.record.id}&period=day`, {
    headers: { authorization: `Bearer ${key.key}` },
  });
  let body = await spend.json();
  for (let attempt = 0; attempt < 40 && body.spend?.requests !== 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    spend = await fetch(`${base}/v1/spend?scope=key&id=${key.record.id}&period=day`, {
      headers: { authorization: `Bearer ${key.key}` },
    });
    body = await spend.json();
  }
  assert.equal(spend.status, 200);
  assert.equal(body.ledger, true);
  assert.equal(body.scope, 'key');
  assert.equal(body.id, key.record.id);
  // The test adapter publishes no price, so the dollar figure is an honest 0 with the unpriced count.
  assert.equal(body.spend.requests, 1);
  assert.equal(body.spend.unpricedRequests, 1);
});

test('the principal keeps key attribution and never invents one for the dashboard', () => {
  const keyPrincipal = principalFromAuth({
    kind: 'api-key',
    tenant: { id: 'local' },
    apiKey: { id: 'key_a', prefix: 'ohk_abcd', role: 'owner', name: 'a', enabled: true, createdAt: '', updatedAt: '', requests: 0, workspaceId: 'ws' },
  });
  assert.deepEqual(keyPrincipal, { actor: 'key', apiKeyId: 'key_a', apiKeyPrefix: 'ohk_abcd', workspaceId: 'ws' });
  assert.equal(principalFromAuth({ kind: 'dashboard', tenant: { id: 'local' } }).actor, 'dashboard');
  assert.equal(principalFromAuth({ kind: 'system', tenant: { id: 'local' } }).actor, 'anonymous');
  assert.equal(principalFromAuth(undefined).actor, 'anonymous');
});

test('an old record without attribution reads as unattributed rather than as zero spend', async () => {
  const usage = new InMemoryUsageStore();
  await usage.record({ at: new Date().toISOString(), model: 'm', outcome: 'success', attempts: 1, latencyMs: 1 });
  const summary = await usage.summary();
  assert.equal(summary.records[0].actor, undefined);
  assert.equal(summary.byKey?.[0]?.apiKeyId, 'unattributed');
});
