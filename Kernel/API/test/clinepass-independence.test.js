import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialManager } from '../dist/src/core/credential-manager.js';
import { InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * ClinePass is its own provider and its own connection.
 *
 * It used to borrow Cline's credential through a per-record link because Cline's client stores one
 * token for the account. The user's report was that the two are different providers with different
 * models, and the card proved it: it showed Cline's catalog and Cline's usage. A second sign-in is a
 * second WorkOS authorization grant, so each record holds its own refresh token and rotation cannot
 * invalidate the other. The link mechanism still exists for a deliberate alias, and these tests keep
 * both halves honest.
 */

const base = (id, providerId, extra = {}) => ({
  id, providerId, name: id, endpoint: 'https://api.cline.bot/api/v1',
  priority: 1, proxyPool: 'none', enabled: true, modelIds: [], ...extra,
});

test('a ClinePass OAuth connection uses its own credential, never Cline’s', async () => {
  const store = new InMemoryConnectionStore();
  await store.save(base('cline', 'cline'), { type: 'oauth', value: 'cline-token', refreshToken: 'cline-refresh' });
  await store.save(base('clinepass', 'clinepass'), { type: 'oauth', value: 'clinepass-token', refreshToken: 'clinepass-refresh' });
  const credentials = new CredentialManager(store, { list: () => store.list(), get: (id) => store.getRecord(id) });
  const context = await credentials.context('clinepass', 'clinepass');
  assert.equal(context.credential?.type, 'oauth');
  assert.equal(context.credential && 'value' in context.credential ? context.credential.value : undefined, 'clinepass-token');
});

test('an API-key ClinePass connection uses its own credential and no owner', async () => {
  const store = new InMemoryConnectionStore();
  await store.save(base('cline', 'cline'), { type: 'oauth', value: 'owner-token' });
  await store.save(base('clinepass', 'clinepass'), { type: 'api-key', value: 'sk-clinepass' });
  const credentials = new CredentialManager(store, { list: () => store.list(), get: (id) => store.getRecord(id) });
  const context = await credentials.context('clinepass', 'clinepass');
  assert.equal(context.credential?.type, 'api-key');
  assert.equal(context.credential && 'value' in context.credential ? context.credential.value : undefined, 'sk-clinepass');
});

test('overwriting a linked alias with its own credential clears the link', async () => {
  const store = new InMemoryConnectionStore();
  await store.save(base('cline', 'cline'), { type: 'oauth', value: 'cline-token' });
  await store.save(base('clinepass', 'clinepass', { credentialConnectionId: 'cline' }), { type: 'none' });
  // Migration-era record still reads the owner, which is what the link is for.
  const before = await store.getRecord('clinepass');
  assert.equal(before.credentialConnectionId, 'cline');

  // A link supplied on a save that carries its own credential is ignored, not honoured: the record
  // must read the credential it just stored, whatever a stale caller asked for.
  await store.save(base('clinepass', 'clinepass', { credentialConnectionId: 'cline' }), { type: 'oauth', value: 'new-grant' });
  const after = await store.getRecord('clinepass');
  assert.equal(after.credentialConnectionId, undefined, 'a record with its own credential must not keep reading the owner');
  const credentials = new CredentialManager(store, { list: () => store.list(), get: (id) => store.getRecord(id) });
  const context = await credentials.context('clinepass', 'clinepass');
  assert.equal(context.credential && 'value' in context.credential ? context.credential.value : undefined, 'new-grant');
});

test('a deliberate alias saved with no credential still reads the owner', async () => {
  const store = new InMemoryConnectionStore();
  await store.save(base('cline', 'cline'), { type: 'oauth', value: 'owner-token' });
  await store.save(base('clinepass', 'clinepass', { credentialConnectionId: 'cline' }), { type: 'none' });
  const credentials = new CredentialManager(store, { list: () => store.list(), get: (id) => store.getRecord(id) });
  const context = await credentials.context('clinepass', 'clinepass');
  assert.equal(context.credential && 'value' in context.credential ? context.credential.value : undefined, 'owner-token');
});
