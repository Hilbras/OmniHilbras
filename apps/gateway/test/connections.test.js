import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { InMemoryConnectionStore, LocalConnectionStore } from '../dist/index.js';
import { mkdtempSync } from 'node:fs';

const connectionInput = {
  id: 'openrouter',
  providerId: 'openrouter',
  name: 'OpenRouter local',
  endpoint: 'https://openrouter.ai/api/v1',
  priority: 1,
  proxyPool: 'none',
};

test('local connection store encrypts credentials separately from metadata', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-connections-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = 'sk-or-do-not-write-me';
  const store = new LocalConnectionStore({ directory });

  const record = await store.save(connectionInput, { type: 'api-key', value: secret });
  assert.equal(record.hasCredential, true);
  assert.deepEqual(await store.get('openrouter'), { type: 'api-key', value: secret });

  const metadata = await readFile(join(directory, 'connections.json'), 'utf8');
  const encrypted = await readFile(join(directory, 'secrets.enc.json'), 'utf8');
  assert.equal(metadata.includes(secret), false);
  assert.equal(encrypted.includes(secret), false);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'connections.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'secrets.enc.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'secrets.key'))).mode & 0o777, 0o600);

  const reopened = new LocalConnectionStore({ directory });
  assert.deepEqual(await reopened.get('openrouter'), { type: 'api-key', value: secret });
  assert.deepEqual(await reopened.list(), [record]);
});

test('local connection store persists added model IDs without credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 6) });
  await store.save({ ...connectionInput, modelPolicy: 'free', modelIds: ['vendor/free'] }, { type: 'api-key', value: 'model-secret' });
  const updated = await store.updateModels('openrouter', ['vendor/custom']);

  assert.deepEqual(updated.modelIds, ['vendor/free', 'vendor/custom']);
  assert.deepEqual(updated.customModelIds, ['vendor/custom']);
  const reopened = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 6) });
  assert.deepEqual((await reopened.list())[0].modelIds, ['vendor/free', 'vendor/custom']);
  assert.equal((await readFile(join(directory, 'connections.json'), 'utf8')).includes('model-secret'), false);
});

test('local connection store handles duplicate and overflow model additions atomically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-model-limits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 11) });
  const modelIds = Array.from({ length: 2_000 }, (_, index) => `vendor/model-${index}`);
  const customModelIds = Array.from({ length: 2_000 }, (_, index) => `custom/model-${index}`);
  const record = await store.save({ ...connectionInput, modelIds, customModelIds }, { type: 'api-key', value: 'limit-secret' });

  const duplicate = await store.updateModels('openrouter', ['vendor/model-0']);
  assert.equal(duplicate.updatedAt, record.updatedAt);
  assert.deepEqual(duplicate.customModelIds, customModelIds);
  await assert.rejects(() => store.updateModels('openrouter', ['vendor/new-model']), /model catalog exceeds/);
  assert.deepEqual((await store.list())[0].modelIds, [...modelIds, ...customModelIds]);
});

test('local connection store serializes concurrent model additions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-concurrent-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 12) });
  await store.save({ ...connectionInput, modelIds: ['vendor/original'] }, { type: 'api-key', value: 'concurrent-secret' });

  await Promise.all([
    store.updateModels('openrouter', ['vendor/first']),
    store.updateModels('openrouter', ['vendor/second']),
  ]);

  const reopened = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 12) });
  assert.deepEqual((await reopened.list())[0].modelIds, ['vendor/original', 'vendor/first', 'vendor/second']);
  assert.deepEqual((await reopened.list())[0].customModelIds, ['vendor/first', 'vendor/second']);
});

test('local connection store rejects metadata that cannot be reloaded safely', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-large-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 10) });
  const modelIds = Array.from({ length: 1_000 }, (_, index) => `vendor/${'x'.repeat(240)}-${index}`);

  await assert.rejects(() => store.save({ ...connectionInput, modelIds }, { type: 'api-key', value: 'large-secret' }), /size limit/);
  assert.deepEqual(await store.list(), []);
});

test('local connection store fails closed when the master key is wrong', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-wrong-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 7) });
  await store.save(connectionInput, { type: 'api-key', value: 'test-secret' });

  const wrongKeyStore = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 8) });
  await assert.rejects(() => wrongKeyStore.get('openrouter'));
  assert.equal((await readFile(join(directory, 'connections.json'), 'utf8')).includes('test-secret'), false);
});

test('local connection store discards credentials without a metadata record', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-orphan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 9) });
  await store.save(connectionInput, { type: 'api-key', value: 'orphan-secret' });
  await writeFile(join(directory, 'connections.json'), JSON.stringify({ version: 1, connections: [] }) + '\n');

  const reopened = new LocalConnectionStore({ directory, masterKey: Buffer.alloc(32, 9) });
  assert.deepEqual(await reopened.list(), []);
  assert.equal(await reopened.get('openrouter'), undefined);
  assert.equal((await readFile(join(directory, 'secrets.enc.json'), 'utf8')).includes('orphan-secret'), false);
});

