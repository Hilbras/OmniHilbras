import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * The routed connection is the one whose credential is spent.
 *
 * Routing emits one candidate per **connection**, but dispatch used to pass only the provider id and
 * `CredentialManager` picked the provider's first connection with a credential. With two accounts the
 * request could be routed to, limited against, and recorded under account B while being billed to
 * account A's key. Nothing in the response revealed the substitution.
 */

function registry(seen) {
  const registry = new ProviderRegistry();
  registry.register({
    id: 'p',
    name: 'Provider P',
    capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    async listModels() {
      return [{ id: 'm', providerId: 'p' }];
    },
    async healthCheck() {
      return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' };
    },
    async chat(request, context) {
      const credential = context?.credential;
      const value = credential?.type === 'api-key' ? credential.value : undefined;
      seen.push(value);
      if (value === 'key-A') throw new ProviderError('PROVIDER_TIMEOUT', 'Account A timed out.', { providerId: 'p', retryable: true });
      return {
        id: 'resp',
        providerId: 'p',
        model: request.model,
        createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: `answered with ${value}` },
        finishReason: 'stop',
      };
    },
  });
  return registry;
}

const connection = (id, priority, resilience = {}) => ({
  id,
  providerId: 'p',
  name: `Account ${id}`,
  endpoint: 'https://p.example/v1',
  priority,
  proxyPool: 'none',
  enabled: true,
  modelPolicy: 'all',
  modelIds: ['m'],
  resilience,
});

test('failover spends the routed connection credential, not the first account key', async () => {
  const seen = [];
  const store = new InMemoryConnectionStore();
  await store.save(connection('account-a', 1, { maxRetries: 0 }), { type: 'api-key', value: 'key-A' });
  await store.save(connection('account-b', 2, { maxRetries: 0 }), { type: 'api-key', value: 'key-B' });

  const service = new GatewayService(registry(seen), store, store, new InMemoryApiKeyStore());
  const outcome = await service.chatWithFailover({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, 'p');

  assert.deepEqual(seen, ['key-A', 'key-B'], 'each attempt used its own account');
  assert.deepEqual(
    outcome.attempts.map((attempt) => [attempt.connectionId, attempt.providerId]),
    [['account-a', 'p'], ['account-b', 'p']],
    'the ledger names the account each attempt belonged to',
  );
  assert.match(outcome.response.message.content, /key-B/);
});

test('per-connection adapters are memoised by connection, not by provider', async () => {
  const seen = [];
  const store = new InMemoryConnectionStore();
  const service = new GatewayService(registry(seen), store, store, new InMemoryApiKeyStore());

  for (const [name, build] of [
    ['kimi', (id) => service.kimiCodeAdapter(id)],
    ['claude', (id) => service.claudeCodeAdapter(id)],
    ['kiro', (id) => service.kiroAdapter(id)],
    ['opencode', (id) => service.opencodeConsoleAdapter(id)],
    ['cline', (id) => service.clineAdapter(id)],
    ['gemini', (id) => service.geminiWebAdapter(id)],
    ['chatgpt', (id) => service.chatGptWebAdapter(id)],
  ]) {
    const first = build('account-a');
    assert.equal(build('account-a'), first, `${name}: the same connection must reuse its adapter`);
    assert.notEqual(build('account-b'), first, `${name}: a second account got the first account's adapter`);
  }
});

test('a direct chat on a named connection uses that connection credential', async () => {
  const seen = [];
  const store = new InMemoryConnectionStore();
  await store.save(connection('account-a', 1, { maxRetries: 0 }), { type: 'api-key', value: 'key-A' });
  await store.save(connection('account-b', 2, { maxRetries: 0 }), { type: 'api-key', value: 'key-B' });

  const service = new GatewayService(registry(seen), store, store, new InMemoryApiKeyStore());
  await service.chat('p', { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, undefined, undefined, 'account-b');

  assert.deepEqual(seen, ['key-B'], 'the explicitly named connection is the one read');
});
