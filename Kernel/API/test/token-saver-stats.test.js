import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { startRequestScope } from '../dist/src/core/request-context.js';
import {
  GatewayService,
  InMemoryApiKeyStore,
  InMemoryConnectionStore,
  InMemoryUsageStore,
  createGatewayServer,
} from '../dist/src/index.js';

/** Savings are only useful if they survive the request and can be aggregated per saver. */

test('the gateway keeps telemetry for one request and hands it over once', async () => {
  const registry = new ProviderRegistry().register({
    id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request) { return { id: 'r', providerId: 'p', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }; },
  });
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'p', providerId: 'p', name: 'P', endpoint: 'https://p.example/v1', priority: 1, proxyPool: 'none', modelIds: ['m'] }, { type: 'api-key', value: 'key' });
  const service = new GatewayService(registry, store, store, new InMemoryApiKeyStore(), {
    tokenSaver: { enabled: true, targetRatio: 0.4, protectRecent: 0, compressUsers: false, compressCode: false, reversible: true, ccrLimit: 10 },
  });
  const scope = startRequestScope({ requestedModel: 'm', id: 'telemetry-test' });
  const log = Array.from({ length: 100 }, (_, index) => `2026-01-01 INFO line ${index}`).join('\n') + '\n2026-01-01 ERROR FATAL: nope';
  await service.chatWithFailover({ model: 'm', messages: [{ role: 'tool', content: log }] }, 'p', undefined, scope);
  const telemetry = service.takeCompressionTelemetry(scope.id);
  assert.ok(telemetry);
  assert.ok(telemetry.totalTokensSaved > 0);
  assert.ok(telemetry.totalBytesSaved > 0);
  assert.ok(telemetry.savers.log);
  assert.equal(service.takeCompressionTelemetry(scope.id), undefined, 'telemetry was handed out twice');
});

test('the stats route aggregates per saver, provider and cache', async (t) => {
  const usage = new InMemoryUsageStore();
  await usage.record({
    at: new Date().toISOString(), model: 'm', providerId: 'openai', outcome: 'success', attempts: 1, latencyMs: 10,
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 40,
    compression: { totalTokensSaved: 500, totalBytesSaved: 2_000, savers: { log: { kind: 'log', requests: 1, tokensSaved: 500, bytesBefore: 3_000, bytesAfter: 1_000 } } },
  });
  await usage.record({ at: new Date().toISOString(), model: 'm', providerId: 'openai', outcome: 'success', attempts: 1, latencyMs: 5, inputTokens: 20, outputTokens: 2 });

  const keys = new InMemoryApiKeyStore();
  const key = (await keys.create('stats')).key;
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), keys, { usageStore: usage });
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/v1/token-saver/stats?period=7d`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.requests, 2);
  assert.equal(body.requestsWithTelemetry, 1);
  assert.equal(body.requestsWithSavings, 1);
  assert.equal(body.totalTokensSaved, 500);
  assert.equal(body.cache.read, 40);
  assert.deepEqual(body.savers[0], { id: 'log', kind: 'log', requests: 1, requestsWithSavings: 1, tokensSaved: 500, bytesSaved: 2_000 });
  assert.equal(body.byProvider[0].providerId, 'openai');
  assert.equal(body.byProvider[0].tokensSaved, 500);
});
