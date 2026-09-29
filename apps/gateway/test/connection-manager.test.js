import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ConnectionManager, modelMetaFor } from '../dist/connection-manager.js';
import { ConnectionMetadataLimitError, ConnectionModelLimitError } from '../dist/connections.js';
import { ProviderError } from '@hilbras/omnihilbras';

/**
 * `ConnectionManager`, and the rules it exists to state once.
 *
 * Four near-identical error mappers became one, and the lock scope stopped being a detail spread
 * across six methods. Both are the kind of thing that is invisible until a copy drifts, so both are
 * pinned here rather than left to review.
 */

/**
 * A store whose calls are recorded on the store itself.
 *
 * `calls` and `failWith` live on the object the manager is handed, not on a nested wrapper. An
 * earlier version nested them and three tests then passed the wrapper where the store was wanted,
 * which is a test that fails for a reason that has nothing to do with what it is testing.
 */
function store(records = []) {
  return {
    records: [...records],
    calls: [],
    failWith: undefined,
    async save(input, credential) { this.calls.push(['save', input, credential]); if (this.failWith) throw this.failWith; return input; },
    async list() { this.calls.push(['list']); if (this.failWith) throw this.failWith; return this.records; },
    async remove(id) { this.calls.push(['remove', id]); if (this.failWith) throw this.failWith; return true; },
    async updateModels(id, ids, meta, options) { this.calls.push(['updateModels', id, ids, meta, options]); if (this.failWith) throw this.failWith; return { ...(this.records[0] ?? {}), id, modelIds: ids }; },
    async updateResilience(id, resilience) { this.calls.push(['updateResilience', id, resilience]); if (this.failWith) throw this.failWith; return { ...(this.records[0] ?? {}), id }; },
  };
}

/** A manager with no lock contention and a provider that answers with two models. */
function manager(overrides = {}, records = []) {
  const backing = overrides.store ?? store(records);
  const seen = { validated: [], discovered: [], notes: [], lockTakes: 0 };
  const instance = new ConnectionManager(backing, {
    lock: async (operation) => { seen.lockTakes += 1; return operation(); },
    canValidate: () => true,
    validate: async (providerId, credential) => {
      seen.validated.push([providerId, credential]);
      if (overrides.validateThrows) throw overrides.validateThrows;
    },
    discover: async ({ providerId, policy }) => { seen.discovered.push([providerId, policy]); return overrides.models ?? [{ id: 'm1' }, { id: 'm2' }]; },
    readCredential: async () => overrides.credential ?? { type: 'api-key', value: 'k' },
    noteDiscoveryFailure: (error) => { seen.notes.push(error); },
  });
  return { instance, seen, backing };
}

const input = (over = {}) => ({ providerId: 'p', name: 'P', endpoint: 'https://p.invalid/v1', priority: 1, proxyPool: 'none', ...over });

// ── the one error mapper ───────────────────────────────────────────────────

test('a limit is the operator’s input being too large, not a fault', async () => {
  for (const LimitError of [ConnectionModelLimitError, ConnectionMetadataLimitError]) {
    const { instance, backing } = manager({ store: store() });
    backing.failWith = new LimitError('Too many models for one connection.');
    await assert.rejects(() => instance.setModels('c', ['a']), (error) => {
      assert.equal(error.code, 'INVALID_REQUEST');
      // The store's own wording is kept: it knows the limit, and anything written here would not.
      assert.equal(error.message, 'Too many models for one connection.');
      return true;
    });
  }
});

test('any other store failure names what could not be saved, and blames no provider', async () => {
  const { instance, backing } = manager({ store: store() });
  backing.failWith = new Error('EACCES: permission denied');
  await assert.rejects(() => instance.setResilience('c', { maxRetries: 2 }), (error) => {
    assert.equal(error.code, 'CONFIGURATION_ERROR');
    assert.equal(error.message, 'The connection settings could not be saved.');
    // A disk error is ours. Naming a provider here would send an operator to re-key something
    // that was never the problem.
    assert.equal(error.providerId, undefined);
    return true;
  });
});

test('an error that is already a ProviderError passes through untouched', async () => {
  const { instance, backing } = manager({ store: store() });
  backing.failWith = new ProviderError('AUTHENTICATION_FAILED', 'Provider authentication failed.', { providerId: 'p' });
  await assert.rejects(() => instance.setModels('c', ['a']), (error) => {
    // Not re-wrapped: a classification the store already made must not be overwritten by ours.
    assert.equal(error.code, 'AUTHENTICATION_FAILED');
    assert.equal(error.providerId, 'p');
    return true;
  });
});

test('one mapper, not four: the same failure reads the same way from every operation', async () => {
  const { instance, backing } = manager({ store: store() });
  backing.failWith = new Error('disk gone');
  const messages = [];
  for (const call of [
    () => instance.setModels('c', ['a']),
    () => instance.setResilience('c', {}),
    () => instance.remove('c'),
  ]) {
    try { await call(); assert.fail('expected a rejection'); } catch (error) { messages.push(error.code); }
  }
  assert.deepEqual(messages, ['CONFIGURATION_ERROR', 'CONFIGURATION_ERROR', 'CONFIGURATION_ERROR']);
});

