import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { HedgePolicy } from '../dist/hedge-policy.js';
import { providerIds } from './support/providerIds.js';

/**
 * `HedgePolicy`: whether a second request is worth sending, and which route.
 *
 * This decision decides how many *paid* requests a gateway makes on a client's behalf, and every
 * clause is a reason not to spend. So the tests are about the refusals, and each one asserts the
 * reason — because "no hedge fired" and "a hedge fired and lost" are completely different outcomes,
 * and a caller whose `hedgeAfterMs` did nothing is owed an answer other than silence.
 */

const policy = new HedgePolicy();

const candidate = (providerId, { hedgeAfterMs = 0, priority = 0 } = {}) => ({
  providerId,
  connectionId: `c-${providerId}`,
  priority,
  resilience: { maxRetries: 0, timeoutMs: 30_000, requestsPerMinute: 0, hedgeAfterMs },
});

const led = candidate('leader', { hedgeAfterMs: 200 });
const alt = candidate('alt');
const alt2 = candidate('alt2');

// ── the static half: is hedging configured at all ──────────────────────────

test('hedging is off unless the connection asked for it', () => {
  // A hedge is an extra request the operator pays for, and the client gets the *faster* answer
  // rather than a cheaper one, so it is not a default anyone should inherit.
  const plan = policy.planFor([led, alt]);
  assert.equal(plan.enabled, true);
  assert.equal(plan.delayMs, 200, 'and the delay is the leader’s own configured value');
  assert.equal(policy.planFor([candidate('leader'), alt]).reason, 'not-configured');
  assert.equal(policy.planFor([candidate('leader', { hedgeAfterMs: 0 }), alt]).reason, 'not-configured');
});

test('a single route is never hedged, because a hedge would be a second copy of the same call', () => {
  // The whole point of a hedge is a *different* route answering faster. With one route there is
  // none, and the only thing a hedge would buy is paying twice for one answer.
  const plan = policy.planFor([led]);
  assert.equal(plan.enabled, false);
  assert.equal(plan.reason, 'no-alternative');
  assert.equal(policy.planFor([]).reason, 'no-leader');
});

test('the hedge delay comes from the leader, not from whoever is hedged', () => {
  // The delay is a property of the request being slow, which is the leader's business. Taking it
  // from a candidate would mean the second request's own settings silently retimed the first.
  const plan = policy.planFor([candidate('leader', { hedgeAfterMs: 50 }), candidate('alt', { hedgeAfterMs: 5_000 })]);
  assert.equal(plan.delayMs, 50);
});

test('the plan carries the alternatives in preference order', () => {
  const plan = policy.planFor([led, alt, alt2]);
  assert.deepEqual(plan.rest.map((entry) => entry.providerId), ['alt', 'alt2']);
});

// ── the per-tick half: is *this* tick worth spending on ────────────────────

const plan = policy.planFor([led, alt, alt2]);
const tick = (over = {}) => policy.nextHedge({ plan, started: new Set([led]), settledCount: 0, hasWinner: false, aborted: false, ...over });

test('a hedge is sent while the leader is still in flight', () => {
  const decision = tick();
  assert.equal(decision.hedge, true);
  assert.equal(decision.candidate.providerId, 'alt', 'the first alternative, in preference order');
});

test('a hedge is never sent once anything has settled', () => {
  // **The clause that costs the most.** If the leader has already answered, a second request buys
  // an answer nobody will read — paid for in full. This is checked on every tick rather than once,
  // so it is the one most likely to drift if the tick and the settle bookkeeping live apart.
  assert.deepEqual(tick({ settledCount: 1 }), { hedge: false, reason: 'leader-settled' });
});

test('a hedge is never sent once someone has won', () => {
  assert.deepEqual(tick({ hasWinner: true }), { hedge: false, reason: 'already-won' });
});

test('a hedge is never sent for a request the caller cancelled', () => {
  // Checked before anything else is looked at, because there is nothing left to decide.
  assert.deepEqual(tick({ aborted: true }), { hedge: false, reason: 'cancelled' });
  assert.deepEqual(tick({ aborted: true, hasWinner: true }), { hedge: false, reason: 'already-won' }, 'and a win is reported ahead of it, so the ledger reads truthfully');
});

test('each hedge takes the next unstarted route, in order', () => {
  assert.equal(tick().candidate.providerId, 'alt');
  assert.equal(tick({ started: new Set([led, alt]) }).candidate.providerId, 'alt2', 'the one already hedged with is not hedged with twice');
});

test('hedge with nothing left to hedge with, and stop', () => {
  assert.deepEqual(tick({ started: new Set([led, alt, alt2]) }), { hedge: false, reason: 'exhausted' });
});

test('a plan that was never enabled refuses, whatever the tick says', () => {
  // Belt and braces: a caller that skipped `planFor` and passed a plan it built by hand gets a
  // refusal rather than a hedge it never configured.
  const off = policy.planFor([candidate('leader'), alt]);
  assert.deepEqual(policy.nextHedge({ plan: off, started: new Set(), settledCount: 0, hasWinner: false, aborted: false }), { hedge: false, reason: 'not-configured' });
});

// ── the property that matters: the refusals cost nothing ───────────────────

test('every refusal names a reason, so no request is sent for a reason nobody recorded', () => {
  // The reason is the whole point of extracting this. A bare `return` inside a timer callback is a
  // decision with no account of itself, and the only way to learn why a configured `hedgeAfterMs`
  // did nothing is to read the loop.
  const reasons = [
    policy.planFor([]).reason,
    policy.planFor([led]).reason,
    policy.planFor([candidate('leader'), alt]).reason,
    tick({ settledCount: 1 }).reason,
    tick({ hasWinner: true }).reason,
    tick({ aborted: true }).reason,
    tick({ started: new Set([led, alt, alt2]) }).reason,
  ];
  for (const reason of reasons) {
    assert.equal(typeof reason, 'string', 'a refusal without a reason is a silent decision');
    assert.ok(reason.length > 0);
  }
  assert.deepEqual(reasons, ['no-leader', 'no-alternative', 'not-configured', 'leader-settled', 'already-won', 'cancelled', 'exhausted']);
});

test('at most one hedge per route, and never more routes than were configured', () => {
  // A property rather than a case: no sequence of ticks can start the same route twice or invent
  // one, however the caller drives it.
  const started = new Set([plan.leader]);
  for (let tickIndex = 0; tickIndex < 20; tickIndex += 1) {
    const decision = policy.nextHedge({ plan, started, settledCount: 0, hasWinner: false, aborted: false });
    if (!decision.hedge) break;
    assert.equal(started.has(decision.candidate), false, 'a route was hedged with twice');
    started.add(decision.candidate);
  }
  assert.equal(started.size, 3, 'the leader plus exactly the two alternatives, and then it stops');
});

test('THE INVARIANT: the policy names no provider', () => {
  const adapters = providerIds();
  const source = readFileSync(new URL('../src/hedge-policy.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const found = adapters.filter((id) => new RegExp("['\"`]" + id + "['\"`]").test(code));
  assert.deepEqual(found, [], `the policy must name no provider, found: ${found.join(', ')}`);
});
