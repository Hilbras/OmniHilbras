import assert from 'node:assert/strict';
import test from 'node:test';
import { ClineSessionStore, clineSessionTtlMs } from '../dist/index.js';

test('a started sign-in is pending until it is resolved', () => {
  const store = new ClineSessionStore();
  const { sessionId, state } = store.start((id) => `http://127.0.0.1:8787/v1/oauth/cline/callback/${id}`);
  assert.equal(store.get(sessionId).status, 'pending');
  assert.ok(state.length >= 32, 'the state is long enough to be unguessable');
  assert.notEqual(state, sessionId);
});

test('the session can only be claimed once, so a callback cannot be replayed', () => {
  const store = new ClineSessionStore();
  const { sessionId } = store.start((id) => `http://127.0.0.1:8787/v1/oauth/cline/callback/${id}`);
  assert.equal(store.claim(sessionId)?.id, sessionId);
  assert.equal(store.claim(sessionId), undefined, 'a replayed callback is refused');
  store.resolve(sessionId, { status: 'connected', connection: { id: 'cline', providerId: 'cline', name: 'Cline', modelIds: ['a'] } });
  assert.equal(store.claim(sessionId), undefined, 'resolving does not make the session reusable');
});

test('a callback still works when the provider drops the state', () => {
  const store = new ClineSessionStore();
  const { sessionId, state } = store.start((id) => `http://127.0.0.1:8787/v1/oauth/cline/callback/${id}`);
  // Cline's AuthKit handoff never echoes `state`, so the path is the only link.
  assert.ok(state.length >= 32, 'a state is still minted and sent');
  assert.equal(store.claim(sessionId)?.id, sessionId, 'the path alone identifies the session');
  assert.equal(store.claim(sessionId, state), undefined, 'and it is still single use');
});

test('a state that comes back must match the session it claims', () => {
  const store = new ClineSessionStore();
  const first = store.start((id) => `http://127.0.0.1:8787/v1/oauth/cline/callback/${id}`);
  const second = store.start((id) => `http://127.0.0.1:8787/v1/oauth/cline/callback/${id}`);
  assert.equal(store.claim(first.sessionId, second.state), undefined, 'a crossed state is refused');
  assert.equal(store.claim(first.sessionId, 'never-issued'), undefined);
  // The mismatched attempt did not spend the session.
  assert.equal(store.claim(first.sessionId, first.state)?.id, first.sessionId);
});

test('an unknown session id is not claimable', () => {
  const store = new ClineSessionStore();
  store.start((id) => `http://127.0.0.1:8787/v1/oauth/cline/callback/${id}`);
  assert.equal(store.claim('never-issued'), undefined);
});

test('an unknown session reads as missing rather than pending', () => {
  const store = new ClineSessionStore();
  assert.equal(store.get('nope'), undefined);
});

test('a session is discarded once it expires', () => {
  let now = 1_000;
  const store = new ClineSessionStore({ now: () => now });
  const { sessionId, state } = store.start((id) => `http://127.0.0.1:8787/v1/oauth/cline/callback/${id}`);
  now += clineSessionTtlMs + 1;
  assert.equal(store.claim(sessionId, state), undefined, 'an expired session cannot be used');
  assert.equal(store.get(sessionId), undefined);
});

test('a resolved session is reported as connected with its connection', () => {
  const store = new ClineSessionStore();
  const { sessionId } = store.start((id) => `http://127.0.0.1:8787/v1/oauth/cline/callback/${id}`);
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
  const { sessionId } = store.start((id) => `http://127.0.0.1:8787/v1/oauth/cline/callback/${id}`);
  store.resolve(sessionId, { status: 'failed', error: 'Cline did not accept that sign-in. Try again.' });
  assert.deepEqual(store.get(sessionId), { status: 'failed', error: 'Cline did not accept that sign-in. Try again.' });
});

test('sessions do not accumulate', () => {
  let now = 1_000;
  const store = new ClineSessionStore({ now: () => now });
  for (let i = 0; i < 50; i += 1) store.start((id) => `http://127.0.0.1:8787/v1/oauth/cline/callback/${id}`);
  now += clineSessionTtlMs + 1;
  store.start((id) => `http://127.0.0.1:8787/v1/oauth/cline/callback/${id}`);
  assert.equal(store.sessions.size, 1, 'expired sessions are swept');
});
