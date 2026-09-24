import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderError, ProviderRegistry } from '@omnihilbras/sdk';
import { createProviderRegistry, EnvironmentSecretStore, GatewayService, InMemoryConnectionStore, loadGatewayConfig, startGatewayServer } from '../dist/index.js';

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
  assert.deepEqual(config.corsOrigins, ['http://localhost:5173', 'http://127.0.0.1:5173']);
  assert.equal(config.compatible.authRequired, true);
  assert.deepEqual(await secretStore.get('openai'), { type: 'api-key', value: 'openai-secret' });
  assert.deepEqual(await secretStore.get('openai-compatible'), { type: 'api-key', value: 'local-secret' });
  assert.equal(await secretStore.get('gemini'), undefined);
});

test('gateway config rejects non-loopback hosts and wildcard CORS', () => {
  assert.throws(() => loadGatewayConfig({ OMNIHILBRAS_HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => loadGatewayConfig({ OMNIHILBRAS_HOST: '127.999.999.999' }), /loopback/);
  assert.throws(() => loadGatewayConfig({ OMNIHILBRAS_HOST: '127.000.000.001' }), /loopback/);
  assert.throws(() => loadGatewayConfig({ OMNIHILBRAS_CORS_ORIGINS: '*' }), /wildcard/);
  assert.throws(() => loadGatewayConfig({ OMNIHILBRAS_MASTER_KEY: 'not-a-32-byte-key' }), /32 bytes/);
  assert.equal(loadGatewayConfig({ OMNIHILBRAS_HOST: 'localhost' }).host, '127.0.0.1');
  assert.equal(loadGatewayConfig({ OMNIHILBRAS_HOST: '[::1]' }).host, '::1');
});

test('startGatewayServer canonicalizes and binds a loopback address', async (t) => {
  const config = loadGatewayConfig({ OMNIHILBRAS_HOST: 'localhost' });
  const instance = await startGatewayServer({ config: { ...config, port: 0 } });
  t.after(() => instance.server.close());
  const address = instance.server.address();
  assert.equal(instance.config.host, '127.0.0.1');
  assert.equal(typeof address, 'object');
  assert.equal(address.address, '127.0.0.1');
});

test('gateway config uses the custom compatible provider credential and paths', async () => {
  const config = loadGatewayConfig({
    OMNIHILBRAS_COMPATIBLE_PROVIDER_ID: 'acme',
    ACME_API_KEY: 'acme-secret',
    OMNIHILBRAS_COMPATIBLE_MODELS_PATH: '/catalog',
    OMNIHILBRAS_COMPATIBLE_CHAT_PATH: '/generate',
  });
  const secretStore = new EnvironmentSecretStore({ ACME_API_KEY: 'acme-secret' });

  assert.equal(config.compatible.id, 'acme');
  assert.equal(config.compatible.authRequired, true);
  assert.equal(config.compatible.modelsPath, '/catalog');
  assert.equal(config.compatible.chatPath, '/generate');
  assert.deepEqual(await secretStore.get('acme'), { type: 'api-key', value: 'acme-secret' });
});

test('gateway config registers all provider adapters', () => {
  const config = loadGatewayConfig({});
  const transport = {
    async request() {
      throw new Error('network calls are not expected in configuration tests');
    },
    async *stream() {},
  };
  const registry = createProviderRegistry(config, transport);

  assert.deepEqual(registry.list().map((adapter) => adapter.id), ['openai', 'anthropic', 'gemini', 'openrouter', 'openai-compatible']);
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

test('saved connection credentials take precedence over environment fallback', async () => {
  const adapter = {
    id: 'openrouter',
    name: 'OpenRouter',
    capabilities: {},
    async validateCredential() {},
  };
  const fallback = new EnvironmentSecretStore({ OPENROUTER_API_KEY: 'environment-key' });
  const store = new InMemoryConnectionStore(fallback);
  const service = new GatewayService(new ProviderRegistry().register(adapter), store, store);

  assert.deepEqual(await store.get('openrouter'), { type: 'api-key', value: 'environment-key' });
  await service.saveConnection({ providerId: 'openrouter', name: 'Saved', endpoint: 'https://openrouter.ai/api/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'saved-key' });
  assert.deepEqual(await store.get('openrouter'), { type: 'api-key', value: 'saved-key' });
});

test('GatewayService applies free-only and all-model import policies before saving', async () => {
  const discovered = [];
  const adapter = {
    id: 'openrouter',
    name: 'OpenRouter',
    capabilities: {},
    async validateCredential() {},
    async discoverModels(_context, options) {
      discovered.push(options.policy);
      return options.policy === 'free' ? [{ id: 'vendor/free', providerId: 'openrouter' }] : [{ id: 'vendor/all', providerId: 'openrouter' }];
    },
  };
  const store = new InMemoryConnectionStore();
  const service = new GatewayService(new ProviderRegistry().register(adapter), store, store);
  const base = { providerId: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', priority: 1, proxyPool: 'none' };

  const free = await service.saveConnection({ ...base, modelPolicy: 'free' }, { type: 'api-key', value: 'free-key' });
  await service.addConnectionModels('openrouter', ['vendor/custom']);
  const all = await service.saveConnection({ ...base, name: 'Renamed', modelPolicy: 'all' }, { type: 'api-key', value: 'all-key' });

  assert.deepEqual(free.modelIds, ['vendor/free']);
  assert.deepEqual(all.modelIds, ['vendor/all', 'vendor/custom']);
  assert.deepEqual(all.customModelIds, ['vendor/custom']);
  assert.deepEqual(discovered, ['free', 'all']);
});

test('model capacity conflicts are reported as invalid requests', async () => {
  const store = new InMemoryConnectionStore();
  const service = new GatewayService(new ProviderRegistry(), store, store);
  await store.save({ id: 'openrouter', providerId: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', priority: 1, proxyPool: 'none', modelIds: Array.from({ length: 2_000 }, (_, index) => `vendor/model-${index}`), customModelIds: Array.from({ length: 2_000 }, (_, index) => `custom/model-${index}`) }, { type: 'api-key', value: 'capacity-key' });

  await assert.rejects(
    () => service.addConnectionModels('openrouter', ['vendor/new-model']),
    (error) => error instanceof ProviderError && error.code === 'INVALID_REQUEST',
  );
});

test('model discovery failure leaves the existing connection unchanged', async () => {
  let failDiscovery = false;
  const adapter = {
    id: 'openrouter',
    name: 'OpenRouter',
    capabilities: {},
    async validateCredential() {},
    async discoverModels() {
      if (failDiscovery) throw new ProviderError('PROVIDER_UNAVAILABLE', 'Model discovery failed.', { providerId: 'openrouter' });
      return [{ id: 'vendor/original', providerId: 'openrouter' }];
    },
  };
  const store = new InMemoryConnectionStore();
  const service = new GatewayService(new ProviderRegistry().register(adapter), store, store);
  const input = { providerId: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', priority: 1, proxyPool: 'none', modelPolicy: 'all' };
  await service.saveConnection(input, { type: 'api-key', value: 'original-key' });

  failDiscovery = true;
  await assert.rejects(() => service.saveConnection({ ...input, name: 'Replacement' }, { type: 'api-key', value: 'replacement-key' }));

  assert.deepEqual(await store.get('openrouter'), { type: 'api-key', value: 'original-key' });
  assert.deepEqual((await store.list())[0].modelIds, ['vendor/original']);
});
