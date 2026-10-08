import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialManager } from '../dist/credential-manager.js';
import { ConnectionManager } from '../dist/connection-manager.js';

/**
 * `CredentialManager`, and the one thing that must not vary.
 *
 * "Which connection serves this provider, and what context does a request need?" was answered in
 * five places before this, with the local variable named differently at each. These tests are about
 * the answer being the *same* answer everywhere, because the failure it is prone to — a credential
 * looked up under the provider id instead of the connection id — is invisible when the two strings
 * happen to be equal, which they usually are.
 */

const credential = { type: 'api-key', value: 'secret' };

/** A secret store that records what it was asked for, keyed by connection id. */
function secrets(initial = {}) {
  const store = { ...initial };
  const reads = [];
  return {
    reads,
    store,
    get: async (connectionId, providerId) => {
      reads.push([connectionId, providerId]);
      return store[connectionId];
    },
  };
}

/** A ConnectionManager over a fixed connection list, with no provider-facing behaviour. */
function connections(records) {
  return new ConnectionManager(
    {
      async list() { return records; },
      async save(input) { return input; },
      async remove() { return true; },
      async updateModels(id, ids) { return { id, modelIds: ids }; },
      async updateResilience(id) { return { id }; },
    },
    { lock: async (op) => op(), canValidate: () => false, validate: async () => {}, discover: async () => [], readCredential: async () => undefined, noteDiscoveryFailure: () => {} },
  );
}

const record = (over = {}) => ({ id: 'connection-1', providerId: 'p', name: 'P', endpoint: 'https://p.invalid', modelIds: [], hasCredential: true, ...over });

test('a credential is read under the connection id, not the provider id', async () => {
  const vault = secrets({ 'connection-1': credential });
  const manager = new CredentialManager(vault, connections([record()]));
  const context = await manager.contextForProvider('p');
  assert.deepEqual(context.credential, credential);
  assert.deepEqual(vault.reads, [['connection-1', 'p']], 'the connection id is the key, the provider id is only the label');
});

test('a credential is never read under the provider id when the two differ', async () => {
  // The failure this whole file exists to prevent, and it is invisible when the two strings are
  // equal — which they are for every connection the sign-in flows create. A connection made through
  // the generic route can have any id, and then a lookup under the provider id is either missing
  // (a confusing authentication error) or another connection's.
  const vault = secrets({ 'connection-1': credential, p: { type: 'api-key', value: 'THE WRONG ONE' } });
  const manager = new CredentialManager(vault, connections([record({ id: 'connection-1' })]));
  const context = await manager.contextForProvider('p');
  assert.equal(context.credential.value, 'secret');
  assert.equal(vault.reads.some(([id]) => id === 'p'), false, 'the provider id is never used as a storage key');
});

test('the first credentialed connection wins, and one without a credential is skipped', async () => {
  const vault = secrets({ 'bare': { type: 'none' }, 'real': credential });
  const manager = new CredentialManager(vault, connections([record({ id: 'bare', hasCredential: false }), record({ id: 'real' })]));
  const context = await manager.contextForProvider('p');
  assert.equal(context.credential.value, 'secret');
  assert.deepEqual(vault.reads, [['real', 'p']]);
});

test('an unconnected provider is still asked, with the provider id standing in', async () => {
  // A registered but unconnected provider is still polled for health, and there is no credential
  // to look up. Failing here instead would make "not connected" look like "broken", which is the
  // distinction the dashboard exists to draw.
  const vault = secrets();
  const manager = new CredentialManager(vault, connections([]));
  const context = await manager.contextForProvider('p');
  assert.equal(context.credential, undefined);
  assert.deepEqual(vault.reads, [['p', 'p']], 'and the read happens once, under the id that is available');
});

test('a provider that shares another’s credential reads the owner’s connection', async () => {
  // `clinepass` reads `cline`'s one connection — Cline's own auth registry registers `cline-pass` as an
  // alias of the `cline` handler. The lookup follows the alias; the **provider id stays this one**, so the
  // adapter is ClinePass's and a failure names the right card.
  const vault = secrets({ 'cline-conn': credential });
  const manager = new CredentialManager(vault, connections([record({ id: 'cline-conn', providerId: 'cline' })]));
  const context = await manager.contextForProvider('clinepass');
  assert.deepEqual(context.credential, credential, 'the shared credential is used');
  assert.deepEqual(vault.reads, [['cline-conn', 'clinepass']], 'read under the owner’s connection, labelled with this provider');
});

test('the alias does not let an unrelated provider borrow a credential', async () => {
  // Only the providers listed in `provider-alias.ts` share. A provider that merely resembles another —
  // the `kimi` key versus the `kimi-code` token — resolves its own connection and nothing else.
  const vault = secrets({ 'cline-conn': credential });
  const manager = new CredentialManager(vault, connections([record({ id: 'cline-conn', providerId: 'cline' })]));
  const context = await manager.contextForProvider('some-other-provider');
  assert.equal(context.credential, undefined, 'no cross-provider read for a provider with no alias');
});

test("the connection's own model policy travels with the credential", async () => {
  // The difference between a `free` import and an `all` import has to be the same whether a catalog
  // is read during a connect, during a manual refresh, or by a health poll. A dashboard that shows
  // the narrow list while a refresh silently restores the full one is a switch that stops working
  // once you stop looking at it.
  const vault = secrets({ 'connection-1': credential });
  for (const policy of ['free', 'all', 'paid']) {
    const manager = new CredentialManager(vault, connections([record({ modelPolicy: policy })]));
    assert.equal((await manager.contextForProvider('p')).importPolicy, policy);
  }
});

test('a connection with no policy is asked for with none, rather than a default', async () => {
  // Inventing a default here would silently widen or narrow somebody's catalog depending on which
  // code path asked. Absent means absent, and the adapter's own default applies.
  const vault = secrets({ 'connection-1': credential });
  const manager = new CredentialManager(vault, connections([record()]));
  const context = await manager.contextForProvider('p');
  assert.equal('importPolicy' in context, false);
});

test('the credential and the policy are read together', async () => {
  // They come from two places and belong to one decision. Reading the credential alone would let a
  // request go out under a policy nobody chose.
  const vault = secrets({ 'connection-1': credential });
  const manager = new CredentialManager(vault, connections([record({ modelPolicy: 'free' })]));
  const [context] = await Promise.all([manager.contextForProvider('p')]);
  assert.equal(context.credential.value, 'secret');
  assert.equal(context.importPolicy, 'free');
});

test('a signal is carried only when there is one', () => {
  const vault = secrets();
  const manager = new CredentialManager(vault, connections([]));
  return Promise.all([
    manager.contextForProvider('p').then((context) => assert.equal('signal' in context, false)),
    manager.contextForProvider('p', new AbortController().signal).then((context) => assert.ok(context.signal instanceof AbortSignal)),
  ]);
});
