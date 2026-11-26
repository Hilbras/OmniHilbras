import assert from 'node:assert/strict';
import test from 'node:test';
import { AdapterCredentialProvisioner } from '../dist/src/core/credential-provisioner.js';

/**
 * The provisioner is the lifecycle contract around the methods the renewal pass already trusts.
 * These tests pin the three claims it makes: what a credential is, whether the adapter can renew it,
 * and that revoking means the store forgets it.
 */

function fixture(overrides = {}) {
  const calls = [];
  const deleted = [];
  const adapter = {
    ...(overrides.renew === false ? {} : { renewCredential: async (credential) => { calls.push(credential); return { ...credential, value: 'new-token', expiresAt: '2030-01-01T00:00:00.000Z' }; } }),
    ...(overrides.expired === undefined ? {} : { isCredentialExpired: () => overrides.expired }),
  };
  const secrets = { delete: async (id) => { deleted.push(id); return true; } };
  return { provisioner: new AdapterCredentialProvisioner(adapter, secrets, 60_000), calls, deleted };
}

const oauth = { type: 'oauth', value: 'old-token', refreshToken: 'refresh', expiresAt: new Date(Date.now() + 30_000).toISOString() };

test('describe reports the type, expiry, expiring window and whether renewal exists', () => {
  const { provisioner } = fixture();
  const description = provisioner.describe(oauth);
  assert.equal(description.type, 'oauth');
  assert.equal(description.expiresAt, oauth.expiresAt);
  assert.equal(description.expiring, true, 'inside the one-minute window');
  assert.equal(description.renewable, true);
  assert.equal(description.revocable, true);

  const later = provisioner.describe({ ...oauth, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(later.expiring, false);
});

test('an adapter with its own expiry answer is believed over the raw date', () => {
  const { provisioner } = fixture({ expired: false });
  assert.equal(provisioner.describe(oauth).expiring, false);
});

test('refresh delegates to the adapter, and a provider that cannot renew says so', async () => {
  const { provisioner, calls } = fixture();
  const renewed = await provisioner.refresh(oauth);
  assert.equal(renewed?.value, 'new-token');
  assert.equal(calls.length, 1);

  const unable = fixture({ renew: false }).provisioner;
  assert.equal(await unable.refresh(oauth), undefined);
  assert.equal(unable.describe(oauth).renewable, false);
});

test('revoke forgets the credential in the connection store', async () => {
  const { provisioner, deleted } = fixture();
  assert.equal(await provisioner.revoke('acct-1'), true);
  assert.deepEqual(deleted, ['acct-1']);
});
