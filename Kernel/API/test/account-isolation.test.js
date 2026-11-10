import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * Multiple accounts of one provider must be separate routes.
 *
 * A `GatewayConnection` is the account. These tests pin the two properties that were missing before:
 * an explicit connection is honoured, and an authentication failure is not retried on another account.
 */

function adapter(captured, failAuth = false) {
  return {
    id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request) {
      captured.push(request);
      if (failAuth) throw new ProviderError('AUTHENTICATION_FAILED', 'The credential was refused.', { publicMessage: 'The credential was refused.' });
      return { id: 'r', providerId: 'p', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
    },
  };
}

async function serviceWith({ failAuth = false, secondEnabled = true } = {}) {
  const captured = [];
  const store = new InMemoryConnectionStore();
  const save = (id, priority, enabled = true) => store.save({
    id, providerId: 'p', name: id, endpoint: 'https://p.example/v1', priority, proxyPool: 'none', enabled, modelIds: ['m'],
  }, { type: 'api-key', value: 'key' });
  await save('first', 1);
  await save('second', 2, secondEnabled);
  const registry = new ProviderRegistry().register(adapter(captured, failAuth));
  return { captured, service: new GatewayService(registry, store, store, new InMemoryApiKeyStore(), {}) };
}

const request = (connectionId) => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...(connectionId ? { connectionId } : {}) });

test('an explicit connection selects that account, and no connection keeps priority order', async () => {
  const { service } = await serviceWith();
  const explicit = await service.chatWithFailover(request('second'));
  assert.equal(explicit.attempts[0].connectionId, 'second');

  const ordered = await service.chatWithFailover(request());
  assert.equal(ordered.attempts[0].connectionId, 'first');
});

test('an unknown explicit connection is refused instead of silently falling back', async () => {
  const { service } = await serviceWith();
  await assert.rejects(
    () => service.chatWithFailover(request('missing')),
    (error) => error instanceof ProviderError && error.code === 'INVALID_REQUEST' && /does not exist/.test(error.message),
  );
});

test('a disabled explicit account is not replaced by another account', async () => {
  const { captured, service } = await serviceWith({ secondEnabled: false });
  await assert.rejects(
    () => service.chatWithFailover(request('second')),
    (error) => error instanceof ProviderError && /no enabled provider|no provider|no route/i.test(error.message),
  );
  assert.equal(captured.length, 0, 'a disabled account must not dispatch, and no other account may take the request');
});

test('an authentication failure stops at that account instead of trying the next one', async () => {
  const { captured, service } = await serviceWith({ failAuth: true });
  await assert.rejects(
    () => service.chatWithFailover(request()),
    (error) => error instanceof ProviderError && error.code === 'AUTHENTICATION_FAILED',
  );
  assert.equal(captured.length, 1, 'the second account must receive zero dispatches after an auth failure');
});
