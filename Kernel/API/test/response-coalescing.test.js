import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * One upstream call for a burst of identical requests.
 *
 * The response cache only helps a request that arrives after the first one *finished*; a burst of
 * identical requests all miss it and all reach the provider. These tests pin the coalescing that
 * closes that gap: the first request does the work, the rest wait for it, and a request the cache
 * would not have served (different model) is not coalesced.
 */

function adapter(calls) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request) {
      calls.push(request);
      await gate;
      return { id: `r${calls.length}`, providerId: 'p', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
    },
    release: () => release(),
  };
}

async function service() {
  const calls = [];
  const fake = adapter(calls);
  const store = new InMemoryConnectionStore();
  await store.save(
    { id: 'p', providerId: 'p', name: 'p', endpoint: 'https://p.example/v1', priority: 1, proxyPool: 'none', enabled: true, modelIds: ['m'] },
    { type: 'api-key', value: 'key' },
  );
  const registry = new ProviderRegistry().register(fake);
  return { calls, fake, service: new GatewayService(registry, store, store, new InMemoryApiKeyStore(), {}) };
}

const request = (model = 'm') => ({ model, messages: [{ role: 'user', content: 'hi' }] });

test('a burst of identical requests reaches the provider once, and every caller gets that answer', async () => {
  const { calls, fake, service: gateway } = await service();
  const first = gateway.chatWithFailover(request());
  const second = gateway.chatWithFailover(request());

  // Let the first request reach the adapter before releasing it, so a missed coalesce has had time
  // to become a second adapter call rather than a race the assertion wins by luck.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 1, 'the second identical request was sent upstream instead of waiting');

  fake.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(a.response.id, b.response.id, 'the two callers received different answers');
});

test('a different request is not coalesced onto the first', async () => {
  const { calls, fake, service: gateway } = await service();
  const first = gateway.chatWithFailover(request('m'));
  const other = gateway.chatWithFailover(request('other-model'));

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 2, 'a different model was coalesced onto an unrelated request');

  fake.release();
  await Promise.all([first, other]);
});

test('a request the cache would not serve is not coalesced', async () => {
  const { calls, fake, service: gateway } = await service();
  // A caller-pinned connection is deliberately uncacheable; two of them must both be sent.
  const pinned = { ...request(), connectionId: 'p' };
  const first = gateway.chatWithFailover(pinned);
  const second = gateway.chatWithFailover(pinned);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 2, 'a pinned request was coalesced even though the cache does not serve it');

  fake.release();
  await Promise.all([first, second]);
});