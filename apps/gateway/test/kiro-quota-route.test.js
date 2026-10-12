import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

/**
 * `GET /v1/connections/kiro/quota` is a management read. It must refuse a caller with no key and answer
 * a dashboard caller with the quota the Kiro adapter reports, in the documented shape.
 */

const KIRO_USAGE_URL = 'https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST';

function usageTransport(body) {
  return {
    async request(request) {
      if (request.url !== KIRO_USAGE_URL) throw new Error(`unexpected request to ${request.url}`);
      return { status: 200, headers: new Headers(), data: body };
    },
    stream() { throw new Error('not used'); },
  };
}

async function start(t, { usage } = {}) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('quota')).key;
  const registry = new ProviderRegistry().register({
    id: 'kiro',
    name: 'Kiro',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'claude-sonnet-4.5', providerId: 'kiro' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString() }; },
    async chat() { throw new Error('not used'); },
  });
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'kiro', providerId: 'kiro', name: 'Kiro', endpoint: 'https://codewhisperer.us-east-1.amazonaws.com', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'oauth', value: 'access-token' });
  const secrets = new InMemorySecretStore({ kiro: { type: 'oauth', value: 'access-token' } });
  const transport = usageTransport(usage);
  const service = new GatewayService(registry, secrets, store, apiKeys, { failureThreshold: 1_000, transport });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, key };
}

test('an unauthenticated quota read is refused with 401', async (t) => {
  const { base } = await start(t, { usage: {} });
  const response = await fetch(`${base}/v1/connections/kiro/quota`);
  assert.equal(response.status, 401);
});

test('an authenticated quota read returns the plan and per-resource figures', async (t) => {
  const { base, key } = await start(t, { usage: { subscriptionInfo: { subscriptionTitle: 'Kiro Pro' }, nextDateReset: 1791000000, usageBreakdownList: [{ resourceType: 'AGENTIC_REQUEST', currentUsageWithPrecision: 120, usageLimitWithPrecision: 500 }] } });
  const response = await fetch(`${base}/v1/connections/kiro/quota`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'kiro.quota');
  assert.equal(body.provider, 'kiro');
  assert.equal(body.plan, 'Kiro Pro');
  assert.deepEqual(body.resources.agentic_request, { used: 120, limit: 500, remaining: 380, resetsAt: new Date(1791000000 * 1000).toISOString() });
});
