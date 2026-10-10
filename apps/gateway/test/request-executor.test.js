import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { RequestExecutor } from '../dist/request-executor.js';
import { ProviderError } from '@hilbras/omnihilbras';
import { providerIds } from './support/providerIds.js';

/**
 * `RequestExecutor` — the loop, tested without a gateway.
 *
 * The end-to-end suite in `service.test.js` already drives hedging, failover, rate-limit handoff
 * and stream failover through the whole service, and that is what proves the extraction changed no
 * behaviour. These tests cover the claims that only a unit can check: the ledger's honesty about
 * attempts the client never saw, and the shape of the wiring.
 */

const resilience = (over = {}) => ({ maxRetries: 0, timeoutMs: 30_000, requestsPerMinute: 60, hedgeAfterMs: 0, ...over });

const candidate = (providerId, over = {}) => ({ providerId, connectionId: `c-${providerId}`, priority: 0, resilience: resilience(over) });

const request = (model = 'test-model') => ({ model, messages: [{ role: 'user', content: 'hi' }] });

const response = (text) => ({ message: { role: 'assistant', content: text } });

/** A candidate plan plus a recording of every effect the loop performed. */
function harness({ candidates, chat, streamChat } = {}) {
  const calls = { success: [], failure: [], rateLimited: [], enforced: [] };
  const plan = candidates ?? [candidate('first')];
  const executor = new RequestExecutor({
    planRoute: async () => ({ candidates: plan, skipped: [] }),
    chat: chat ?? (async (providerId) => response(providerId)),
    streamChat: streamChat ?? (async function* () { yield { delta: 'x' }; }),
    withDeadline: async (_signal, _timeoutMs, _providerId, run) => run(undefined),
    enforceRateLimit: (c) => calls.enforced.push(c.providerId),
    recordSuccess: (providerId, latencyMs) => calls.success.push(providerId),
    recordFailure: (providerId, code) => calls.failure.push({ providerId, code }),
    recordRateLimitUse: (connectionId) => calls.rateLimited.push(connectionId),
  });
  return { executor, calls };
}

test('the first route that answers wins, and nothing after it is asked', async () => {
  const { executor, calls } = harness({ candidates: [candidate('a'), candidate('b')] });
  const outcome = await executor.chat(request(), undefined);
  assert.equal(outcome.response.message.content, 'a');
  assert.deepEqual(outcome.attempts.map((attempt) => attempt.providerId), ['a']);
  assert.deepEqual(calls.rateLimited, ['c-a'], 'only the route that sent a request is credited');
});

test('a failing route hands off to the next, and both appear in the ledger', async () => {
  const { executor } = harness({
    candidates: [candidate('a'), candidate('b')],
    chat: async (providerId) => {
      if (providerId === 'a') throw new ProviderError('PROVIDER_UNAVAILABLE', 'a is down.', { retryable: true });
      return response('b answered');
    },
  });
  const outcome = await executor.chat(request(), undefined);
  assert.equal(outcome.response.message.content, 'b answered');
  // `connectionId` was added in 1.60.0 so a usage record can attribute per connection rather than per
  // provider. It was already in scope at every push site, so it is existing state surfacing, not new plumbing.
  assert.deepEqual(outcome.attempts, [
    { providerId: 'a', connectionId: outcome.attempts[0].connectionId, attempt: 1, ok: false, latencyMs: outcome.attempts[0].latencyMs, errorCode: 'PROVIDER_UNAVAILABLE' },
    { providerId: 'b', connectionId: outcome.attempts[1].connectionId, attempt: 1, ok: true, latencyMs: outcome.attempts[1].latencyMs },
  ]);
  assert.ok(outcome.attempts[0].connectionId, 'every attempt must name the connection it was served by');
});

test('a terminal failure stops the chain rather than trying routes that cannot help', async () => {
  // A 400 is this provider's answer and will be every provider's answer. Trying the rest turns one
  // clear refusal into N slow ones, and N upstream requests billed for a request that was never
  // going to work.
  const asked = [];
  const { executor } = harness({
    candidates: [candidate('a'), candidate('b'), candidate('c')],
    chat: async (providerId) => {
      asked.push(providerId);
      throw new ProviderError('INVALID_REQUEST', 'The model does not accept this.');
    },
  });
  await assert.rejects(() => executor.chat(request(), undefined), (error) => error.code === 'INVALID_REQUEST');
  assert.deepEqual(asked, ['a'], 'only the first route should have been asked');
});

