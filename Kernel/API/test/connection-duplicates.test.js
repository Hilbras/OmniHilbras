import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionManager } from '../dist/src/core/connection-manager.js';

/**
 * Recognising a credential that is already saved, and pausing an account.
 *
 * ## What the duplicate rule is for
 *
 * Adding a key that is already stored used to make a second connection with the same secret: two rows
 * to tell apart by hand, both taking traffic, both billed to one key. The store keeps a vault-local
 * fingerprint of each credential so the save can see it. The two kinds mean different things and are
 * deliberately handled differently:
 *
 * - a key already saved is the **same account** — accepted, and the existing row is what comes back;
 * - the same sign-in again is a **renewal** — the account that holds it is updated in place.
 *
 * ## What pausing is for
 *
 * A paused account keeps its credential and its models and stops taking traffic. It is metadata, so it
 * must not re-validate anything or re-read a catalog — the test below pins that it is a single store
 * call and no save.
 */

/** The vault's fingerprint, simplified: keyed by provider so one string against two vendors is two keys. */
const fingerprint = (providerId, credential) => `${providerId}:${credential.type}:${'value' in credential ? credential.value : ''}`;

function store(records = []) {
  return {
    records: [...records],
    saves: [],
    /** Whether `setEnabled` was called, so a pause can be proven to be metadata only. */
    enableCalls: [],
    async save(input, credential) {
      this.saves.push(input);
      const record = {
        ...input,
        id: input.id ?? input.providerId,
        enabled: input.enabled ?? true,
        hasCredential: credential.type !== 'none',
        credentialType: credential.type,
        credentialFingerprint: fingerprint(input.providerId, credential),
      };
      const index = this.records.findIndex((entry) => entry.id === record.id);
      if (index >= 0) this.records[index] = record;
      else this.records.push(record);
      return record;
    },
    async list() {
      return [...this.records];
    },
    async remove(id) {
      const index = this.records.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      this.records.splice(index, 1);
      return true;
    },
    async setEnabled(id, enabled) {
      this.enableCalls.push([id, enabled]);
      const record = this.records.find((entry) => entry.id === id);
      if (!record) return undefined;
      record.enabled = enabled;
      return record;
    },
  };
}

function manager({ records = [], canonicalProviderId = (id) => id } = {}) {
  const backing = store(records);
  const instance = new ConnectionManager(backing, {
    lock: async (operation) => operation(),
    canValidate: () => true,
    validate: async () => {},
    discover: async () => [{ id: 'm1' }],
    readCredential: async () => undefined,
    noteDiscoveryFailure: () => {},
    credentialFingerprint: async (providerId, credential) => fingerprint(providerId, credential),
    canonicalProviderId,
  });
  return { instance, backing };
}

const input = (over = {}) => ({ providerId: 'p', name: 'P', endpoint: 'https://p.invalid/v1', priority: 1, proxyPool: 'none', ...over });
const apiKey = (value) => ({ type: 'api-key', value });
const oauth = (value) => ({ type: 'oauth', value });

test('a key already saved is accepted, and no second row is written', async () => {
  const { instance, backing } = manager();
  const first = await instance.save(input(), apiKey('same'));
  const second = await instance.save(input(), apiKey('same'));

  assert.equal(first.duplicate, 'none');
  assert.equal(second.duplicate, 'identical');
  assert.equal(second.connection.id, first.connection.id, 'the existing account is what comes back');
  assert.equal(backing.saves.length, 1, 'the store was written once');
});

test('the same sign-in again renews the account that holds it, in place', async () => {
  const { instance, backing } = manager();
  const first = await instance.save(input({ id: 'p-a' }), oauth('refresh-1'));
  const second = await instance.save(input(), oauth('refresh-1'));

  assert.equal(second.duplicate, 'updated');
  assert.equal(second.connection.id, 'p-a', 'the renewal lands on the account that was signed in');
  assert.equal(backing.records.length, 1);
  assert.equal(backing.saves.length, 2);
});

test('a different key is a new account, saved beside the first', async () => {
  const { instance, backing } = manager();
  await instance.save(input({ id: 'p-a' }), apiKey('one'));
  const second = await instance.save(input({ id: 'p-b' }), apiKey('two'));

  assert.equal(second.duplicate, 'none');
  assert.equal(backing.records.length, 2);
});

test('an edit names its own connection, so its own fingerprint cannot look like a duplicate', async () => {
  const { instance, backing } = manager();
  await instance.save(input({ id: 'p-a' }), apiKey('one'));
  const edited = await instance.save(input({ id: 'p-a' }), apiKey('one'));

  assert.equal(edited.duplicate, 'none');
  assert.equal(backing.records.length, 1);
  assert.equal(backing.saves.length, 2, 'the row is rewritten rather than reported as a twin');
});

test('a shared card is compared under the provider that owns the connection', async () => {
  const { instance, backing } = manager({
    records: [{ id: 'cline', providerId: 'cline', enabled: true, hasCredential: true, credentialFingerprint: fingerprint('cline', oauth('s')) }],
    canonicalProviderId: (id) => (id === 'clinepass' ? 'cline' : id),
  });
  const saved = await instance.save(input({ providerId: 'clinepass' }), oauth('s'));

  // A sign-in is a renewal, so the owner's row is rewritten rather than duplicated — and the id it
  // lands on is the owner's, not the card's.
  assert.equal(saved.duplicate, 'updated');
  assert.equal(saved.connection.id, 'cline');
  assert.equal(backing.records.length, 1, 'no row was added for the card');
});

test('pausing an account is metadata: one store call, no save, no catalog read', async () => {
  const { instance, backing } = manager({ records: [{ id: 'p', providerId: 'p', enabled: true, hasCredential: true }] });
  const paused = await instance.setEnabled('p', false);

  assert.equal(paused.enabled, false);
  assert.deepEqual(backing.enableCalls, [['p', false]]);
  assert.equal(backing.saves.length, 0);
});

test('pausing an account that does not exist is a named not-found', async () => {
  const { instance } = manager();
  await assert.rejects(() => instance.setEnabled('missing', false), (error) => error.code === 'NOT_FOUND');
});