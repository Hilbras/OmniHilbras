import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '@omnihilbras/sdk';
import { createProviderRegistry, EnvironmentSecretStore, GatewayService, loadGatewayConfig } from '../dist/index.js';

test('gateway config loads local defaults and environment credentials', async () => {
  const config = loadGatewayConfig({
    OMNIHILBRAS_PORT: '9000',
    OPENAI_API_KEY: 'openai-secret',
    OMNIHILBRAS_COMPATIBLE_API_KEY: 'local-secret',
  });
  const secretStore = new EnvironmentSecretStore({
    OPENAI_API_KEY: 'openai-secret',
    OMNIHILBRAS_COMPATIBLE_API_KEY: 'local-secret',
  });

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 9000);
  assert.equal(config.compatible.authRequired, true);
  assert.deepEqual(await secretStore.get('openai'), { type: 'api-key', value: 'openai-secret' });
  assert.deepEqual(await secretStore.get('openai-compatible'), { type: 'api-key', value: 'local-secret' });
  assert.equal(await secretStore.get('gemini'), undefined);
});

test('gateway config registers all four provider adapters', () => {
  const config = loadGatewayConfig({});
  const transport = {
    async request() {
      throw new Error('network calls are not expected in configuration tests');
    },
    async *stream() {},
  };
  const registry = createProviderRegistry(config, transport);

  assert.deepEqual(registry.list().map((adapter) => adapter.id), ['openai', 'anthropic', 'gemini', 'openai-compatible']);
});

test('GatewayService stays provider-neutral while delegating calls', async () => {
  const adapter = {
    id: 'fake',
    name: 'Fake provider',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() {
      return [{ id: 'fake-1', providerId: 'fake' }];
    },
    async healthCheck() {
      return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 4 };
    },
    async chat(request, context) {
      return { id: 'response-1', providerId: 'fake', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: context.credential.value }, finishReason: 'stop' };
    },
    async *streamChat(request) {
      yield { id: 'chunk-1', providerId: 'fake', model: request.model, delta: { content: 'stream' } };
    },
  };
  const registry = new ProviderRegistry().register(adapter);
  const service = new GatewayService(registry, new InMemorySecretStore({ fake: { type: 'api-key', value: 'fake-secret' } }));

  const health = await service.health();
  const models = await service.listAllModels();
  const response = await service.chat('fake', { model: 'fake-1', messages: [{ role: 'user', content: 'Hello' }] });
  const chunks = [];
  for await (const chunk of service.streamChat('fake', { model: 'fake-1', messages: [{ role: 'user', content: 'Hello' }] })) chunks.push(chunk);

  assert.equal(health.status, 'ok');
  assert.deepEqual(models.models, [{ id: 'fake-1', providerId: 'fake' }]);
  assert.equal(response.message.content, 'fake-secret');
  assert.equal(chunks[0].delta.content, 'stream');
});
