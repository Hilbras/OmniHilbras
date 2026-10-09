import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore, createGatewayServer } from '../dist/index.js';
import { InMemorySecretStore, ProviderError, ProviderRegistry } from '@hilbras/omnihilbras';

/**
 * A failover is one logical request with two provider attempts. The usage record must show both, in order,
 * under one request id, so the page can say which connection failed and which one answered.
 */

function provider(id, { failWith } = {}) {
  return {
    id,
    name: id,
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'm', providerId: id }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat() {
      if (failWith) throw failWith;
      return {
        id: 'r', providerId: id, model: 'm', createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: 'the answer' }, finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 4 },
      };
    },
  };
}

const connection = (id, providerId, priority) => ({
  id, providerId, name: id, endpoint: `https://${providerId}.example/v1`, priority,
  enabled: true, proxyPool: 'none', modelPolicy: 'all',
  resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 },
});

test('a failover is recorded as one request with both attempts, in order, under one request id', async (t) => {
  const registry = new ProviderRegistry()
    .register(provider('first', { failWith: new ProviderError('PROVIDER_UNAVAILABLE', 'upstream 503', { providerId: 'first', retryable: true }) }))
    .register(provider('second'));
  const store = new InMemoryConnectionStore();
  await store.save(connection('conn-first', 'first', 1), { type: 'api-key', value: 'k1' });
  await store.save(connection('conn-second', 'second', 2), { type: 'api-key', value: 'k2' });
  const usage = new InMemoryUsageStore();
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('failover-path')).key;
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000, usageStore: usage });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const answer = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(answer.status, 200, 'the second connection answers, so the client sees success');

  const [record] = await usage.list();
  assert.equal(record.outcome, 'success');
  assert.equal(record.attempts, 2, 'the total still counts both attempts');
  assert.match(record.requestId ?? '', /^[0-9a-f]{32}$/, 'the record carries the request id from its scope');
  assert.deepEqual(
    record.path.map((attempt) => [attempt.connectionId, attempt.outcome]),
    [['conn-first', 'failure'], ['conn-second', 'success']],
    'the failover is visible in order: which connection failed, then which one answered',
  );
  assert.equal(record.path[0].errorCode, 'PROVIDER_UNAVAILABLE');
  assert.ok(record.path.every((attempt) => attempt.dispatched === true), 'both attempts were actually sent');
});
