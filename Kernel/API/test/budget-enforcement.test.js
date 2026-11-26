import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore, createGatewayServer } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { SpendLedger } from '../dist/src/core/spend-ledger.js';
import { LocalWorkspaceStore } from '../dist/src/core/workspaces.js';

function provider(id = 'p') {
  return {
    id,
    name: id,
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'm', providerId: id }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat() {
      return {
        id: 'r', providerId: id, model: 'm', createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: 'ok' }, finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 4 },
      };
    },
  };
}

const connection = {
  id: 'conn', providerId: 'p', name: 'conn', endpoint: 'https://p.example/v1', priority: 1,
  enabled: true, proxyPool: 'none', modelPolicy: 'all',
  resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 },
};

async function harness(t, { budget, workspaceBudget, workspaceId } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'omni-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new ProviderRegistry().register(provider());
  const store = new InMemoryConnectionStore();
  await store.save(connection, { type: 'api-key', value: 'k1' });
  const usage = new InMemoryUsageStore();
  const ledger = new SpendLedger({ directory, flushDelayMs: 0 });
  const apiKeys = new InMemoryApiKeyStore();
  const workspaces = new LocalWorkspaceStore({ directory });
  if (workspaceId && workspaceBudget) await workspaces.save({ id: workspaceId, budget: workspaceBudget });
  const key = await apiKeys.create('budgeted', workspaceId);
  if (budget) await apiKeys.setLimits(key.record.id, { budget });
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, {
    failureThreshold: 1_000,
    usageStore: usage,
    spendLedger: ledger,
    workspaces,
  });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { service, usage, ledger, key, base, apiKeys };
}

function chat(base, key) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 }),
  });
}

test('a key at its daily dollar budget is refused before the provider, with the reset time', async (t) => {
  const { key, base, ledger, usage } = await harness(t, { budget: { usd: 1, period: 'day' } });
  await ledger.record({ scope: 'key', id: key.record.id, usdMicros: 1_000_000 });

  const refused = await chat(base, key.key);
  assert.equal(refused.status, 402);
  const body = await refused.json();
  assert.equal(body.error.code, 'BUDGET_EXCEEDED');
  assert.ok(body.error.resetAt, 'the refusal does not say when the budget resets');
  assert.equal(refused.headers.get('x-omnihilbras-budget-remaining-usd'), '0.000000');
  assert.ok(refused.headers.get('retry-after'), 'a refusal a client can retry has no retry-after');
  assert.equal((await usage.list()).length, 0, 'a refused request reached the usage store');
});

test('a workspace default applies when the key has no budget of its own', async (t) => {
  const { key, base, ledger } = await harness(t, { workspaceId: 'ws', workspaceBudget: { usd: 1, period: 'month' } });
  await ledger.record({ scope: 'workspace', id: 'ws', usdMicros: 1_000_000 });
  const refused = await chat(base, key.key);
  assert.equal(refused.status, 402);
  assert.match((await refused.json()).error.message, /workspace|month/);
});

test('a request under budget succeeds, settles into the ledger, and is attributed to the key', async (t) => {
  const { key, base, ledger, usage } = await harness(t, { budget: { usd: 1, period: 'day' } });
  const answer = await chat(base, key.key);
  assert.equal(answer.status, 200);
  const [record] = await usage.list();
  assert.equal(record.actor, 'key');
  assert.equal(record.apiKeyId, key.record.id);
  assert.equal(record.apiKeyPrefix, key.record.prefix);
  // The record write and the ledger settlement are intentionally off the response path.
  let spend = await ledger.snapshot('key', key.record.id, 'day');
  for (let attempt = 0; attempt < 40 && spend.requests === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    spend = await ledger.snapshot('key', key.record.id, 'day');
  }
  assert.equal(spend.requests, 1, 'a successful request did not settle into the ledger');
  assert.equal(spend.tokens, 7);
});

test('a token quota refuses after the settled tokens cross it, and tpm throttles the next request', async (t) => {
  const quota = await harness(t, { budget: { tokens: 1, period: 'day' } });
  assert.equal((await chat(quota.base, quota.key.key)).status, 200, 'the first request below the quota was refused');
  const refused = await chat(quota.base, quota.key.key);
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).error.code, 'QUOTA_EXCEEDED');

  const tpm = await harness(t);
  await tpm.apiKeys.setLimits(tpm.key.record.id, { tpm: 1 });
  assert.equal((await chat(tpm.base, tpm.key.key)).status, 200, 'the first request of a token window must be allowed');
  const throttled = await chat(tpm.base, tpm.key.key);
  assert.equal(throttled.status, 429);
  assert.ok(throttled.headers.get('retry-after'));
});

test('a model allowlist refuses a model the key may not request', async (t) => {
  const { key, base, apiKeys } = await harness(t);
  await apiKeys.setLimits(key.record.id, { allowedModels: ['gpt-*'] });
  const refused = await chat(base, key.key);
  assert.equal(refused.status, 403);
  const body = await refused.json();
  assert.equal(body.error.code, 'POLICY_DENIED');
  assert.match(body.error.message, /may not request m/);
});

test('a route allowlist refuses a route the key may not call', async (t) => {
  const { key, base, apiKeys } = await harness(t);
  await apiKeys.setLimits(key.record.id, { allowedRoutes: ['/v1/models'] });
  const refused = await chat(base, key.key);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error.code, 'POLICY_DENIED');
});