// ── prove before store ─────────────────────────────────────────────────────

test('a credential is proven before it reaches the store', async () => {
  const { instance, seen, backing } = manager();
  await instance.save(input(), { type: 'api-key', value: 'k' });
  assert.deepEqual(seen.validated.map(([id]) => id), ['p']);
  // The order is the whole point: a connection that exists but cannot be used reads in the
  // dashboard as working and fails on its first request.
  assert.deepEqual(backing.calls.map(([name]) => name), ['save']);
});

test('a credential the provider refuses is never stored', async () => {
  // The refusal comes from the *validator*, not the store: that is the whole claim. A connection
  // that exists but cannot be used reads in the dashboard as working and fails on its first
  // request, so nothing may be written once the provider has said no.
  const { instance, backing } = manager({ validateThrows: new ProviderError('AUTHENTICATION_FAILED', 'The provider refused this key.') });
  await assert.rejects(() => instance.save(input(), { type: 'api-key', value: 'k' }), (error) => {
    assert.equal(error.code, 'AUTHENTICATION_FAILED');
    assert.equal(error.message, 'The provider refused this key.', 'and the provider’s own wording survives');
    return true;
  });
  assert.equal(backing.calls.filter(([name]) => name === 'save').length, 0, 'nothing may be written after a refused credential');
});

test('a provider that cannot be probed is stored without a pre-flight check', async () => {
  const { instance, seen, backing } = manager();
  // Not every provider can be checked without spending a real request.
  const instanceNoProbe = new ConnectionManager(backing, {
    lock: async (op) => op(),
    canValidate: () => false,
    validate: async () => { throw new Error('must not be called'); },
    discover: async () => [],
    readCredential: async () => undefined,
    noteDiscoveryFailure: () => {},
  });
  await instanceNoProbe.save(input(), { type: 'api-key', value: 'k' });
  assert.equal(seen.validated.length, 0);
  void instance;
});

// ── the catalog merge ──────────────────────────────────────────────────────

test('discovered ids are stored alongside the operator’s own, and the discovered half is described', async () => {
  const { instance, backing } = manager({ models: [{ id: 'd1', contextWindow: 1000 }, { id: 'd2' }] });
  await instance.save(input({ modelPolicy: 'all', customModelIds: ['mine'] }), { type: 'api-key', value: 'k' });
  const saved = backing.calls.find(([name]) => name === 'save')[1];
  assert.deepEqual([...saved.modelIds].sort(), ['d1', 'd2', 'mine']);
  assert.deepEqual(saved.customModelIds, ['mine']);
  // Custom ids carry no catalog metadata, so only the discovered half is described.
  assert.deepEqual(Object.keys(saved.modelMeta), ['d1']);
});

test('a refresh replaces the provider’s models and keeps the operator’s own', async () => {
  const records = [{ id: 'c', providerId: 'p', name: 'P', endpoint: 'https://p.invalid/v1', modelIds: ['old', 'withdrawn'], customModelIds: ['mine'], hasCredential: true, modelPolicy: 'all' }];
  const { instance, backing } = manager({ models: [{ id: 'new' }] }, records);
  await instance.refreshModels('c');
  const [, , ids, , options] = backing.calls.find(([name]) => name === 'updateModels');
  assert.deepEqual(ids, ['new', 'mine'], 'a withdrawn model must not survive a rescan');
  // `replace`, not add: a union here would keep a withdrawn model forever and file it as a custom
  // addition besides, leaving the operator no way to tell which models the provider withdrew.
  assert.equal(options.replace, true);
});

test('a refresh of a connection that no longer exists is named', async () => {
  const { instance } = manager({}, []);
  await assert.rejects(() => instance.refreshModels('gone'), (error) => {
    assert.equal(error.code, 'NOT_FOUND');
    assert.equal(error.message, 'That connection no longer exists.');
    return true;
  });
});

// ── lock scope, which is deliberately not uniform ──────────────────────────

test('a save holds the lock across proving, reading and storing', async () => {
  // Two concurrent saves would otherwise interleave a catalog read between one write and the next,
  // and the second would store a catalog assembled from the first's credential.
  const { instance, seen } = manager();
  await instance.save(input({ modelPolicy: 'all' }), { type: 'api-key', value: 'k' });
  assert.equal(seen.lockTakes, 1, 'the whole save is one critical section');
});

test('a refresh takes no lock, because it is a slow read of a third party', async () => {
  // If a rescan held the mutation lock, every save in the gateway would queue behind one provider's
  // catalog read, and the dashboard's save button would appear to hang.
  const { instance, seen } = manager({ models: [{ id: 'm' }] }, [{ id: 'c', providerId: 'p', name: 'P', endpoint: 'https://p.invalid/v1', modelIds: [], customModelIds: [], hasCredential: true }]);
  await instance.refreshModels('c');
  assert.equal(seen.lockTakes, 0);
});

