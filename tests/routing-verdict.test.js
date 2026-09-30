import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { routingVerdict, eligibleCount } from '../src/lib/routingVerdict.ts';

/**
 * The Routing page's eligibility rule must be the gateway's rule.
 *
 * ## The defect, measured
 *
 * The page decided "can routing use this?" by hand, from four fields, in a `.tsx`. `resolveRoute`
 * decides it from `enabled && hasCredential`, then `isUnhealthy(providerId, threshold)`, then the
 * recorded rate-limit wait. The two copies disagreed in both directions:
 *
 * | Connection | `resolveRoute` | the page said |
 * | --- | --- | --- |
 * | 1 failure, `lastError` set, threshold 3 | **candidate** | "last attempt failed" |
 * | over its rate limit | skipped, `rate-limited` | **"eligible — routing can choose this"** |
 *
 * The second row was worse than a wrong label. `rateLimitWaitMs` was not in the `/v1/routing`
 * payload at all: `RoutingEngine.waits()` existed for the stated purpose of letting the dashboard see
 * a cooling-down connection, and nothing outside `routing-engine.test.js` called it. The promise was
 * in a comment; the value never left the object.
 *
 * The fix has two halves and this file guards the dashboard half; `apps/gateway/test/routing.test.js`
 * guards the payload half. Either half alone leaves the disagreement in place — the page would
 * compute against a field nobody sends.
 *
 * ## Why these cases and not a list of fields
 *
 * A per-field check ("this field must not be read") is how the earlier `provider-cards` check came to
 * misfile health and defend the wrong side. These are *state properties*: for every input, the
 * verdict must agree with `resolveRoute` on the same record. That is the property; the four rules are
 * an implementation detail of it and are free to move.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const resilience = { maxRetries: 0, timeoutMs: 30_000, requestsPerMinute: 60, hedgeAfterMs: 0 };

const connection = (over = {}) => ({
  connectionId: 'c1',
  providerId: 'p',
  enabled: true,
  hasCredential: true,
  resilience,
  ...over,
});

test('a connection routing would consider is eligible', () => {
  assert.deepEqual(routingVerdict(connection(), 3), { eligible: true });
});

test('a single failure below the threshold is a live route, not a blocked one', () => {
  // This is the case the old rule got wrong, and it is the one an operator meets constantly: one
  // timeout, threshold 3, so the gateway is deliberately tolerating a blip and will route to this
  // connection on the very next request. The page called it "last attempt failed" and counted it out
  // of "Eligible", so the summary could read 0 while a working route sat right there.
  const verdict = routingVerdict(connection({ failures: 1, lastError: 'PROVIDER_TIMEOUT: upstream timed out' }), 3);
  assert.deepEqual(verdict, { eligible: true }, 'the record of a past failure is context, not a verdict');
});

test('ejection blocks, and says the threshold that caused it', () => {
  const verdict = routingVerdict(connection({ ejected: true, failures: 3, lastError: 'PROVIDER_UNAVAILABLE: down' }), 3);
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /ejected after 3 consecutive failures \(threshold 3\)/);
});

test('a connection waiting on its rate limit is not eligible, and says how long', () => {
  // The half that could not be fixed in the page alone. The gateway has to send this field, because
  // the wait lives in `RateLimitPolicy` behind `RoutingEngine.waits()`.
  const verdict = routingVerdict(connection({ rateLimitWaitMs: 30_000 }), 3);
  assert.equal(verdict.eligible, false);
  assert.match(verdict.reason, /rate limit — retry in 30 s/);
});

test('a wait of zero is a checked connection that is free, not an unknown one', () => {
  // `RateLimitPolicy` records `0` deliberately so *never checked* and *not waiting* stay different
  // answers. `?? 0` in the rule makes both eligible — correct — but the field must not be treated as
  // absent, so this asserts the zero does not read as a wait.
  assert.deepEqual(routingVerdict(connection({ rateLimitWaitMs: 0 }), 3), { eligible: true });
});

test('disabled and credential-less connections are named before any health rule', () => {
  // The ordering is the gateway's: eligibility filters, then health, then the wait. A paused
  // connection is not waiting on a limit; it is not being asked.
  assert.match(routingVerdict(connection({ enabled: false, rateLimitWaitMs: 5_000 }), 3).reason, /paused/);
  assert.match(routingVerdict(connection({ hasCredential: false, ejected: true }), 3).reason, /no credential saved/);
});

test('the eligible count is the same rule as the cards, so the summary cannot disagree with them', () => {
  // The two were derived separately before: an inline `.filter(...)` above the cards, and the rules
  // inside each card. Two copies of one decision, with the disagreement invisible until a stale
  // `lastError` picked a winner.
  const connections = [
    connection({ connectionId: 'ok' }),
    connection({ connectionId: 'blip', failures: 1, lastError: 'PROVIDER_TIMEOUT: x' }),
    connection({ connectionId: 'ejected', ejected: true, failures: 3 }),
    connection({ connectionId: 'limited', rateLimitWaitMs: 5_000 }),
    connection({ connectionId: 'off', enabled: false }),
  ];
  assert.equal(eligibleCount(connections, 3), 2);
  assert.equal(
    connections.filter((c) => routingVerdict(c, 3).eligible).length,
    eligibleCount(connections, 3),
    'the count is the cards, not a second opinion',
  );
});

test('the rule lives in lib, and the page calls it rather than repeating it', () => {
  // The extraction is the fix. A second inline `if (!connection.enabled)` chain in the page would be
  // the same defect one layer down, and this is the check that says so.
  const page = readFileSync(join(ROOT, 'src/pages/RoutingPage.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(page, /routingVerdict\(/, 'the page imports the shared verdict');
  assert.match(page, /eligibleCount\(/, 'and counts with it, rather than filtering inline');
  assert.doesNotMatch(page, /if \(!connection\.enabled\)/, 'no hand-written eligibility rule survives in the page');
  assert.doesNotMatch(page, /if \(connection\.lastError\)/, 'and a stale error is not a rule');
});

test('the payload the page decides on actually carries the wait', () => {
  // The other half, asserted from the dashboard side: if the gateway stops sending
  // `rateLimitWaitMs`, the rate-limit rule above silently becomes dead code and the page goes back to
  // calling a limited connection eligible. A test that only exercises `routingVerdict` cannot see it.
  const client = readFileSync(join(ROOT, 'src/lib/gatewayClient.ts'), 'utf8');
  assert.match(client, /rateLimitWaitMs\?: number/, 'the routing state type declares the wait');
});