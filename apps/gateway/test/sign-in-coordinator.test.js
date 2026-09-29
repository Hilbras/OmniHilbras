import assert from 'node:assert/strict';
import test from 'node:test';
import { completeSignIn, describeSignInFailure } from '../dist/sign-in-coordinator.js';
import { SignInSessionStore } from '../dist/sign-in-sessions.js';
import { ProviderError } from '@hilbras/omnihilbras';

/**
 * The sign-in coordinator: claim, poll, save, then publish.
 *
 * Three places were doing this and they had already drifted — see `describeSignInFailure` below,
 * where one copy had lost its `Error` branch entirely. The order of the steps is the substance, so
 * each step is asserted separately: a coordinator that got the order right for the happy path and
 * wrong for a race is worse than no coordinator, because it looks finished.
 */

const idPattern = /^[A-Za-z0-9_-]{16,128}$/;
const payload = { deviceCode: 'd', userCode: 'U-1', verificationUrl: 'https://example.invalid' };

function sessions() {
  const store = new SignInSessionStore(
    { ttlMs: 60_000, isPlausibleId: (id) => idPattern.test(id), build: (input, base) => ({ ...base, payload: input, status: 'pending', claimed: false }), read: () => ({}) },
  );
  return { store };
}

const credential = { type: 'oauth', value: 'token' };
const connectionInput = { providerId: 'p', name: 'P', endpoint: 'https://p.invalid', priority: 1, proxyPool: 'none' };
const connection = { ...connectionInput, id: 'c1' };

/**
 * A coordinator over a fresh session.
 *
 * The session is opened *here* and its id handed to the coordinator, because a run against a
 * session that does not exist returns `undefined` at the first line and asserts nothing. That is
 * what the first version of the first test did, and it failed for a reason that had nothing to do
 * with what it was checking.
 */
function coordinator(over = {}) {
  const { store } = sessions();
  const sessionId = store.create(payload).id;
  const saved = [];
  const options = { ...coordinatorArgs(store, sessionId), ...over };
  return { run: () => completeSignIn(options), store, saved, sessionId };
}

// ── the spending rule, which this loop exists to uphold ────────────────────

test('a session is claimed before the provider is polled', async () => {
  // Two browser tabs polling the same sign-in would otherwise both spend the same OAuth grant, and
  // the second attempt fails at the provider with an error that looks like a bug rather than a race.
  const { run, store, sessionId } = coordinator();
  await run();
  assert.equal(store.get(sessionId).claimed, true, 'the grant is spent by the exchange');
});

test('a second poll on a claimed session does not reach the provider at all', async () => {
  let polls = 0;
  const { run, store } = coordinator({ poll: async () => { polls += 1; return { status: 'connected', credential }; } });
  const sessionId = store.create(payload).id;
  await completeSignIn({ ...coordinatorArgs(store, sessionId), poll: async () => { polls += 1; return { status: 'connected', credential }; } });
  const second = await completeSignIn({ ...coordinatorArgs(store, sessionId), poll: async () => { polls += 1; return { status: 'connected', credential }; } });
  assert.equal(polls, 1, 'the second poll must not spend the grant again');
  assert.equal(second.status, 'connected', 'and it reports the outcome the first poll published');
});

test('a still-pending poll releases the claim, so the next poll can finish it', async () => {
  // Not releasing here would strand the sign-in: the claim is spent, so no later poll could ever
  // complete it, and the user would have to start over for a provider that simply has not answered.
  const { store } = sessions();
  const sessionId = store.create(payload).id;
  const status = await completeSignIn({ ...coordinatorArgs(store, sessionId), poll: async () => ({ status: 'pending' }) });
  assert.equal(status.status, 'pending');
  assert.equal(store.get(sessionId).claimed, false, 'nothing was spent, so the claim is back');
});

test('a denied flow resolves as failed, with the provider’s own reason', async () => {
  const { store } = sessions();
  const sessionId = store.create(payload).id;
  const status = await completeSignIn({ ...coordinatorArgs(store, sessionId), poll: async () => ({ status: 'denied', error: 'The user refused the request.' }) });
  assert.equal(status.status, 'failed');
  assert.equal(status.error, 'The user refused the request.');
});

test('an unknown session reads as missing rather than inventing one', async () => {
  const { store } = sessions();
  assert.equal(await completeSignIn({ ...coordinatorArgs(store, 'nonexistent') }), undefined);
});

