import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore, createGatewayServer } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { LocalBatchStore } from '../dist/src/core/batches.js';

function provider() {
  return {
    id: 'p', name: 'p', capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat(request) {
      return { id: 'r', providerId: 'p', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'answer' }, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } };
    },
    async rerank(input) {
      return input.documents.map((document) => ({ index: document.index, relevanceScore: document.index === 1 ? 0.9 : 0.1 }));
    },
  };
}

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omni-batch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new ProviderRegistry().register(provider());
  const connections = new InMemoryConnectionStore();
  await connections.save({ id: 'conn', providerId: 'p', name: 'conn', endpoint: 'https://p.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', modelIds: [], customModelIds: [], resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } }, { type: 'api-key', value: 'k' });
  const apiKeys = new InMemoryApiKeyStore();
  const key = await apiKeys.create('batch');
  const service = new GatewayService(registry, new InMemorySecretStore({}), connections, apiKeys, { failureThreshold: 1_000, usageStore: new InMemoryUsageStore(), batches: new LocalBatchStore({ directory }) });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, key: key.key };
}

test('a batch runs one item, records the answer, and rerank orders documents', async (t) => {
  const { base, key } = await harness(t);
  const submitted = await fetch(`${base}/v1/batches`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ requests: [{ custom_id: 'one', body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] } }] }),
  });
  assert.equal(submitted.status, 202);
  const { batch } = await submitted.json();
  let record = batch;
  for (let attempt = 0; attempt < 60 && record.status === 'in_progress'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const read = await fetch(`${base}/v1/batches/${batch.id}`, { headers: { authorization: `Bearer ${key}` } });
    record = (await read.json()).batch;
  }
  assert.equal(record.status, 'completed');
  assert.equal(record.results[0].customId, 'one');
  assert.equal(record.results[0].ok, true);
  assert.equal(record.results[0].response.content, 'answer');

  const reranked = await fetch(`${base}/v1/rerank`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'm', query: 'q', documents: [{ text: 'a' }, { text: 'b' }] }),
  });
  assert.equal(reranked.status, 200);
  const body = await reranked.json();
  assert.equal(body.data.length, 2);
  assert.equal(body.data[1].relevanceScore, 0.9);
});
