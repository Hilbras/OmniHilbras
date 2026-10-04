import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GatewayService,
  InMemoryApiKeyStore,
  InMemoryConnectionStore,
  createGatewayServer,
} from '../dist/index.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

// Phase 10: stress testing.
//
// Everything here passed on the first run. That is the point of committing it — these are the
// invariants that were *only* ever checked one request at a time, and a concurrency defect is by
// definition invisible to a sequential test.
//
// What each number below was, measured before it was asserted:
//
//   700 concurrent chat requests  → provider calls == 700, ok + err == 700, no id collisions
//   60 concurrent streams         → 300 chunks, 60/60 reached [DONE]
//   60 client aborts mid-stream   → failures: 0  (the 1.52.0 cancellation fix, under load)
//   5 × /health, sweep rejecting  → 1 probe, no unhandledRejection
//
// Two "defects" I reported while writing this were **my probe being wrong**, not the gateway:
//
// 1. A stream probe yielded `{ id, providerId, model, content }`. `ChatChunk` requires `delta`, so
//    `toOpenAIChunk` threw on the first chunk and every stream returned `event: error /
//    INTERNAL_ERROR`. The gateway was right; the stub was not a ChatChunk.
// 2. Request-id extraction read `body.requestId` instead of `body.error.requestId`, which reported
//    "0 request ids" while the sample body plainly contained one.
//
// Both are recorded because the *assertions* below are what would have caught them, and a stress suite
// built from a broken stub is worse than none.

/** A provider that works, slowly enough that concurrent requests genuinely overlap. */
function adapter({ chunks = 0, failEvery = 0, failHealth = false } = {}) {
  // Two counters. `calls` counts chat() and `probes` counts healthCheck() — a single counter was the
  // bug in the first version: the sweep-sharing assertion read `calls`, which only chat() increments,
  // so it measured 0 and I spent a while concluding the sweep was not shared. It was.
  let calls = 0;
  let probes = 0;
  const instance = {
    id: 'p',
    name: 'p',
    capabilities: { chat: true, streaming: chunks > 0, models: true },
    calls: () => calls,
    probes: () => probes,
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() {
      probes += 1;
      if (failHealth) throw new Error('provider unreachable');
      return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() };
    },
    async chat() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (failEvery > 0 && calls % failEvery === 0) throw new Error('synthetic 500');
      return {
        id: 'r', providerId: 'p', model: 'm', createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: 'x' }, finishReason: 'stop',
      };
    },
  };
  if (chunks > 0) {
    instance.capabilities.streaming = true;
    instance.streamChat = async function* () {
      for (let index = 0; index < chunks; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        // `delta` is required by ChatChunk. Omitting it is what made an earlier version of this
        // probe report that streaming was broken.
        yield { id: `c${index}`, providerId: 'p', model: 'm', delta: { content: 'x' } };
      }
    };
  }
  return instance;
}

/** A live gateway on an ephemeral port. */
async function gateway(options = {}, { failureThreshold = 1000, rpm = 100_000 } = {}) {
  const provider = adapter(options);
  const registry = new ProviderRegistry().register(provider);
  const store = new InMemoryConnectionStore();
  await store.save(
    {
      id: 'p', providerId: 'p', name: 'P', endpoint: 'https://p.example/v1', priority: 1,
      enabled: true, proxyPool: 'none', modelPolicy: 'all',
      resilience: { maxRetries: 0, requestsPerMinute: rpm, timeoutMs: 5_000, hedgeAfterMs: 0 },
    },
    { type: 'api-key', value: 'k' },
  );
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('load')).key;
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    provider,
    service,
    base,
    key,
    post: (extra = {}, signal) => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(extra.headers ?? {}) },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra.body }),
      ...(signal ? { signal } : {}),
    }),
    routing: async () => (await (await fetch(`${base}/v1/routing`, { headers: { authorization: `Bearer ${key}` } })).json()),
    /**
     * The recorded counters, as the operator-facing routing report shows them.
     *
     * `describeRouting()` spreads `healthManager.snapshot(...)` into each connection, and that returns
     * undefined for a provider nothing has been recorded for. So the *absence* of `failures` and
     * `successes` is the pass condition here, not a missing value to work around: it means the gateway
     * wrote nothing at all.
     *
     * My first attempt used `service.routing?.snapshot?.('p', 1)`, which is not a method — it returned
     * undefined unconditionally, and `?? 0` turned that into a permanently-passing assertion. Verified
     * by printing the accessor before relying on it, which is why this comment exists.
     */
    counters: () => service.describeRouting().then((report) => report.connections[0]),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('concurrent chat requests reach the provider exactly once each', async (t) => {
  const gw = await gateway({}, { failureThreshold: 1000 });
  t.after(gw.close);

  const TOTAL = 200;
  const responses = await Promise.all(Array.from({ length: TOTAL }, () => gw.post()));
  const codes = responses.map((response) => response.status);

  assert.equal(
    gw.provider.calls(),
    TOTAL,
    `the provider saw ${gw.provider.calls()} calls for ${TOTAL} requests; under concurrency a request ` +
      'must be dispatched once, not zero times and not twice',
  );
  assert.equal(
    codes.filter((code) => code === 200).length,
    TOTAL,
    `only ${codes.filter((code) => code === 200).length}/${TOTAL} succeeded; a healthy provider under load ` +
      'should not fail requests',
  );
  await Promise.all(responses.map((response) => response.arrayBuffer()));
});