test('in-memory connection store keeps metadata and credentials available to the gateway', async () => {
  const store = new InMemoryConnectionStore();
  const record = await store.save(connectionInput, { type: 'api-key', value: 'test-secret' });
  assert.equal(record.id, 'openrouter');
  assert.deepEqual(await store.list(), [record]);
  assert.equal(await store.remove('openrouter'), true);
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get('openrouter'), undefined);
});

test('one provider can hold several connections, each with its own credential', async () => {
  const store = new InMemoryConnectionStore();
  const first = await store.save({ id: 'opencode', providerId: 'opencode', name: 'account A', endpoint: 'https://opencode.ai/zen/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-A' });
  const second = await store.save({ id: 'opencode-backup', providerId: 'opencode', name: 'account B', endpoint: 'https://opencode.ai/zen/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-B' });

  assert.equal(first.id, 'opencode');
  assert.equal(second.id, 'opencode-backup');
  assert.equal((await store.list()).length, 2, 'both connections exist');

  // The whole point of keying by connection: neither credential is overwritten.
  assert.deepEqual(await store.get('opencode'), { type: 'api-key', value: 'key-A' });
  assert.deepEqual(await store.get('opencode-backup'), { type: 'api-key', value: 'key-B' });

  const listed = await store.list();
  assert.deepEqual(listed.map((connection) => connection.hasCredential), [true, true], 'both report a credential');
});

test('saving without an id reuses the provider existing connection', async () => {
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'opencode', providerId: 'opencode', name: 'first', endpoint: 'https://opencode.ai/zen/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-A' });
  const again = await store.save({ providerId: 'opencode', name: 'renamed', endpoint: 'https://opencode.ai/zen/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-A2' });
  assert.equal(again.id, 'opencode');
  assert.equal((await store.list()).length, 1, 'no second connection is created');
  assert.deepEqual(await store.get('opencode'), { type: 'api-key', value: 'key-A2' }, 'the credential is replaced');
});

test('a credential is never shared between two connections of one provider', async () => {
  // The dangerous regression: reading by provider id would hand key-A to the
  // connection that holds key-B.
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'opencode', providerId: 'opencode', name: 'A', endpoint: 'https://opencode.ai/zen/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-A' });
  await store.save({ id: 'opencode-backup', providerId: 'opencode', name: 'B', endpoint: 'https://opencode.ai/zen/v1', priority: 1, proxyPool: 'none' }, { type: 'api-key', value: 'key-B' });
  await store.remove('opencode');
  assert.deepEqual(await store.get('opencode-backup'), { type: 'api-key', value: 'key-B' }, 'deleting one leaves the other intact');
  assert.equal(await store.get('opencode'), undefined, 'the removed one has no credential');
});

test('saving a connection KEEPS its model metadata — prices included', async (t) => {
  // **A real bug found in 1.62.0, and it was never a deliberate omission.**
  //
  // `normalizeInput` accepted `modelMeta` and normalized it. `parseRecord` read it back off disk.
  // `cloneRecord` copied it. `updateModels` set it. And `buildRecord` — the function every save goes
  // through — never copied it onto the record it returned.
  //
  // Measured, before the fix, against **both** stores:
  //
  // ```
  // InMemoryConnectionStore   -> saved modelMeta: undefined
  // LocalConnectionStore      -> saved modelMeta: undefined
  // ```
  //
  // So `modelMetaFor()` in `connection-manager.ts` has been writing discovered prices, display names,
  // context windows and modalities into a field nothing read. A missing display name is cosmetic. A missing
  // **price** is the difference between "this costs nothing" and "this cost is unknown", and no page could
  // tell those apart.
  //
  // It survived because four of the five places that handle `modelMeta` agreed with each other and only the
  // one that mattered disagreed — reading the store end to end finds nothing wrong.
  const directory = mkdtempSync(join(tmpdir(), 'omnih-meta-'));
  t.after(() => undefined);

  for (const [label, store] of [
    ['InMemoryConnectionStore', new InMemoryConnectionStore()],
    ['LocalConnectionStore', new LocalConnectionStore({ directory })],
  ]) {
    const saved = await store.save(
      {
        id: 'rich', providerId: 'p', name: 'Priced', endpoint: 'https://rich.example/v1', priority: 1,
        enabled: true, proxyPool: 'none', modelPolicy: 'all', modelIds: ['m'],
        modelMeta: {
          m: { n: 'Model M', c: 200_000, i: ['text'], o: ['text'], p: [3, 15] },
        },
        resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 },
      },
      { type: 'api-key', value: 'k' },
    );
    assert.deepEqual(saved.modelMeta?.m?.p, [3, 15], `${label} discarded the prices on save`);
    assert.equal(saved.modelMeta?.m?.n, 'Model M', `${label} discarded the display name`);
    assert.equal(saved.modelMeta?.m?.c, 200_000, `${label} discarded the context window`);

    // And it must survive a round trip through disk, not just the returned record.
    const reread = (await store.list()).find((connection) => connection.id === 'rich');
    assert.deepEqual(reread?.modelMeta?.m?.p, [3, 15], `${label} did not return the prices from list()`);
  }
});