test('a retryable failure is retried, and the attempt number counts up', async () => {
  let tries = 0;
  const { executor } = harness({
    candidates: [candidate('a', { maxRetries: 2 })],
    chat: async () => {
      tries += 1;
      if (tries < 3) throw new ProviderError('PROVIDER_UNAVAILABLE', 'try again', { retryable: true });
      return response('third time');
    },
  });
  const outcome = await executor.chat(request(), undefined);
  assert.equal(outcome.response.message.content, 'third time');
  assert.deepEqual(outcome.attempts.map((attempt) => attempt.attempt), [1, 2, 3]);
});

test('a truncated or corrupted answer is retried on the same connection, and the complete retry is returned', async () => {
  // A Kiro stream cut short or with a bad checksum is refused as INVALID_RESPONSE, which is a
  // property of that one answer, not of the account, so the next try on the same route is worth it.
  let tries = 0;
  const { executor, calls } = harness({
    candidates: [candidate('a', { maxRetries: 1 })],
    chat: async () => {
      tries += 1;
      if (tries === 1) throw new ProviderError('INVALID_RESPONSE', 'truncated event stream', { retryable: true });
      return response('whole answer');
    },
  });
  const outcome = await executor.chat(request(), undefined);
  assert.equal(outcome.response.message.content, 'whole answer');
  assert.equal(tries, 2);
  assert.deepEqual(outcome.attempts.map((attempt) => attempt.attempt), [1, 2]);
  assert.deepEqual(calls.failure, [{ providerId: 'a', code: 'INVALID_RESPONSE' }]);
});

test('a rate limit hands off instead of retrying the same connection', async () => {
  // Retrying a connection that is at its limit is guaranteed to fail and costs another wait; the
  // whole point of a per-connection limit is that the *next* connection can serve the request.
  const asked = [];
  const { executor } = harness({
    candidates: [candidate('a'), candidate('b')],
    chat: async (providerId) => {
      asked.push(providerId);
      if (providerId === 'a') throw new ProviderError('RATE_LIMITED', 'This connection reached its limit of 60 requests per minute.', { retryable: true });
      return response('b answered');
    },
  });
  const outcome = await executor.chat(request(), undefined);
  assert.equal(outcome.response.message.content, 'b answered');
  assert.deepEqual(asked, ['a', 'b']);
  assert.equal(outcome.attempts.filter((attempt) => attempt.providerId === 'a').length, 1, 'the limited route is tried once');
});

test('when every route fails the client gets one error naming every route that was tried', async () => {
  const { executor } = harness({
    candidates: [candidate('a'), candidate('b')],
    chat: async () => { throw new ProviderError('PROVIDER_TIMEOUT', 'no answer in 30s.', { retryable: true }); },
  });
  await assert.rejects(
    () => executor.chat(request(), undefined),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.match(error.message, /Tried: a, b/);
      return true;
    },
  );
});

test('a failure we cannot attribute to a provider stops the chain, and says so honestly', async () => {
  // A bare `Error` is a gateway-side fault, not a provider's: no provider code, no retryable flag,
  // so there is nothing to attribute it to. Two things follow, and both are deliberate — the chain
  // stops rather than spending an upstream request on a gateway bug, and the final code is
  // `PROVIDER_REQUEST_FAILED` rather than `PROVIDER_UNAVAILABLE`, which would blame a provider we
  // have no evidence against.
  const asked = [];
  const { executor } = harness({
    candidates: [candidate('a'), candidate('b')],
    chat: async (providerId) => { asked.push(providerId); throw new Error('socket hang up'); },
  });
  await assert.rejects(
    () => executor.chat(request(), undefined),
    (error) => {
      assert.equal(error.code, 'PROVIDER_REQUEST_FAILED');
      assert.match(error.message, /Tried: a\./, 'and it names the one route it actually reached');
      return true;
    },
  );
  assert.deepEqual(asked, ['a'], 'a gateway-side fault must not fan out across every route');
});

test('no route at all is refused, with the reason each was skipped', async () => {
  const { executor } = harness({ candidates: [] });
  await assert.rejects(
    () => executor.chat(request(), undefined),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.match(error.publicMessage ?? '', /No enabled provider connection can serve this model/);
      return true;
    },
  );
});

