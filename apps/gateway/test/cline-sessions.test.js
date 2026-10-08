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
  // Cline's AuthKit handoff sends back no state at all, so the path is the
  // only link.
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

// ---------------------------------------------------------------------------
// The state Cline actually sends back
// ---------------------------------------------------------------------------

/**
 * A real `state` value captured from `api.cline.bot` on 2026-10-08, with the
 * loopback callback it names. The value we sent is nowhere in it.
 *
 * This is the whole bug: the store demanded an exact match, so every callback
 * Cline genuinely produced was refused, the session stayed `pending`, and the
 * dashboard polled it until the dialog's five-minute timeout — naming neither
 * the refusal nor a reason.
 */
const CLINE_SESSION_ID = `${'a'.repeat(43)}0123456789abcdefghij`;
const CLINE_REDIRECT = `http://127.0.0.1:8788/v1/oauth/cline/callback/${CLINE_SESSION_ID}`;
const CLINE_BLOB = 'eyJjbGllbnRfdHlwZSI6ImV4dGVuc2lvbiIsImNhbGxiYWNrX3VybCI6Imh0dHA6Ly8xMjcuMC4wLjE6ODc4OC92MS9vYXV0aC9jbGluZS9jYWxsYmFjay9hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhMDEyMzQ1Njc4OWFiY2RlZmdoaWoifQAAjJMSSyRNjZyBwz7_66Mo8zLUrpd4kvlFN9oiuNmu';

test("a callback carrying Cline's own state can claim its session", () => {
  const store = new ClineSessionStore();
  // The blob is minted for one specific redirect, so the session under test has
  // to be the one that redirect names — which is what the session id in the
  // loopback path guarantees in production.
  const started = store.start(() => CLINE_REDIRECT);
  assert.equal(started.redirectUri, CLINE_REDIRECT);
  assert.equal(store.claim(started.sessionId, CLINE_BLOB)?.id, started.sessionId,
    'the value Cline replaced our state with is accepted when it names this callback');
});

test("Cline's state naming a different callback is refused", () => {
  const store = new ClineSessionStore();
  // A different session on the same machine, so the blob was minted for *that*
  // one and replayed here. Accepting it is what the cross-check exists to stop.
  const other = store.start(() => `http://127.0.0.1:8788/v1/oauth/cline/callback/${'b'.repeat(43)}`);
  assert.equal(store.claim(other.sessionId, CLINE_BLOB), undefined);
  assert.equal(store.claim(other.sessionId, CLINE_BLOB), undefined, 'and the refusal spent nothing, so it can be retried');
});

test('a state from another sign-in is still refused after Cline stopped echoing', () => {
  const store = new ClineSessionStore();
  const first = store.start(() => CLINE_REDIRECT);
  const second = store.start(() => CLINE_REDIRECT);
  // The blob is accepted on its own terms, so the crossed-state case has to be
  // pinned separately: accepting Cline's blob must not have widened the check to
  // "any decodable state".
  assert.equal(store.claim(first.sessionId, second.state), undefined, 'a crossed state is refused');
  assert.equal(store.claim(first.sessionId, 'never-issued'), undefined);
  assert.equal(store.claim(first.sessionId, CLINE_BLOB)?.id, first.sessionId, 'the refused attempts spent nothing');
});

test('failPending ends a sign-in that is still waiting, and leaves a finished one alone', () => {
  const waiting = new ClineSessionStore();
  const stuck = waiting.start(() => CLINE_REDIRECT);
  waiting.failPending(stuck.sessionId, 'callback refused');
  assert.deepEqual(waiting.get(stuck.sessionId), { status: 'failed', error: 'callback refused' },
    'the dashboard stops polling a session that was never going to change');

  // A callback that cannot be claimed may be a *replay* of one that already
  // succeeded. Overwriting the result would replace a connection the dashboard is
  // already showing with an error about nothing.
  const done = new ClineSessionStore();
  const finished = done.start(() => CLINE_REDIRECT);
  done.resolve(finished.sessionId, { status: 'connected', connection: { id: 'cline', providerId: 'cline', name: 'Cline', modelIds: ['m'] } });
  done.failPending(finished.sessionId, 'replay');
  assert.equal(done.get(finished.sessionId).status, 'connected', 'a finished sign-in keeps its result');

  // And an unknown session is still unknown, rather than being conjured into one.
  done.failPending('never-issued', 'nope');
  assert.equal(done.get('never-issued'), undefined);
});
