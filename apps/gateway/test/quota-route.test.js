import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

/**
 * `GET /v1/connections/:id/quota` — what the account behind a connection has left.
 *
 * This was one provider's route (`/v1/connections/kiro/quota`, reached through an `instanceof` branch
 * in the service) before it was generalised. The generalisation is the whole point of the change:
 * a second metered provider now implements `quota` on its adapter and needs no edit to the gateway.
 *
 * So this file asserts three things — the route is generic, it is still gated, and a provider that
 * publishes nothing is refused *by name* rather than answered with an empty balance.
 */

const KIRO_USAGE_URL = 'https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST';

function usageTransport(body, extra = {}) {
  return {
    async request(request) {
      if (request.url !== KIRO_USAGE_URL) throw new Error(`unexpected request to ${request.url}`);
      return { status: 200, headers: new Headers(), data: body };
    },
    stream() { throw new Error('not used'); },
    ...extra,
  };
}

async function start(t, { usage = {}, metered = true, transport, providerId = 'kiro' } = {}) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('quota')).key;
  const adapter = {
    id: providerId,
    name: providerId === 'kiro' ? 'Kiro' : 'Meterless',
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: 'claude-sonnet-4.5', providerId }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString() }; },
    async chat() { throw new Error('not used'); },
    // The member is optional, so an adapter that omits it must stay a working adapter — that is the
    // whole reason it is optional rather than required.
    ...(metered ? { async quota() { return (await usageTransport(usage, transport?.extra)).request({ url: KIRO_USAGE_URL }); } } : {}),
  };
  const registry = new ProviderRegistry().register(adapter);
  const store = new InMemoryConnectionStore();
  await store.save({ id: providerId, providerId, name: adapter.name, endpoint: 'https://example.invalid', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'oauth', value: 'access-token' });
  const secrets = new InMemorySecretStore({ [providerId]: { type: 'oauth', value: 'access-token' } });
  const service = new GatewayService(registry, secrets, store, apiKeys, { failureThreshold: 1_000, transport: usageTransport(usage) });
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

test('a metered provider answers with the plan and per-resource figures', async (t) => {
  const { base, key } = await start(t, { usage: { subscriptionInfo: { subscriptionTitle: 'Kiro Pro' }, nextDateReset: 1791000000, usageBreakdownList: [{ resourceType: 'AGENTIC_REQUEST', currentUsageWithPrecision: 120, usageLimitWithPrecision: 500 }] } });
  const response = await fetch(`${base}/v1/connections/kiro/quota`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plan, 'Kiro Pro');
  assert.deepEqual(body.resources.agentic_request, { used: 120, limit: 500, remaining: 380, resetsAt: new Date(1791000000 * 1000).toISOString() });
});

test('the route carries no provider of its own, so another one needs no edit here', async () => {
  // A route that names one provider is the thing this change exists to remove. The check reads the
  // source because the property *is* the absence of a literal, which no response shape could show.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/routes/connections.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('[^/]+\\/quota'), 'the generic quota route is gone');
  // The one provider that used to have its own quota route must no longer appear at all.
  assert.doesNotMatch(source, /'kiro'/, 'a provider id is back in this file, so the next metered provider needs another branch');
});

test('a provider that publishes no quota is refused by name, never answered with an empty balance', async (t) => {
  // These two look identical to a consumer and mean opposite things: the account having nothing left,
  // versus the provider never saying. An empty `resources: {}` would render as "no allowance".
  //
  // The provider here is one the SDK knows nothing about, so the resolver uses the adapter this test
  // registers. Registering it under a real provider's id would not test the case at all: the service
  // builds that provider's own adapter on demand, and that one does meter accounts.
  const { base, key } = await start(t, { usage: {}, metered: false, providerId: 'meterless' });
  const response = await fetch(`${base}/v1/connections/meterless/quota`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 501);
  const body = await response.json();
  assert.equal(body.error.code, 'NOT_SUPPORTED');
  assert.equal(body.resources, undefined, 'a refusal that still carries a resources map would render as an empty allowance');
});

test('the single-provider route is gone rather than kept alongside the general one', async (t) => {
  // Keeping both would leave two answers for one question, differing only in which branch matched first.
  const { base, key } = await start(t, { usage: {} });
  const response = await fetch(`${base}/v1/connections/kiro/quota`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type')?.includes('application/json'), true, 'the old route is answering instead of the general one');
});
