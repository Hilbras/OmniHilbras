import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiKeyManager } from '../dist/api-key-manager.js';
import { ApiKeyLimitError } from '../dist/api-keys.js';
import { ProviderError } from '@hilbras/omnihilbras';

/**
 * `ApiKeyManager` on its own, with an in-memory store.
 *
 * The properties worth protecting here are the ones a store cannot decide for itself: whether
 * enforcement is even on, whether a mutation is atomic, and whether a storage failure reaches the
 * user as something they can act on.
 */

/** A store that records the order of operations, so a test can see what actually happened. */
function fakeStore(overrides = {}) {
  const calls = [];
  const store = {
    calls,
    records: new Map([['key-1', { id: 'key-1', name: 'first', enabled: true }]]),
    async list() { calls.push('list'); return [...store.records.values()]; },
    async create(name) {
      calls.push(`create:${name}`);
      if (store.records.size >= store.limit) throw new ApiKeyLimitError('Too many keys.');
      const record = { id: `key-${store.records.size + 1}`, name, enabled: true };
      store.records.set(record.id, record);
      return { ...record, key: `ohk_secret_${store.records.size}` };
    },
    async setEnabled(id, enabled) { calls.push(`setEnabled:${id}:${enabled}`); const r = store.records.get(id); if (r) r.enabled = enabled; return r; },
    async remove(id) { calls.push(`remove:${id}`); return store.records.delete(id); },
    async authenticate(key) { calls.push(`authenticate:${key}`); return key === 'ohk_secret_1' ? { id: 'key-1' } : undefined; },
    async isEnforced() { calls.push('isEnforced'); return store.enforced !== false; },
    async setEnforced(value) { store.enforced = value; calls.push(`setEnforced:${value}`); return value; },
    limit: 10,
    ...overrides,
  };
  return store;
}

test('a gateway with no key store is not enforcing, and says so', async () => {
  // The absence of a store means "not configured" — an embedder or a test — rather than
  // "accept every key", and the list is where that distinction has to be visible.
  const manager = new ApiKeyManager(undefined);
  assert.deepEqual(await manager.list(), { keys: [], requireApiKey: false });
  await manager.authorize('anything');
});

test('a mutation without a store is a configuration error, not a silent success', async () => {
  const manager = new ApiKeyManager(undefined);
  await assert.rejects(() => manager.create('x'), (error) => error.code === 'CONFIGURATION_ERROR');
});

test('enforcement refuses an absent key, and an unknown one, distinctly', async () => {
  const manager = new ApiKeyManager(fakeStore());
  await assert.rejects(() => manager.authorize(undefined), (error) => /requires an API key/.test(error.publicMessage));
  await assert.rejects(() => manager.authorize('ohk_nope'), (error) => error.code === 'AUTHENTICATION_FAILED' && /invalid or paused/.test(error.publicMessage));
  await manager.authorize('ohk_secret_1');
});

test('turning enforcement off opens the surface, and back on closes it', async () => {
  const manager = new ApiKeyManager(fakeStore());
  await manager.setEnforced(false);
  await manager.authorize(undefined);
  await manager.setEnforced(true);
  await assert.rejects(() => manager.authorize(undefined), (error) => error.code === 'AUTHENTICATION_FAILED');
});

test('a key is created, listed, paused and deleted, and its secret is never re-readable', async () => {
  const manager = new ApiKeyManager(fakeStore());
  const created = await manager.create('second');
  assert.ok(created.key, 'the secret is returned once, at creation');
  const listed = await manager.list();
  assert.ok(listed.keys.some((k) => k.id === created.id));
  assert.equal(listed.keys.find((k) => k.id === created.id).key, undefined, 'a listed key must not carry its secret');

  const paused = await manager.setEnabled(created.id, false);
  assert.equal(paused.enabled, false);
  await manager.remove(created.id);
  assert.equal((await manager.list()).keys.some((k) => k.id === created.id), false);
});

test('acting on a key that is not there is named, not a silent no-op', async () => {
  const manager = new ApiKeyManager(fakeStore());
  await assert.rejects(() => manager.setEnabled('missing', false), (error) => error.code === 'NOT_FOUND');
  await assert.rejects(() => manager.remove('missing'), (error) => error.code === 'NOT_FOUND');
});

test('a limit is the caller’s fault, and anything else is a configuration problem', async () => {
  // Both surface as an opaque 500 otherwise, and they need opposite responses: a limit is fixed
  // by changing the request, an unwritable directory is not.
  const store = fakeStore();
  // The fake pre-seeds one key, so the limit has to allow the create that is meant to succeed
  // and refuse the one after it. Setting it to 1 made the *first* create throw, outside the
  // assertion — a failure in the test's own setup wearing a failure in the manager's clothes.
  store.limit = 2;
  const manager = new ApiKeyManager(store);
  await manager.create('first');
  await assert.rejects(() => manager.create('second'), (error) => error.code === 'INVALID_REQUEST' && /Too many keys/.test(error.message));

  const broken = new ApiKeyManager(fakeStore({ create: async () => { throw new Error('EACCES: permission denied'); } }));
  await assert.rejects(() => broken.create('x'), (error) => error.code === 'CONFIGURATION_ERROR' && /could not be updated/.test(error.message));
});

test('a ProviderError from the store is passed through unchanged', async () => {
  // A store that already speaks the vocabulary must not have it flattened into a 500.
  const manager = new ApiKeyManager(fakeStore({ create: async () => { throw new ProviderError('CONFIGURATION_ERROR', 'the master key is missing'); } }));
  await assert.rejects(() => manager.create('x'), (error) => /master key is missing/.test(error.message));
});

test('concurrent mutations are serialised', async () => {
  // A file-backed store has no transactions, so a create racing a remove is a lost update. The
  // store cannot know two operations were meant to be sequential; this is the only place that can.
  const order = [];
  let inFlight = 0;
  const store = fakeStore({
    async create(name) { inFlight += 1; assert.equal(inFlight, 1, 'two mutations overlapped'); await new Promise((r) => setTimeout(r, 5)); order.push(name); inFlight -= 1; return { id: name, name, key: 'k' }; },
  });
  const manager = new ApiKeyManager(store);
  await Promise.all([manager.create('a'), manager.create('b'), manager.create('c')]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('one failed mutation does not wedge the ones after it', async () => {
  // A lock whose chain dies on rejection turns one error into a permanently broken gateway —
  // every later key operation hangs on a promise that will never settle.
  const store = fakeStore();
  const manager = new ApiKeyManager(store);
  await assert.rejects(() => manager.setEnabled('missing', true));
  const created = await manager.create('after the failure');
  assert.equal(created.name, 'after the failure');
});
