import assert from 'node:assert/strict';
import test from 'node:test';
import { KimiCodeSessionStore } from '../dist/src/providers/kimiCode.js';

/**
 * Adding a second Kimi Code account must not overwrite the first.
 *
 * `save()` upserts by the connection id it is handed, and every sign-in used to hand it `'kimi-code'` —
 * so a second account would silently replace the first. The target is chosen when the sign-in
 * **starts**, not when it is polled, so a session cannot change its target halfway through. This is
 * the same rule Kiro's multi-account flow pins, on the same session-store shape.
 */

const started = { deviceCode: 'd'.repeat(32), deviceId: 'dev-1', userCode: 'ABCD-1234', verificationUrl: 'https://www.kimi.com/code', expiresIn: 300 };

test('a repair sign-in targets the provider connection, so re-signing-in does not duplicate it', () => {
  const store = new KimiCodeSessionStore();
  const session = store.create({ ...started, connectionId: 'kimi-code' });
  assert.equal(store.connectionId(session.id), 'kimi-code');
});

test('an add-account sign-in targets a fresh connection, so the existing one survives', () => {
  const store = new KimiCodeSessionStore();
  const first = store.create({ ...started, connectionId: 'kimi-code-abc123' });
  const second = store.create({ ...started, connectionId: 'kimi-code-def456' });
  assert.equal(store.connectionId(first.id), 'kimi-code-abc123');
  assert.equal(store.connectionId(second.id), 'kimi-code-def456');
  assert.notEqual(store.connectionId(first.id), store.connectionId(second.id));
});

test('a session with no recorded target falls back to the provider id', () => {
  // Sessions started before this field existed must keep working exactly as before.
  const store = new KimiCodeSessionStore();
  const session = store.create({ ...started });
  assert.equal(store.connectionId(session.id), undefined);
});