test('the narrow operations lock only their own store call', async () => {
  const { instance, seen } = manager();
  await instance.setModels('c', ['a']);
  await instance.setResilience('c', { maxRetries: 1 });
  await instance.remove('c');
  assert.equal(seen.lockTakes, 3, 'one lock each, so two different connections can be changed at once');
});

// ── the absence of a store ─────────────────────────────────────────────────

test('an absent store is a configuration problem, named as one', async () => {
  const { instance } = manager();
  const none = new ConnectionManager(undefined, { lock: async (op) => op(), canValidate: () => false, validate: async () => {}, discover: async () => [], readCredential: async () => undefined, noteDiscoveryFailure: () => {} });
  assert.equal(await none.list ? (await none.list()).length : -1, 0, 'listing nothing is not an error');
  await assert.rejects(() => none.save(input(), { type: 'api-key', value: 'k' }), (error) => {
    assert.equal(error.code, 'CONFIGURATION_ERROR');
    assert.equal(error.message, 'Local connection storage is not configured.');
    return true;
  });
  void instance;
});

test('a tolerant save keeps the session and records why the catalog could not be read', async () => {
  // A sign-in that came from the provider's own flow has already proven the credential, so a
  // catalog that will not read must not throw the session away.
  const backing = store();
  const notes = [];
  const instance = new ConnectionManager(backing, {
    lock: async (op) => op(),
    canValidate: () => false,
    validate: async () => {},
    discover: async () => { throw new ProviderError('PROVIDER_UNAVAILABLE', 'no catalog today', { details: { providerMessage: 'The provider said: catalog disabled.' } }); },
    readCredential: async () => undefined,
    noteDiscoveryFailure: (error) => notes.push(error),
  });
  const saved = await instance.save(input({ modelPolicy: 'all' }), { type: 'api-key', value: 'k' }, undefined, { tolerateDiscoveryFailure: true });
  assert.equal(backing.calls.filter(([name]) => name === 'save').length, 1, 'the connection is still stored');
  assert.deepEqual(saved.modelIds, [], 'with an empty catalog, not a stale one');
  assert.equal(notes.length, 1, 'and the reason is recorded, so the dashboard can say so');
  // The whole error is handed over, not a string: the service knows how to ask a provider what it
  // actually said, and reducing it here would throw that away.
  assert.ok(notes[0] instanceof ProviderError);
});

test('an intolerant save lets a failed catalog read fail the save', async () => {
  const backing = store();
  const instance = new ConnectionManager(backing, {
    lock: async (op) => op(),
    canValidate: () => false,
    validate: async () => {},
    discover: async () => { throw new ProviderError('PROVIDER_UNAVAILABLE', 'no catalog today'); },
    readCredential: async () => undefined,
    noteDiscoveryFailure: () => {},
  });
  await assert.rejects(() => instance.save(input({ modelPolicy: 'all' }), { type: 'api-key', value: 'k' }), (error) => error.code === 'PROVIDER_UNAVAILABLE');
  assert.equal(backing.calls.filter(([name]) => name === 'save').length, 0);
});

// ── the two lookups ────────────────────────────────────────────────────────

test('listing is not an error when there is no store, but changing something is', async () => {
  const none = new ConnectionManager(undefined, { lock: async (op) => op(), canValidate: () => false, validate: async () => {}, discover: async () => [], readCredential: async () => undefined, noteDiscoveryFailure: () => {} });
  assert.deepEqual(await none.list(), []);
  await assert.rejects(() => none.setModels('c', []), (error) => error.code === 'CONFIGURATION_ERROR');
});

test('the first connection with a credential is found, and one without is skipped', async () => {
  const records = [
    { id: 'a', providerId: 'p', name: 'A', endpoint: 'https://a.invalid', modelIds: [], hasCredential: false },
    { id: 'b', providerId: 'p', name: 'B', endpoint: 'https://b.invalid', modelIds: [], hasCredential: true },
  ];
  const { instance } = manager({}, records);
  assert.equal((await instance.firstWithCredentialFor('p'))?.id, 'b');
  assert.equal(await instance.firstWithCredentialFor('absent'), undefined);
});

// ── modelMetaFor, moved verbatim ───────────────────────────────────────────

test('model metadata is indexed under the store’s short keys, and omitted when empty', () => {
  assert.deepEqual(modelMetaFor([{ id: 'm', displayName: 'M', contextWindow: 10 }]), { m: { n: 'M', c: 10 } });
  // A model with nothing worth storing must not create an empty entry: the store would carry the
  // key forever for no reason.
  assert.equal(modelMetaFor([{ id: 'm' }]), undefined);
  assert.equal(modelMetaFor([]), undefined);
});

test('THE INVARIANT: the manager names no provider', () => {
  const source = readFileSync(new URL('../src/connection-manager.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const offenders = [...code.matchAll(/['"]([a-z0-9]+(?:-[a-z0-9]+)+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(offenders, [], `the manager must contain no provider id, found: ${offenders.join(', ')}`);
});