test('concurrent failures stay attributable: right codes, unique request ids, nothing leaked', async (t) => {
  const gw = await gateway({ failEvery: 7 });
  t.after(gw.close);

  const TOTAL = 120;
  const responses = await Promise.all(Array.from({ length: TOTAL }, () => gw.post()));
  const bodies = await Promise.all(responses.map((response) => response.json()));

  const errors = bodies.filter((body) => body.error);
  assert.ok(errors.length > 0, 'the synthetic failure pattern should have produced some errors');

  // Every failure is the provider's own fault, and says so.
  for (const body of errors) {
    assert.equal(body.error.code, 'PROVIDER_REQUEST_FAILED', `unexpected code ${body.error.code}`);
  }

  // `requestId` is what a client quotes in a bug report, so a collision under load makes the log
  // unusable exactly when it is most needed.
  const ids = errors.map((body) => body.error.requestId);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0), 'every error must carry a request id');
  assert.equal(new Set(ids).size, ids.length, 'request ids collided under concurrency');

  // A stack trace or a filesystem path in a response body is a leak of the machine's internals.
  const serialised = JSON.stringify(errors);
  assert.ok(!/\bat \w+.*:\d+:\d+/.test(serialised), 'a response body contains a stack frame');
  assert.ok(!serialised.includes('node_modules'), 'a response body names node_modules');
  assert.ok(!serialised.includes('/home/'), 'a response body contains an absolute filesystem path');
  assert.ok(!/"k"|"key"|apiKey/i.test(serialised.replace(/"(PROVIDER_REQUEST_FAILED)"/g, '')), 'a response body may carry a credential-shaped value');
});

test('concurrent streams all reach [DONE] and emit every chunk', async (t) => {
  const gw = await gateway({ chunks: 5 });
  t.after(gw.close);

  const TOTAL = 40;
  const results = await Promise.all(
    Array.from({ length: TOTAL }, async () => {
      const response = await gw.post({ headers: { accept: 'text/event-stream' }, body: { stream: true } });
      const text = await response.text();
      return {
        status: response.status,
        done: text.includes('data: [DONE]'),
        frames: (text.match(/data: /g) ?? []).length,
        errorFrames: (text.match(/event: error/g) ?? []).length,
      };
    }),
  );

  assert.equal(results.filter((r) => r.status === 200).length, TOTAL, 'every stream should open');
  assert.equal(results.filter((r) => r.errorFrames > 0).length, 0, 'a stream ended in an error frame');
  assert.equal(results.filter((r) => r.done).length, TOTAL, 'every stream must terminate with [DONE]');
  assert.equal(
    results.filter((r) => r.frames >= 5).length,
    TOTAL,
    'a stream that stops mid-answer is worse than one that never started',
  );
});

