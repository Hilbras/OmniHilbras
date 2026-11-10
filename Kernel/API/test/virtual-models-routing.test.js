import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryVirtualModelStore, ProviderError, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * One `oh/` id, several providers.
 *
 * The adapter must see the target's upstream model id, not the public alias, and the virtual strategy is
 * the only thing deciding who is tried first.
 */

function adapter(id, captured, { delayMs = 0, failAuth = false } = {}) {
  return {
    id, name: id, capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    async listModels() { return [{ id: `model-${id}`, providerId: id }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request) {
      captured.push({ providerId: id, model: request.model });
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (failAuth) throw new ProviderError('AUTHENTICATION_FAILED', 'refused', { publicMessage: 'refused' });
      return { id: 'r', providerId: id, model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
    },
  };
}

async function setup({ strategy = 'priority', failFirst = false, slowFirst = false } = {}) {
  const captured = [];
  const store = new InMemoryConnectionStore();
  const save = (id, providerId, priority, modelId) => store.save({
    id, providerId, name: id, endpoint: `https://${providerId}.example/v1`, priority, proxyPool: 'none', enabled: true, modelIds: [modelId],
  }, { type: 'api-key', value: 'key' });
  await save('conn-a', 'a', 1, 'model-a');
  await save('conn-b', 'b', 2, 'model-b');
  const registry = new ProviderRegistry()
    .register(adapter('a', captured, { delayMs: slowFirst ? 15 : 0, failAuth: failFirst }))
    .register(adapter('b', captured, { delayMs: 1 }));
  const virtual = new InMemoryVirtualModelStore();
  await virtual.save({
    id: 'oh/chat', name: 'Chat', strategy, targets: [
      { connectionId: 'conn-a', upstreamModelId: 'model-a', priority: 1 },
      { connectionId: 'conn-b', upstreamModelId: 'model-b', priority: 2 },
    ],
  });
  const service = new GatewayService(registry, store, store, new InMemoryApiKeyStore(), { virtualModels: virtual });
  return { captured, service, virtual };
}

const request = { model: 'oh/chat', messages: [{ role: 'user', content: 'hi' }] };

test('a virtual model sends the target upstream model, not the oh/ alias', async () => {
  const { captured, service } = await setup();
  const outcome = await service.chatWithFailover(request);
  assert.equal(outcome.attempts[0].connectionId, 'conn-a');
  assert.equal(captured[0].model, 'model-a');
});

test('priority follows target priority; round-robin alternates', async () => {
  const priority = await setup();
  await priority.service.chatWithFailover(request);
  assert.equal(priority.captured[0].providerId, 'a');

  const roundRobin = await setup({ strategy: 'round-robin' });
  await roundRobin.service.chatWithFailover(request);
  await roundRobin.service.chatWithFailover(request);
  assert.deepEqual(roundRobin.captured.map((entry) => entry.providerId), ['a', 'b']);
});

test('fastest prefers the measured faster account after both have a reading', async () => {
  const { service, captured, virtual } = await setup({ strategy: 'round-robin', slowFirst: true });
  // Record one measured success per account, then switch the same model to fastest.
  await service.chatWithFailover(request);
  await service.chatWithFailover(request);
  const current = (await virtual.list())[0];
  await virtual.save({ ...current, strategy: 'fastest' });
  await service.chatWithFailover(request);
  assert.deepEqual(captured.map((entry) => entry.providerId), ['a', 'b', 'b'], 'the measured faster account should win');
});

test('an authentication failure in one target is not retried on another target', async () => {
  const { captured, service } = await setup({ failFirst: true });
  await assert.rejects(
    () => service.chatWithFailover(request),
    (error) => error instanceof ProviderError && error.code === 'AUTHENTICATION_FAILED',
  );
  assert.deepEqual(captured.map((entry) => entry.providerId), ['a']);
});

test('an unknown or disabled virtual id does not fall through to concrete routing', async () => {
  const { service, virtual } = await setup();
  await assert.rejects(() => service.chatWithFailover({ ...request, model: 'oh/missing' }), /does not exist/);
  await virtual.save({ id: 'oh/chat', enabled: false, targets: [] });
  await assert.rejects(() => service.chatWithFailover(request), /no enabled provider|no provider|no route/i);
});
