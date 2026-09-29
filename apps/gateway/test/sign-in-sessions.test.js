import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SignInSessionStore, claimOnce, releaseClaim } from '../dist/sign-in-sessions.js';
import { KiroSessionStore, KiroSocialStore } from '../dist/kiro.js';
import { OpencodeConsoleSessionStore } from '../dist/opencodeConsole.js';

/**
 * The one sign-in session lifecycle.
 *
 * `KiroSessionStore` and `OpencodeConsoleSessionStore` were 67 and 76 lines whose lifecycle was
 * byte-for-byte identical, and `KiroSocialStore` had a third copy of the one rule that matters most.
 * The tests below are for the rules, not for the move — and the rules are the parts that are easy to
 * get subtly wrong and hard to notice.
 */

const idPattern = /^[A-Za-z0-9_-]{16,128}$/;

function store({ ttlMs = 15 * 60_000, now } = {}) {
  let clock = 1_000_000;
  const instance = new SignInSessionStore(
    {
      ttlMs,
      isPlausibleId: (id) => idPattern.test(id),
      build: (input, base) => ({ ...base, payload: input, status: 'pending', claimed: false }),
      read: (session) => ({ userCode: session.payload.userCode, verificationUrl: session.payload.verificationUrl }),
      now: now ?? (() => clock),
    },
  );
  return { instance, tick: (ms) => { clock += ms; } };
}

const payload = (over = {}) => ({ userCode: 'ABCD-EFGH', verificationUrl: 'https://example.invalid/device', ...over });

// ── the spending rule ──────────────────────────────────────────────────────

test('a grant is spent exactly once, however many times it is claimed', () => {
  const { instance } = store();
  const session = instance.create(payload());
  assert.ok(instance.claim(session.id), 'the first claim gets the grant');
  // The second poll arrives because a browser retried, a user double-clicked, or two tabs were
  // open. Spending the grant twice is an OAuth code used twice: the second attempt fails at the
  // provider with an error that looks like a bug rather than a race.
  assert.equal(instance.claim(session.id), undefined, 'the second claim gets nothing');
  assert.equal(instance.claim(session.id), undefined, 'and neither does the third');
});

test('a failed exchange can be retried, so a network blip does not burn the sign-in', () => {
  const { instance } = store();
  const session = instance.create(payload());
  const claimed = instance.claim(session.id);
  instance.release(claimed);
  assert.ok(instance.claim(session.id), 'the user should not have to start over for our failure');
});

test('the spending rule is one function, and all three stores use it', () => {
  // Three copies of a rule about whether someone's OAuth code can be spent twice is two too many.
  const source = readFileSync(new URL('../src/sign-in-sessions.ts', import.meta.url), 'utf8');
  // Stripped of comments first: this file *quotes* the rule in its own header, and counting that
  // would report two implementations when there is one.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal([...code.matchAll(/claimed = true/g)].length, 1, 'exactly one implementation');
  for (const file of ['../src/kiro.ts', '../src/opencodeConsole.ts']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(text.includes('claimed = true'), false, `${file} must not re-implement the rule`);
  }
  // And the standalone rule works with no session shape at all, which is what lets the social store
  // share it despite having a different lifecycle.
  const held = { claimed: false };
  assert.ok(claimOnce(() => held));
  assert.equal(claimOnce(() => held), undefined);
  releaseClaim(held);
  assert.ok(claimOnce(() => held), 'released and spendable again');
  assert.equal(claimOnce(() => undefined), undefined, 'nothing to claim is not a claim');
});

// ── expiry ─────────────────────────────────────────────────────────────────

test('a session that has timed out reads as expired, not as missing', () => {
  // "Not found" and "you let it lapse" are different problems, and the dashboard says different
  // things about them. A swept session would read as the first and send the user looking for a bug.
  const { instance, tick } = store();
  const session = instance.create(payload());
  tick(16 * 60_000);
  const read = instance.get(session.id);
  assert.equal(read.status, 'expired');
  assert.match(read.error, /expired before it was approved/);
});

test('a provider cannot hold a grant longer than the store’s ceiling', () => {
  // A provider saying its grant is good for a day must not park a credential-bearing payload in
  // memory for a day, because the window a user signs in within is minutes.
  const { instance, tick } = store({ ttlMs: 60_000 });
  const session = instance.create(payload(), 86_400);
  tick(61_000);
  assert.equal(instance.get(session.id).status, 'expired');
});

test('a provider asking for less than the ceiling gets what it asked for', () => {
  const { instance, tick } = store({ ttlMs: 60 * 60_000 });
  const session = instance.create(payload(), 120);
  tick(121_000);
  assert.equal(instance.get(session.id).status, 'expired');
});

test('a resolved session keeps its own status, because a slow sweep must not overwrite it', () => {
  const { instance, tick } = store();
  const session = instance.create(payload());
  instance.resolve(session.id, { status: 'connected' });
  tick(16 * 60_000);
  assert.equal(instance.get(session.id).status, 'connected');
});

test('an id that is not even shaped like one of ours is not looked up', () => {
  const { instance } = store();
  instance.create(payload());
  assert.equal(instance.get('short'), undefined);
  assert.equal(instance.get('../../etc/passwd'), undefined);
  assert.equal(instance.claim(''), undefined);
});