test('a save without modelMeta does not invent one, and does not clear an existing one', async (t) => {
  const store = new InMemoryConnectionStore();
  const base = {
    id: 'c', providerId: 'p', name: 'C', endpoint: 'https://p.example/v1', priority: 1,
    enabled: true, proxyPool: 'none', modelPolicy: 'all', modelIds: ['m'],
    resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 },
  };
  await store.save({ ...base, modelMeta: { m: { p: [3, 15] } } }, { type: 'api-key', value: 'k' });

  // Re-saving without metadata is the shape `saveConnection` uses for an unrelated field change, and it
  // must not silently drop what a catalog scan discovered.
  const second = await store.save({ ...base, priority: 2 }, { type: 'api-key', value: 'k' });
  assert.deepEqual(second.modelMeta?.m?.p, [3, 15], 're-saving a connection dropped its discovered prices');

  // And a save that supplies new metadata replaces it, rather than merging two price lists.
  const third = await store.save({ ...base, modelMeta: { m: { p: [7] } } }, { type: 'api-key', value: 'k' });
  assert.deepEqual(third.modelMeta?.m?.p, [7]);
});

test('a provider strategy is saved, survives a reload, and an old file without one still loads with the default', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-strategy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory });
  await store.save(connectionInput, { type: 'api-key', value: 'k' });
  assert.equal(await store.strategyFor('openrouter'), 'priority', 'an unset provider keeps the default');
  await store.setStrategy('openrouter', 'round-robin');
  assert.equal(await store.strategyFor('openrouter'), 'round-robin');
  const reopened = new LocalConnectionStore({ directory });
  assert.equal(await reopened.strategyFor('openrouter'), 'round-robin', 'the choice survives a restart');
  const oldFile = JSON.parse(await readFile(join(directory, 'connections.json'), 'utf8'));
  delete oldFile.strategies;
  await writeFile(join(directory, 'connections.json'), JSON.stringify(oldFile));
  assert.equal(await new LocalConnectionStore({ directory }).strategyFor('openrouter'), 'priority', 'a file from before this change still loads');
});

test('an unknown provider strategy is refused, not stored', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-strategy-bad-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory });
  await store.save(connectionInput, { type: 'api-key', value: 'k' });
  await assert.rejects(() => store.setStrategy('openrouter', 'random-walk'), /strategy/);
  assert.equal(await store.strategyFor('openrouter'), 'priority', 'nothing was written');
});

test('the service reports and changes a provider\'s strategy, and routing reads the change at once', async (t) => {
  const { GatewayService, InMemoryConnectionStore } = await import('../dist/index.js');
  const { ProviderRegistry } = await import('@hilbras/omnihilbras');
  const { LocalConnectionStore: LocalStore } = await import('../dist/index.js');
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-service-strategy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalStore({ directory });
  const service = new GatewayService(new ProviderRegistry(), store, store, undefined, { failureThreshold: 3 });
  assert.equal(service.providerStrategy('p'), 'priority', 'the default is priority');
  await service.setProviderStrategy('p', 'round-robin');
  assert.equal(service.providerStrategy('p'), 'round-robin', 'the change is visible to routing without a restart');
  await assert.rejects(() => service.setProviderStrategy('p', 'shuffle'), /strategy/);
  assert.equal(service.providerStrategy('p'), 'round-robin', 'a refused change leaves the setting alone');
});

test('a saved provider strategy is in effect after a restart, without anyone setting it again', async (t) => {
  const { GatewayService, LocalConnectionStore: LocalStore } = await import('../dist/index.js');
  const { ProviderRegistry } = await import('@hilbras/omnihilbras');
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-restart-strategy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new LocalStore({ directory });
  await first.setStrategy('p', 'round-robin');
  const restarted = new LocalStore({ directory });
  const service = new GatewayService(new ProviderRegistry(), restarted, restarted, undefined, { failureThreshold: 3 });
  await service.loadProviderStrategies();
  assert.equal(service.providerStrategy('p'), 'round-robin', 'the strategy is loaded at startup, so routing honours it from the first request');
});

test('a model alias is saved, survives a restart, and an alias to a provider that is not connected is refused', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'omnihilbras-alias-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalConnectionStore({ directory });
  await store.save(connectionInput, { type: 'api-key', value: 'k' });
  assert.deepEqual(await store.aliases(), {}, 'no aliases until one is set');
  await store.setAlias('fast', { providerId: 'openrouter', model: 'qwen/qwen3.8-27b:free' });
  assert.deepEqual(await store.aliases(), { fast: { providerId: 'openrouter', model: 'qwen/qwen3.8-27b:free' } });
  const reopened = new LocalConnectionStore({ directory });
  assert.deepEqual(await reopened.aliases(), { fast: { providerId: 'openrouter', model: 'qwen/qwen3.8-27b:free' } }, 'the alias survives a restart');
  await assert.rejects(() => store.setAlias('ghost', { providerId: 'nobody', model: 'm' }), /not connected/, 'an alias to an unconnected provider is refused');
  assert.equal((await store.aliases()).ghost, undefined, 'nothing was stored for the refused alias');
});