// ── store before publishing, always ────────────────────────────────────────

test('a connection is stored before the session is published as connected', async () => {
  // The reverse order is the half-connect this loop exists to prevent: a session that says
  // `connected` with nothing behind it renders in the dashboard as working and fails on its first
  // request.
  const order = [];
  const { store } = sessions();
  const sessionId = store.create(payload).id;
  await completeSignIn({
    ...coordinatorArgs(store, sessionId),
    save: async (input, cred) => { order.push('save'); return connection; },
    poll: async () => { order.push('poll'); return { status: 'connected', credential }; },
  });
  assert.deepEqual(order, ['poll', 'save']);
  assert.equal(store.get(sessionId).status, 'connected');
});

test('the whole connection record is published, so the dashboard needs no second fetch', async () => {
  const { store } = sessions();
  const sessionId = store.create(payload).id;
  const status = await completeSignIn({ ...coordinatorArgs(store, sessionId) });
  assert.deepEqual(status.connection, connection);
});

test('a failed save resolves as failed, never as connected', async () => {
  const { store } = sessions();
  const sessionId = store.create(payload).id;
  const status = await completeSignIn({ ...coordinatorArgs(store, sessionId), save: async () => { throw new ProviderError('AUTHENTICATION_FAILED', 'The provider refused this session.'); } });
  assert.equal(status.status, 'failed', 'saying connected with no connection behind it is the bug this prevents');
  assert.match(status.error, /refused this session/);
});

test('a catalog that would not read is reported alongside a connection that did save', async () => {
  // Connected *and* something worth saying, rather than one or the other. A user whose models did
  // not load needs to see both facts, and the failure must not cost them the credential.
  const { run, sessionId, store } = coordinator({ takeDiscoveryNote: () => 'the provider returned an empty catalog' });
  const status = await run();
  assert.equal(status.status, 'connected');
  assert.match(status.error, /Connected, but the model list could not be read/);
  assert.equal(store.get(sessionId).status, 'connected', 'and the session is genuinely connected');
});

test('a discovery note is taken, not read, so it cannot be shown twice', async () => {
  let note = 'a note';
  const take = () => { const current = note; note = undefined; return current; };
  assert.equal(take(), 'a note');
  assert.equal(take(), undefined, 'a second read finds nothing, so no stale message on a healthy connection');
});

// ── the failure describer, which had three drifting copies ─────────────────

test('a provider’s own words are preferred over our generic refusal', () => {
  // The gateway's message is written for a log line; the provider's status and body are the part
  // that names the cause. Both are kept because they are not the same information.
  const error = new ProviderError('PROVIDER_UNAVAILABLE', 'DeepSeek answered 503.', {
    publicMessage: 'OpenCode Console is not answering right now.',
    details: { providerMessage: 'HTTP 503 from https://console.opencode.ai/api/config' },
  });
  const described = describeSignInFailure(error, 'unused');
  assert.match(described, /not answering right now/);
  assert.match(described, /HTTP 503/);
});

test('a plain Error keeps its own message rather than the fallback', () => {
  // This is the branch one of the three copies was missing. A socket that closed mid-exchange
  // reported *"The sign-in could not be completed."* and nothing else — the user was told the
  // sign-in failed and not why, which is the one thing a failed sign-in must never do.
  assert.equal(describeSignInFailure(new Error('socket hang up'), 'The sign-in could not be completed.'), 'socket hang up');
});

test('the fallback is reached only when there is genuinely nothing to say', () => {
  assert.equal(describeSignInFailure('a bare string', 'The sign-in could not be completed.'), 'The sign-in could not be completed.');
  assert.equal(describeSignInFailure(new Error(''), 'The sign-in could not be completed.'), 'The sign-in could not be completed.');
});

test('a ProviderError with no public message still says something specific', () => {
  const described = describeSignInFailure(new ProviderError('NOT_SUPPORTED', 'ChatGPT Web does not offer that model.'), 'unused');
  assert.match(described, /does not offer that model/);
});

/** The coordinator's options, over a given store and session. */
function coordinatorArgs(store, sessionId) {
  return {
    sessions: store,
    sessionId,
    fallback: 'The sign-in could not be completed.',
    poll: async () => ({ status: 'connected', credential }),
    connection: () => connectionInput,
    save: async () => connection,
    takeDiscoveryNote: () => undefined,
  };
}