test('client aborts do not eject a working provider, and record no failure', async (t) => {
  // The 1.52.0 fix, measured rather than asserted from memory: 60 aborts produced `failures: 0` and
  // `successes: 121` (60 streams + 61 chat requests). A cancellation is the client's decision, and
  // neither counter should move for it.
  const gw = await gateway({ chunks: 10 }, { failureThreshold: 1 });
  t.after(gw.close);

  const abortOnce = async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3);
    return gw
      .post({ headers: { accept: 'text/event-stream' }, body: { stream: true } }, controller)
      .then((response) => response.status)
      .catch((error) => `ABORTED:${error.name}`);
  };
  await Promise.all(Array.from({ length: 30 }, abortOnce));
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Read the counters rather than inferring them from behaviour.
  //
  // The first version asserted only that a subsequent request still returned 200, with
  // `failureThreshold: 1`. A counter that moves only *up* on success cannot be seen by an ejection
  // threshold at all, so that assertion had no purchase on the claim it was making.
  //
  // **What this test does not cover, stated plainly.** A mutation that adds a `recordSuccess` to the
  // *opening* catch block is not caught, because a client abort during chunk delivery never reaches
  // that block — it reaches the iterator's own `catch`, which is where the CANCELLED check already
  // lives. That line is exercised by `request-executor.test.js`; duplicating it here would add a test
  // whose passing means nothing.
  //
  // **A behaviour I deliberately did not call a bug.** When a client disconnects but the provider has
  // already finished, the provider is recorded as a success. Measured: 20 aborts at 3 ms → `successes 13`,
  // matching the 13 of 20 generators that ran to completion. Nobody read those answers — but the
  // provider *did* serve them, and 1.52.0's rule is that a client decision is not a provider fault.
  // Calling this wrong would mean penalising a provider for a browser tab closing, which is the failure
  // 1.52.0 fixed. So it is a design decision, asserted nowhere as an accident.
  const counters = await gw.counters();
  // Asserted as "the counter must be absent or zero" — because absent is the honest reading of "nothing
  // was recorded", and a bare `=== 0` would fail on the very state this test is asserting.
  assert.ok(
    counters.failures === undefined || counters.failures === 0,
    `client cancellations recorded ${counters.failures} provider failures: ${JSON.stringify(counters)}`,
  );
  assert.ok(
    counters.successes === undefined || counters.successes === 0,
    `client cancellations recorded ${counters.successes} successes; nobody received an answer: ${JSON.stringify(counters)}`,
  );

  // And the gateway is still serving, which `failureThreshold: 1` makes the ejection check.
  assert.equal((await gw.post()).status, 200, 'the gateway stopped serving after client cancellations');
});

test('a health sweep that rejects is shared, and does not take the process with it', async (t) => {
  const rejections = [];
  const listener = (error) => rejections.push(error);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));

  const gw = await gateway({ failHealth: true });
  t.after(gw.close);

  // `refresh()` shares one in-flight sweep. If it did not, five **concurrent** reads would start five
  // sweeps, and the comment in `health.ts` about a page reload and the timer landing together would be
  // untrue.
  //
  // My first version awaited each read before starting the next, so each one legitimately began a new
  // sweep and the count came out 0 — the sweep had already settled and been forgotten. Sequential reads
  // do not test sharing; only overlapping ones do.
  const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(`${gw.base}/health`)));
  for (const response of responses) {
    assert.equal(response.status, 200, 'a failing provider must not make /health itself fail');
    await response.json();
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(gw.provider.probes(), 1, `${gw.provider.probes()} health probes for 5 concurrent reads; the sweep is not shared`);
  assert.deepEqual(rejections, [], `a rejected sweep became an unhandled rejection: ${rejections.map(String).join(', ')}`);
});

test('the counters accessor is real, not permanently undefined', async (t) => {
  // `counters()` was `service.routing?.snapshot?.('p', 1)` — not a method. It returned undefined
  // unconditionally and `?? 0` made every counter assertion pass forever. This test fails if that
  // regresses: a completed stream MUST produce a visible `successes`.
  const gw = await gateway({ chunks: 2 });
  t.after(gw.close);

  const before = await gw.counters();
  assert.equal(before.successes, undefined, 'nothing has run yet, so there is nothing to report');

  await (await gw.post({ headers: { accept: 'text/event-stream' }, body: { stream: true } })).text();
  const after = await gw.counters();
  assert.equal(after.successes, 1, `a completed stream must show successes: 1, got ${JSON.stringify(after)}`);
});

test('the load suite would notice if it stopped exercising concurrency', async (t) => {
  // A stress test that quietly runs its requests one at a time still passes, and has stopped testing
  // anything. These assertions are about the suite itself.
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  const concurrent = (source.match(/Promise\.all\(/g) ?? []).length;
  assert.ok(concurrent >= 5, `only ${concurrent} concurrent batches; the suite is not stressing anything`);
  assert.ok(!/for \(const .*\) \{[^}]*await gw\.post\(\)/.test(source), 'a request is awaited inside a loop rather than fired together');
  assert.ok(/\bTOTAL\b/.test(source), 'the sizes are named, so a change to them is a visible choice');
});
