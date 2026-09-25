import assert from 'node:assert/strict';
import test from 'node:test';
import { ClineSessionStore, clineSessionTtlMs } from '../dist/index.js';

test('a started sign-in is pending until it is resolved', () => {
  const store = new ClineSessionStore();
  const { sessionId, state } = store.start('http://127.0.0.1:8787/v1/oauth/cline/callback');
  assert.equal(store.get(sessionId).status, 'pending');
  assert.ok(state.length >= 32, 'the state is long enough to be unguessable');
  assert.notEqual(state, sessionId);
});

test('the state can only be claimed once, so a callback cannot be replayed', () => {
  const store = new ClineSessionStore();
  const { sessionId, state } = store.start('http://127.0.0.1:8787/v1/oauth/cline/callback');
  assert.equal(store.claim(state)?.id, sessionId);
  assert.equal(store.claim(state), undefined, 'a replayed callback is refused');
  store.resolve(sessionId, { status: 'connected', connection: { id: 'cline', providerId: 'cline', name: 'Cline', modelIds: ['a'] } });
  assert.equal(store.claim(state), undefined, 'resolving does not make the state reusable');
});

test('a state from another sign-in is not accepted', () => {
  const store = new ClineSessionStore();
  const first = store.start('http://127.0.0.1:8787/v1/oauth/cline/callback');
  store.start('http://127.0.0.1:8787/v1/oauth/cline/callback');
  assert.equal(store.claim(first.state)?.id, first.sessionId);
  assert.equal(store.claim('never-issued'), undefined);
});

test('an unknown session reads as missing rather than pending', () => {
  const store = new ClineSessionStore();
  assert.equal(store.get('nope'), undefined);
});

test('a session is discarded once it expires', () => {
  let now = 1_000;
  const store = new ClineSessionStore({ now: () => now });
  const { sessionId, state } = store.start('http://127.0.0.1:8787/v1/oauth/cline/callback');
  now += clineSessionTtlMs + 1;
  assert.equal(store.claim(state), undefined, 'an expired state cannot be used');
  assert.equal(store.get(sessionId), undefined);
});

test('a resolved session is reported as connected with its connection', () => {
  const store = new ClineSessionStore();
  const { sessionId } = store.start('http://127.0.0.1:8787/v1/oauth/cline/callback');
  store.resolve(sessionId, { status: 'connected', connection: { id: 'cline', providerId: 'cline', name: 'Cline (a@b.c)', modelIds: ['m1', 'm2'] } });
  const status = store.get(sessionId);
  assert.equal(status.status, 'connected');
  assert.equal(status.connection.name, 'Cline (a@b.c)');
  assert.deepEqual(status.connection.modelIds, ['m1', 'm2']);
  assert.equal(JSON.stringify(status).includes('accessToken'), false, 'no credential is exposed');
  assert.equal(JSON.stringify(status).includes('refreshToken'), false, 'no credential is exposed');
});

test('a failed sign-in is reported as failed with a reason', () => {
  const store = new ClineSessionStore();
  const { sessionId } = store.start('http://127.0.0.1:8787/v1/oauth/cline/callback');
  store.resolve(sessionId, { status: 'failed', error: 'Cline did not accept that sign-in. Try again.' });
  assert.deepEqual(store.get(sessionId), { status: 'failed', error: 'Cline did not accept that sign-in. Try again.' });
});

test('sessions do not accumulate', () => {
  let now = 1_000;
  const store = new ClineSessionStore({ now: () => now });
  for (let i = 0; i < 50; i += 1) store.start('http://127.0.0.1:8787/v1/oauth/cline/callback');
  now += clineSessionTtlMs + 1;
  store.start('http://127.0.0.1:8787/v1/oauth/cline/callback');
  assert.equal(store.sessions.size, 1, 'expired sessions are swept');
});
