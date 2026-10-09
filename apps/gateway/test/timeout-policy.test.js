import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { TimeoutPolicy, DEFAULT_TIMEOUT_MS, NO_DEADLINE } from '../dist/timeout-policy.js';
import { defaultResilienceSettings, resilienceLimits } from '../dist/connections.js';
import { providerIds } from './support/providerIds.js';

/**
 * `TimeoutPolicy`: what a timeout value means, and the deadline that enforces it.
 *
 * The mechanism is a timer and a race. The policy is that a non-positive timeout means *no
 * deadline at all* — and that is exactly the interpretation whose duplication caused the default to
 * become 0 while the code claimed a provider could never hold a request open.
 */

const policy = new TimeoutPolicy();
const never = () => new Promise(() => { /* deliberately never settles */ });

test('a non-positive timeout means no deadline, and that is asked rather than assumed', () => {
  // Asked, because this is the one interpretation two files used to make independently.
  assert.equal(TimeoutPolicy.enforces(1), true);
  assert.equal(TimeoutPolicy.enforces(DEFAULT_TIMEOUT_MS), true);
  assert.equal(TimeoutPolicy.enforces(NO_DEADLINE), false);
  assert.equal(TimeoutPolicy.enforces(-1), false, 'a negative timeout is not a longer one');
});

test('no deadline means the call is left alone', async () => {
  // A provider that takes eleven minutes still answers, because the operator asked for no deadline.
  const result = await policy.within({ timeoutMs: 0, providerId: 'p' }, async () => 'answered');
  assert.equal(result, 'answered');
});

test('a deadline rejects with a retryable PROVIDER_TIMEOUT naming the limit', async () => {
  // Retryable because it is retryable *elsewhere* — another connection may be quicker. The message
  // names the number that was exceeded, because "timed out" alone tells an operator nothing they
  // cannot already guess.
  await assert.rejects(
    () => policy.within({ timeoutMs: 20, providerId: 'p' }, never),
    (error) => {
      assert.equal(error.code, 'PROVIDER_TIMEOUT');
      assert.equal(error.retryable, true);
      assert.equal(error.providerId, 'p');
      assert.match(error.message, /did not respond within 20 ms/);
      return true;
    },
  );
});

test('a call that answers in time is returned unchanged', async () => {
  assert.equal(await policy.within({ timeoutMs: 5_000, providerId: 'p' }, async () => 'quick'), 'quick');
});

test('the provider is aborted when the deadline passes, not just abandoned', async () => {
  // Otherwise the provider call keeps running: the gateway stops waiting, the upstream keeps
  // billing, and the connection is held open by a call nobody is reading.
  let abortedWith;
  await assert.rejects(() => policy.within({ timeoutMs: 20, providerId: 'p' }, (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { abortedWith = signal.reason; reject(new Error('aborted')); });
  })));
  assert.ok(abortedWith !== undefined, 'the adapter must be told, or the request is only forgotten');
});

test('a caller who cancelled is passed the cancellation, and gets no deadline of its own', async () => {
  // A deadline on an abandoned request is a timer that will fire into nothing.
  const controller = new AbortController();
  controller.abort('user went away');
  let seen;
  await policy.within({ timeoutMs: 20, providerId: 'p', signal: controller.signal }, async (signal) => { seen = signal; return 'still ran'; });
  assert.equal(seen, controller.signal, 'the caller’s own signal is used, so the provider sees the cancellation');
});

test('a cancellation mid-flight reaches the provider', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = policy.within({ timeoutMs: 60_000, providerId: 'p', signal: controller.signal }, (signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve('aborted'));
  }));
  setTimeout(() => controller.abort('gone'), 10);
  assert.equal(await pending, 'aborted');
  assert.ok(Date.now() - started < 5_000, 'and it settled on the cancellation, not on the minute-long deadline');
});

test('the timer does not outlive the call', async () => {
  // A gateway that leaks one timer per request survives its tests and falls over in a day of
  // traffic, so this is asserted by counting the process's handles rather than by inspection.
  const before = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  for (let index = 0; index < 200; index += 1) await policy.within({ timeoutMs: 5_000, providerId: 'p' }, async () => 'quick');
  // And a call that *times out* must not leave its timer either.
  for (let index = 0; index < 20; index += 1) await policy.within({ timeoutMs: 1, providerId: 'p' }, never).catch(() => undefined);
  const after = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  assert.ok(after - before <= 2, `expected the timers to be released, found ${after - before} left over`);
});

// ── the default, and the guarantee it is supposed to uphold ────────────────

test('a connection saved without a timeout gets a real deadline, not none', () => {
  // **This is the assertion that would have caught it.** The default was `0`, and `0` means no
  // deadline, so by default a provider that stopped responding held the request open indefinitely
  // while `withDeadline` and the SPEC both promised the opposite.
  assert.ok(TimeoutPolicy.enforces(defaultResilienceSettings.timeoutMs), 'the default must be a deadline');
  assert.equal(defaultResilienceSettings.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test('no deadline is still available, because an operator may want one', () => {
  // It is inside the allowed range, so asking for it is supported rather than merely tolerated. A
  // model that legitimately thinks for ten minutes is a real case for a local gateway.
  assert.equal(resilienceLimits.timeoutMs.min, NO_DEADLINE);
  assert.ok(resilienceLimits.timeoutMs.max >= DEFAULT_TIMEOUT_MS, 'and the default is inside the range the operator may choose from');
});

test('the timeout error is classified, and its public message is safe to show', async () => {
  // A plain `Error` here would arrive as "every provider route failed" with the reason discarded,
  // because the routing engine reads `code` and nothing else.
  const error = policy.timeoutError(1_000, 'p');
  assert.equal(error.name, 'ProviderError');
  assert.equal(error.code, 'PROVIDER_TIMEOUT');

  // I first asserted `publicMessage === message` and it failed, and the code was right. An API
  // client gets the provider-neutral wording and the dashboard gets the detail separately, so
  // leaving `publicMessage` unset is deliberate: the generic sentence is accurate, and it is the
  // one that should not name a provider's internals to a caller with only a key.
  assert.equal(error.publicMessage, undefined, 'no provider-specific message is forced onto API clients');
  const { publicProviderMessage } = await import('@hilbras/omnihilbras');
  assert.match(publicProviderMessage(error.code), /timed out/i, 'and the generic message still says what happened');
});

test('THE INVARIANT: the policy names no provider', () => {
  const adapters = providerIds();
  const source = readFileSync(new URL('../src/timeout-policy.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const found = adapters.filter((id) => new RegExp("['\"`]" + id + "['\"`]").test(code));
  assert.deepEqual(found, [], `the policy must name no provider, found: ${found.join(', ')}`);
});
