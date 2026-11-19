import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialManager } from '../dist/src/core/credential-manager.js';
import { InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * ClinePass is its own provider and its own connection.
 *
 * OAuth is linked to the Cline account because WorkOS rotates one refresh token; an API key is an
 * independent account with no link. Both are records under `clinepass`, not a global alias.
 */

const base = (id, providerId, extra = {}) => ({
  id, providerId, name: id, endpoint: 'https://api.cline.bot/api/v1',
  priority: 1, proxyPool: 'none', enabled: true, modelIds: [], ...extra,
});

test('a linked ClinePass connection reads the owner credential without copying it', async () => {
  const store = new InMemoryConnectionStore();
  await store.save(base('cline', 'cline'), { type: 'oauth', value: 'owner-token', refreshToken: 'owner-refresh' });
  await store.save(base('clinepass', 'clinepass', { credentialConnectionId: 'cline' }), { type: 'none' });
  const credentials = new CredentialManager(store, { list: () => store.list(), get: (id) => store.getRecord(id) });
  const context = await credentials.context('clinepass', 'clinepass');
  assert.equal(context.credential?.type, 'oauth');
  assert.equal(context.credential && 'value' in context.credential ? context.credential.value : undefined, 'owner-token');
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