test('a cancelled request is refused before any provider is asked', async () => {
  const asked = [];
  const controller = new AbortController();
  controller.abort('user went away');
  const { executor } = harness({ chat: async (providerId) => { asked.push(providerId); return response('never'); } });
  await assert.rejects(() => executor.chat(request(), undefined, controller.signal), (error) => error.code === 'CANCELLED');
  assert.deepEqual(asked, [], 'no request should reach a provider after cancellation');
});

test('an abandoned hedge is recorded, not quietly dropped', async () => {
  // This is the claim the ledger makes to the client: `attempts` is what it was actually charged
  // for. A hedge that fires, loses, and is aborted was still sent and still cost money, so
  // omitting it would make the ledger a smaller bill than the invoice.
  //
  // Written to be deterministic rather than merely fast: the leader never settles on its own, so
  // the hedge timer is *guaranteed* to fire while the leader is in flight, and the test waits for
  // the hedge to actually be asked. The obvious version of this test — a leader that resolves on a
  // timer and a hedgeAfterMs of 1 — passes only while the machine is idle, and a test that fails
  // in CI for no reason is worse than no test.
  let releaseLeader;
  const leaderInFlight = new Promise((resolve) => { releaseLeader = resolve; });
  const asked = [];
  const { executor } = harness({
    candidates: [candidate('leader', { hedgeAfterMs: 1 }), candidate('hedge')],
    chat: (providerId) => {
      asked.push(providerId);
      if (providerId === 'leader') return leaderInFlight;
      return Promise.resolve(response('hedge answered'));
    },
  });
  const outcome = executor.chat(request(), undefined);
  // Wait for the hedge to be sent. Bounded so a real regression fails rather than hangs.
  for (let waited = 0; waited < 2_000 && !asked.includes('hedge'); waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(asked, ['leader', 'hedge'], 'the hedge is only sent while the leader is still in flight');

  const settled = await outcome;
  releaseLeader(response('leader answered, too late'));
  assert.equal(settled.response.message.content, 'hedge answered');

  const hedge = settled.attempts.find((attempt) => attempt.providerId === 'hedge');
  assert.ok(hedge, 'the hedge attempt must be in the ledger');
  assert.equal(hedge.ok, true, 'the hedge won, so it is the answer');
  const leader = settled.attempts.find((attempt) => attempt.providerId === 'leader');
  assert.ok(leader, 'the losing leader must also be in the ledger, so the client can see it was paid for');
  assert.equal(leader.ok, false);
  assert.equal(leader.errorCode, 'CANCELLED');
});

test('a single route is never hedged, so one connection never pays twice', async () => {
  let calls = 0;
  const { executor } = harness({
    candidates: [candidate('only', { hedgeAfterMs: 1 })],
    chat: async () => { calls += 1; return response('one answer'); },
  });
  const outcome = await executor.chat(request(), undefined);
  assert.equal(calls, 1);
  assert.equal(outcome.attempts.length, 1);
});

test('a stream fails over only before the first chunk', async () => {
  // Once bytes are on the wire the client has a partial answer, and a second provider would
  // produce a second, different partial answer interleaved with the first.
  const asked = [];
  const { executor } = harness({
    candidates: [candidate('a'), candidate('b')],
    streamChat: (providerId) => {
      asked.push(providerId);
      return (async function* () {
        if (providerId === 'a') throw new ProviderError('PROVIDER_UNAVAILABLE', 'a is down.', { retryable: true });
        yield { delta: 'from b' };
      })();
    },
  });
  const outcome = await executor.stream(request(), undefined);
  const chunks = [];
  for await (const chunk of outcome.chunks) chunks.push(chunk);
  assert.deepEqual(asked, ['a', 'b'], 'the second route was only reached because nothing had been sent');
  assert.deepEqual(chunks, [{ delta: 'from b' }]);
});

test('a stream that ends before producing a chunk fails over rather than yielding nothing', async () => {
  const { executor } = harness({
    candidates: [candidate('a'), candidate('b')],
    streamChat: (providerId) => (async function* () {
      if (providerId === 'a') return;
      yield { delta: 'from b' };
    })(),
  });
  const outcome = await executor.stream(request(), undefined);
  const chunks = [];
  for await (const chunk of outcome.chunks) chunks.push(chunk);
  assert.deepEqual(chunks, [{ delta: 'from b' }]);
  assert.equal(outcome.attempts[0].ok, false);
  assert.equal(outcome.attempts[0].errorCode, 'INVALID_RESPONSE');
});

test('a stream that dies mid-answer is a FAILURE for the health counter', async () => {
  // **This test asserted the opposite for one release.** It was titled "still counts as a success", its
  // comment said "This documents the choice the `finally` block makes", and it passed — so a provider
  // that emitted one chunk and then died was recorded healthy, and routing kept selecting it.
  //
  // The reasoning it recorded was half right and the conclusion was wrong:
  //
  // > recording success on the first chunk would have been wrong in the other direction
  //
  // True, and irrelevant: the choice was never *first chunk* or *finally*, it was **success on every
  // exit**, because `recordSuccess` sat in a `finally`. The three real states are:
  //
  // - completed → success  ← the `done` path
  // - threw after chunks → **failure**  ← was recorded as success
  // - cancelled by the client → neither; the user decided, not the provider
  //
  // Corrected in 1.52.0. `tests/execution-correctness.test.js` covers the same ground end to end through
  // a real gateway; this one stays because it pins the decision at the executor's own boundary.
  const { executor, calls } = harness({
    candidates: [candidate('a')],
    streamChat: () => (async function* () {
      yield { delta: 'partial' };
      throw new Error('connection reset');
    })(),
  });
  const outcome = await executor.stream(request(), undefined);
  assert.deepEqual(calls.success, [], 'success is recorded as the stream finishes, not as it opens');
  await assert.rejects(async () => { for await (const _chunk of outcome.chunks) { /* drain */ } });

  assert.deepEqual(calls.success, [], 'a stream that died mid-answer must NOT be recorded as a success');
  assert.deepEqual(
    calls.failure.map((entry) => entry.code),
    ['PROVIDER_REQUEST_FAILED'],
    'and it must be recorded as the failure it is, so routing stops choosing this provider',
  );
});

test('a stream the client cancels is neither a success nor a provider failure', async () => {
  // The third state, which the previous version had no way to express. A user closing the tab is not the
  // provider's fault, and counting it as one would let any client poison a provider's health — the same
  // class of defect as recording the failure as a success, pointed the other way.
  const controller = new AbortController();
  const { executor, calls } = harness({
    candidates: [candidate('a')],
    streamChat: () => (async function* () {
      yield { delta: 'partial' };
      // A real transport surfaces an abort as a throw; the shape is the same as a failure here, so what
      // separates them is the signal, not the error.
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw Object.assign(new Error('The request was cancelled.'), { code: 'CANCELLED' });
    })(),
  });
  const outcome = await executor.stream(request(), undefined, controller.signal);
  // Actually abort, mid-stream — a controller that is created and never aborted leaves
  // `signal.aborted === false`, so the executor cannot tell this from a provider failure and the test
  // measures nothing. The first chunk arrives, then the client goes away.
  controller.abort();
  await assert.rejects(async () => { for await (const _chunk of outcome.chunks) { /* drain */ } });

  assert.deepEqual(calls.success, [], 'a cancelled stream is not a success');
  // Whether a cancellation counts against the provider is a *policy* decision, recorded rather than
  // assumed — but it must not be silently counted as a success, which is what the finally block did.
  assert.ok(
    calls.failure.every((entry) => entry.code !== 'PROVIDER_REQUEST_FAILED'),
    'a cancellation must not be filed as a provider failure',
  );
});

test('THE INVARIANT: the executor names no provider', () => {
  // Checked against the SDK's actual adapter ids rather than "any hyphenated string".
  //
  // My first version matched a pattern for any hyphenated word, which passed only because no such
  // word happened to appear in the file — the moment RetryPolicy introduced 'next-route' it failed,
  // on a name that is not a provider. A guard that can be silenced by a naming choice is a weak
  // guard, and worse, it trains you to reach for an allowlist instead of fixing the code.
  //
  // Reading the adapter directory makes it self-maintaining: a new provider cannot be added without
  // this noticing, and nothing else in the file can trip it.
  const adapters = providerIds();
  const source = readFileSync(new URL('../src/request-executor.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const found = adapters.filter((id) => new RegExp("['\"\`]" + id + "['\"\`]").test(code));
  assert.deepEqual(found, [], `the request-executor must name no provider, found: ${found.join(', ')}`);
});
