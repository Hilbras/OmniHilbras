import assert from 'node:assert/strict';
import test from 'node:test';
import { KiroSessionStore } from '../dist/src/providers/kiro.js';

/**
 * Adding a second Kiro account must not overwrite the first.
 *
 * `save()` upserts by the connection id it is handed, and every sign-in used to hand it `'kiro'` — so a
 * second account silently replaced the first. The choice is made when the sign-in **starts**, not when it
 * is polled, so a session cannot change its target halfway through.
 */

const authorization = { expiresIn: 300 };

test('a repair sign-in targets the provider connection, so re-signing-in does not duplicate it', () => {
  const store = new KiroSessionStore();
  const session = store.create({ ...authorization, connectionId: 'kiro' } );
  assert.equal(store.connectionId(session.id), 'kiro');
});

test('an add-account sign-in targets a fresh connection, so the existing one survives', () => {
  const store = new KiroSessionStore();
  const first = store.create({ ...authorization, connectionId: 'kiro-abc123' });
  const second = store.create({ ...authorization, connectionId: 'kiro-def456' });
  assert.equal(store.connectionId(first.id), 'kiro-abc123');
  assert.equal(store.connectionId(second.id), 'kiro-def456');
  assert.notEqual(store.connectionId(first.id), store.connectionId(second.id));
});

test('a session with no recorded target falls back to the provider id', () => {
  // Sessions started before this field existed must keep working exactly as before.
  const store = new KiroSessionStore();
  const session = store.create({ ...authorization });
  assert.equal(store.connectionId(session.id), 'kiro');
});