test('a session with no stated expiry gets the ceiling, not a fraction of it', () => {
  // The two stores this replaced wrote the fallback as `(ttlMs / 60000) * 1000`, which is
  // `ttlMs / 60`: a 15-minute ceiling silently became a 15-second session. It hid because every
  // provider that works sends `expires_in`, and the broken conversion only ran on the path where
  // one does not — so a browser sign-in would die in 15 seconds for a provider that went quiet.
  const { instance, tick } = store({ ttlMs: 60_000 });
  const session = instance.create(payload());
  tick(30_000);
  assert.equal(instance.get(session.id).status, 'pending', 'half the ceiling has not elapsed yet');
  tick(31_000);
  assert.equal(instance.get(session.id).status, 'expired', 'and the ceiling has');
});

test('a session outlives its expiry by one ceiling, so a late poll still learns why', () => {
  // The sweep keeps a session for one ttl *after* it expires. That margin is the point: a dashboard
  // that polls after the window closed must be able to say "this expired" rather than "no such
  // sign-in", because those send the user looking for two different problems.
  const { instance, tick } = store({ ttlMs: 60_000 });
  const old = instance.create(payload());
  tick(120_000);
  const recent = instance.create(payload());
  assert.equal(instance.size, 2, 'the expired one is retained through the margin');
  assert.equal(instance.get(old.id)?.status, 'expired', 'and it reads as expired, not as missing');
  assert.equal(instance.get(recent.id)?.status, 'pending');

  tick(60_000);
  instance.create(payload());
  assert.equal(instance.get(old.id), undefined, 'past the margin it is finally dropped, so memory cannot grow without bound');
});

test('the sweep runs on create, so a store nobody signs in to does not grow', () => {
  // Sessions are only swept when a new one arrives. That is the original's behaviour and it is
  // safe: a store with no new sign-ins also has no growth, and a restart clears the lot.
  const { instance } = store({ ttlMs: 60_000 });
  for (let index = 0; index < 5; index += 1) instance.create(payload());
  assert.equal(instance.size, 5);
  instance.create(payload());
  assert.equal(instance.size, 6, 'all recent, so all kept');
});

// ── the public projection ──────────────────────────────────────────────────

test('the public status carries what the user needs, and never the provider’s payload', () => {
  // A sign-in session holds a device code, and a device code is a credential. This projection is
  // the only part that reaches a browser.
  const { instance } = store();
  const session = instance.create({ ...payload(), deviceCode: 'device-code-secret' });
  const status = instance.publicStatus(session);
  assert.equal(status.userCode, 'ABCD-EFGH');
  assert.equal(status.verificationUrl, 'https://example.invalid/device');
  assert.equal(JSON.stringify(status).includes('device-code-secret'), false, 'a device code must never be projected');
  assert.equal(status.connection, undefined);
});

test('a failure and a connection reach the public status when there are any', () => {
  const { instance } = store();
  const session = instance.create(payload());
  instance.resolve(session.id, { status: 'failed', error: 'The provider said no.' });
  assert.equal(instance.publicStatus(session).error, 'The provider said no.');
  instance.resolve(session.id, { status: 'connected', connection: { id: 'c1' } });
  const connected = instance.publicStatus(session);
  assert.equal(connected.status, 'connected');
  assert.deepEqual(connected.connection, { id: 'c1' });
});

test('resolve on a session that is gone is a no-op, not a throw', () => {
  const { instance } = store();
  // A poll resolving after a sweep must not take the gateway down with it.
  assert.doesNotThrow(() => instance.resolve('nonexistent', { status: 'connected' }));
});

// ── each provider's shape survives ─────────────────────────────────────────

test('Kiro keeps its nested authorization, because the polling path reads it', () => {
  const sessions = new KiroSessionStore();
  const authorization = { deviceCode: 'd', userCode: 'K-1', verificationUrl: 'https://kiro.invalid', expiresIn: 900 };
  const session = sessions.create(authorization);
  assert.deepEqual(session.authorization, authorization);
  assert.equal(sessions.claim(session.id)?.authorization.userCode, 'K-1');
});

test('OpenCode Console keeps its flat device code, because the service reads it', () => {
  const sessions = new OpencodeConsoleSessionStore();
  const session = sessions.create({ deviceCode: 'device-1', userCode: 'C-1', verificationUrl: 'https://console.invalid' });
  assert.equal(session.deviceCode, 'device-1');
  assert.equal(sessions.claim(session.id)?.userCode, 'C-1');
});

test('a social sign-in spends its code once too, through the same rule', () => {
  const social = new KiroSocialStore();
  const id = social.create('google', 'verifier', 'state');
  assert.ok(social.claim(id), 'the first callback gets the code');
  // A browser that retries its callback must not spend the code twice, and the social flow is the
  // one most likely to be retried: it is a redirect, and a redirect is exactly what a user redoes.
  assert.equal(social.claim(id), undefined);
  social.release(id);
  assert.ok(social.claim(id), 'and a failed exchange can be retried');
});

test('all three stores reject an implausible session id the same way', () => {
  const kiro = new KiroSessionStore();
  const console_ = new OpencodeConsoleSessionStore();
  const social = new KiroSocialStore();
  for (const claim of [() => kiro.claim('short'), () => console_.claim('short'), () => social.claim('short')]) {
    assert.equal(claim(), undefined);
  }
});

// ── the invariant ──────────────────────────────────────────────────────────

test('THE INVARIANT: no sign-in store re-implements the spending rule', () => {
  for (const file of ['../src/kiro.ts', '../src/opencodeConsole.ts', '../src/oauth.ts']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.equal(/claimed\s*=\s*true/.test(code), false, `${file} sets \`claimed\` by hand`);
  }
});
