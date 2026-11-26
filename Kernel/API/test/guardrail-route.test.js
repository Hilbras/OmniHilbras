import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { LocalGuardrailStore } from '../dist/src/core/guardrails.js';

function provider() {
  return {
    id: 'p', name: 'p', capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat() { return { id: 'r', providerId: 'p', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }; },
  };
}

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omni-guard-route-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'conn', providerId: 'p', name: 'conn', endpoint: 'https://p.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', modelIds: [], customModelIds: [], resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } }, { type: 'api-key', value: 'k' });
  const apiKeys = new InMemoryApiKeyStore();
  const key = await apiKeys.create('guard');
  const guardrails = new LocalGuardrailStore({ directory });
  const service = new GatewayService(new ProviderRegistry().register(provider()), new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000, guardrails });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, key: key.key };
}

const chat = (base, key) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'tell me about project-x' }] }),
});

test('a block rule refuses before dispatch, a dry run reports without refusing', async (t) => {
  const { base, key } = await harness(t);
  const saved = await fetch(`${base}/v1/guardrails`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ enabled: true, rules: [{ id: 'no-project-x', action: 'block', text: 'project-x' }] }),
  });
  assert.equal(saved.status, 200);

  const refused = await chat(base, key);
  assert.equal(refused.status, 422);
  const body = await refused.json();
  assert.equal(body.error.code, 'GUARDRAIL_BLOCKED');
  assert.equal(body.error.rules[0].id, 'no-project-x');

  await fetch(`${base}/v1/guardrails`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ enabled: true, dryRun: true, rules: [{ id: 'no-project-x', action: 'block', text: 'project-x' }] }),
  });
  const allowed = await chat(base, key);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('x-omnihilbras-guardrail'), 'dry-run');
});

test('a rule with an unreadable shape is refused rather than silently dropped', async (t) => {
  const { base, key } = await harness(t);
  const refused = await fetch(`${base}/v1/guardrails`, {
    method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ enabled: true, rules: [{ id: 'broken', action: 'block' }] }),
  });
  assert.equal(refused.status, 400);
});
