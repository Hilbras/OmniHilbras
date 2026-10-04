import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';
import { RequestExecutor } from '../dist/request-executor.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

/**
 * Two execution-correctness defects, both found by measurement and both proven here first.
 *
 * ## 1. A hedge consumes a rate-limit slot but is never checked against the limit
 *
 * `tryHedgedRace` calls `recordRateLimitUse` and never calls `enforceRateLimit`. The sequential path in
 * `chat()` calls both, in that order:
 *
 * ```ts
 * this.deps.enforceRateLimit(candidate);        // ← refuses when the connection is at its cap
 * this.deps.recordRateLimitUse(candidate.connectionId);
 * ```
 *
 * So a connection at its RPM ceiling still accepts hedges, without bound. The hedge spends the budget it
 * is not counting, which is the opposite of what the comment above the call says.
 *
 * ## 2. A stream that dies after its first chunk is recorded as a SUCCESS
 *
 * ```ts
 * } finally {
 *   // Recorded on the way out, not on the way in: a stream that opened and then died is a
 *   // failure the client already knows about, and a health counter that cannot see it
 *   // would keep sending traffic to a provider that is failing mid-answer.
 *   executor.deps.recordSuccess(candidate.providerId, ...);
 * }
 * ```
 *
 * The comment describes the correct behaviour. The code does the opposite: `recordSuccess` is in a
 * `finally`, so it runs on completion **and** on throw **and** on cancellation. A provider that emits one
 * chunk and then errors is recorded healthy, and routing keeps choosing it.
 *
 * Both fixtures are loopback-only: no provider, no credential, no cost.
 */


/**
 * The source of one method, by brace matching.
 *
 * A character count is not a boundary. Slicing 8000 characters from `tryHedgedRace` ran past its end
 * and into `stream()`, whose `enforceRateLimit` made the Phase 1 assertion pass **for the wrong reason** —
 * the precise failure this file exists to catch, reproduced in the test that catches it.
 */
function methodBody(source, start) {
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}

/** An adapter whose behaviour is scripted per provider, so a race can be won on demand. */
function scripted(id, behaviour) {
  return {
    id,
    name: id,
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: `${id}-model`, providerId: id }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat(request) {
      behaviour.calls.push({ provider: id, at: Date.now() });
      return behaviour.chat(request);
    },
    async *streamChat() {
      behaviour.calls.push({ provider: id, stream: true, at: Date.now() });
      yield* behaviour.stream();
    },
  };
}

async function serve(t, adapters, connections, options = {}) {
  const registry = new ProviderRegistry();
  for (const adapter of adapters) registry.register(adapter);
  const store = new InMemoryConnectionStore();
  for (const connection of connections) await store.save(connection.input, { type: 'api-key', value: 'k' });
  // Since 1.46.0 the LLM surface is behind the key gate, so the test has to hold one — obtained the
  // only way a test legitimately can: from the store, not over HTTP (that route is gated too).
  const apiKeys = new InMemoryApiKeyStore();
  const gatewayKey = (await apiKeys.create('execution-correctness')).key;
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, options);
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, service, auth: { authorization: `Bearer ${gatewayKey}` } };
}

const RESILIENCE = { maxRetries: 0, requestsPerMinute: 1, timeoutMs: 5_000, hedgeAfterMs: 10 };

// ---------------------------------------------------------------- Phase 1
test('a hedge is refused when the connection is already at its rate limit', async (t) => {
  // requestsPerMinute: 1, so the second dispatch in the same window must be refused. The leader is
  // the first candidate; the hedge is the second. Before the fix the hedge dispatched anyway.
  const calls = [];
  const slow = scripted('slow', {
    calls,
    chat: async () => new Promise((resolve) => setTimeout(() => resolve({
      id: 'r', providerId: 'slow', model: 'm', createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: 'slow' }, finishReason: 'stop',
    }), 400)),
    async *stream() { yield { id: 'c', providerId: 'slow', model: 'm', content: 'x' }; },
  });
  const fast = scripted('fast', {
    calls,
    chat: async () => ({ id: 'r', providerId: 'fast', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'fast' }, finishReason: 'stop' }),
    async *stream() { yield { id: 'c', providerId: 'fast', model: 'm', content: 'x' }; },
  });

  const { base, auth } = await serve(t, [slow, fast], [
    { input: { id: 'slow', providerId: 'slow', name: 'Slow', endpoint: 'https://slow.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: RESILIENCE } },
    { input: { id: 'fast', providerId: 'fast', name: 'Fast', endpoint: 'https://fast.example/v1', priority: 2, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: RESILIENCE } },
  ], { failureThreshold: 3 });

  const post = () => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });

  // Two calls is *correct* here: `slow` and `fast` are separate connections with separate budgets, and
  // each is making its first request. The defect is not "a hedge always dispatches" — it is that a hedge
  // never consults **the same connection's** budget. So this must exhaust one connection first and then
  // ask for a second request through it.
  await post();                       // spends `slow`'s single slot (and `fast`'s, as its hedge)
  calls.length = 0;
  await post();                       // now both connections are at their cap of 1
  const hedged = calls.filter((call) => !call.stream);
  console.error('DEBUG calls:', JSON.stringify(hedged.map((c) => c.provider)));
  assert.ok(
    hedged.length === 0,
    `${hedged.length} provider calls were dispatched after both connections were already at their RPM cap of 1 — ` +
      'a hedge must pass the same enforcement as the request that preceded it',
  );
});

test('every provider attempt passes through enforcement, in the hedge path too', async (t) => {
  // The structural statement, so the invariant is checked rather than one configuration of it.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/request-executor.ts'), 'utf8');

  const hedgeStart = source.indexOf('private async tryHedgedRace');
  assert.ok(hedgeStart > 0, 'tryHedgedRace must exist — this file is about it');
  const hedgeBody = methodBody(source, hedgeStart);

  const enforcement = (hedgeBody.match(/enforceRateLimit\(/g) ?? []).length;
  const accounting = (hedgeBody.match(/recordRateLimitUse\(/g) ?? []).length;

  assert.ok(accounting > 0, 'the hedge must still account for the request it sends');
  assert.ok(
    enforcement > 0,
    'the hedge path records a rate-limit use without enforcing the limit, so a connection at its cap ' +
      'accepts hedges without bound',
  );
});

// ---------------------------------------------------------------- Phase 2
test('a stream that throws after its first chunk is recorded as a failure, not a success', async (t) => {
  // Asserted on the **attempt ledger**, which is what routing reads, and which the fix writes to.
  //
  // Three wrong routes were taken to this assertion first, each worth recording:
  //
  // 1. **`/health` after the stream.** `HealthRegistry.report()` returns cached health or *re-probes*,
  //    and a fixture whose `healthCheck` answers `healthy` overwrites the recorded failure. Measured:
  //    exactly **1** `healthCheck` invocation, before and after identical. The test was measuring the
  //    fixture, not the fix.
  // 2. **The SSE body.** The route emits `event: error` with a generic `INTERNAL_ERROR`, so the
  //    ledger is not in the stream at all — it is attached to the outcome object, before the chunks.
  // 3. **A client that stops reading.** HTTP streaming is pull-based: the provider's iterator only
  //    advances when the gateway asks, so a test that reads one chunk and closes observes nothing. A
  //    real client reads to the end.
  const adapter = {
    id: 'exploding',
    name: 'Exploding',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'm1', providerId: 'exploding' }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat() { throw new Error('unused'); },
    async *streamChat() {
      yield { id: 'c1', providerId: 'exploding', model: 'm', content: 'partial' };
      throw new Error('provider died mid-answer');
    },
  };

  const registry = new ProviderRegistry().register(adapter);
  const store = new InMemoryConnectionStore();
  await store.save(
    { id: 'exploding', providerId: 'exploding', name: 'E', endpoint: 'https://x.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 60, timeoutMs: 5_000 } },
    { type: 'api-key', value: 'k' },
  );
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, new InMemoryApiKeyStore(), { failureThreshold: 1 });
  service.setHealthInterval(0);

  const outcome = await service.streamChatWithFailover({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

  // Opening is a success: the first chunk really did arrive.
  assert.deepEqual(
    outcome.attempts.map((attempt) => attempt.ok),
    [true],
    'the first chunk arriving is a successful open',
  );

  let sawChunk = false;
  await assert.rejects(async () => {
    for await (const chunk of outcome.chunks) {
      if (chunk.content === 'partial') sawChunk = true;
    }
  }, /died mid-answer/, 'the provider\'s failure should reach the caller, not be swallowed');
  assert.ok(sawChunk, 'the client must have received the first chunk before the failure');

  // And the ledger must now carry the failure. Before the fix the only entry was the opening success,
  // because `recordSuccess` ran from a `finally` on the throw path as well.
  const failures = outcome.attempts.filter((attempt) => !attempt.ok);
  assert.equal(
    failures.length,
    1,
    `expected exactly one failed attempt recorded, got ${JSON.stringify(outcome.attempts)}`,
  );
  assert.equal(failures[0].providerId, 'exploding');
  assert.equal(failures[0].errorCode, 'PROVIDER_REQUEST_FAILED', 'the failure must be classified, not blank');
});

test('recordSuccess is not reachable from a finally block', async (t) => {
  // The structural form of the same defect. A `finally` runs on the throw path too, so a success
  // recorded there is a success recorded for every failure.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/request-executor.ts'), 'utf8');

  const lines = source.split('\n');
  const offenders = [];
  let inFinally = false;
  let braceDepth = 0;
  for (const [index, line] of lines.entries()) {
    if (/\bfinally\s*\{/.test(line)) { inFinally = true; braceDepth = 0; }
    if (inFinally && /recordSuccess\(/.test(line)) offenders.push(index + 1);
    if (inFinally) {
      braceDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (braceDepth <= 0 && /\}/.test(line)) inFinally = false;
    }
  }
  assert.deepEqual(offenders, [], `recordSuccess is called from a finally block at line(s) ${offenders.join(', ')} — a finally runs on the failure path too`);
});

test('an abandoned hedge does not record health when it finishes anyway', async () => {
  // A hedge that loses is aborted and recorded `CANCELLED`. A provider that does not stop on the abort
  // then settles normally, and the settlement handler — which runs for every outcome — recorded a
  // success for an attempt the ledger had already closed.
  //
  // Measured before the fix, with the loser finishing 120ms after the winner:
  //
  //   winner            : fast
  //   recordSuccess     : ["fast","slow"]     ← `slow` was CANCELLED, and still recorded a success
  //
  // So the connection the gateway had stopped paying for still moved its health, and routing decisions
  // were made on a verdict for work nobody was waiting on.
  const health = { success: [], failure: [] };
  const candidates = [
    { providerId: 'slow', connectionId: 'c-slow', priority: 1, modelIds: ['m'], resilience: { maxRetries: 0, requestsPerMinute: 100, timeoutMs: 5_000, hedgeAfterMs: 10 } },
    { providerId: 'fast', connectionId: 'c-fast', priority: 2, modelIds: ['m'], resilience: { maxRetries: 0, requestsPerMinute: 100, timeoutMs: 5_000, hedgeAfterMs: 10 } },
  ];
  const reply = (id) => ({ id: 'r', providerId: id, model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: id }, finishReason: 'stop' });

  const executor = new RequestExecutor({
    planRoute: async () => ({ candidates }),
    // `slow` ignores the abort and finishes well after the winner is chosen — a real provider that does
    // not stop on SIGTERM. This is the race; a stub that honours the abort cannot reproduce it.
    chat: async (id) => { await new Promise((resolve) => setTimeout(resolve, id === 'slow' ? 140 : 20)); return reply(id); },
    streamChat: async function* () {},
    withDeadline: (signal, _ms, _id, run) => run(signal),
    enforceRateLimit: () => {},
    recordRateLimitUse: () => {},
    recordSuccess: (id) => health.success.push(id),
    recordFailure: (id, code) => health.failure.push(`${id}:${code}`),
  });

  const outcome = await executor.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, undefined);
  assert.equal(outcome.response?.providerId, 'fast', 'the faster route should win');

  // The loser is recorded as abandoned at the moment the winner is chosen.
  const abandoned = outcome.attempts.filter((attempt) => attempt.errorCode === 'CANCELLED');
  assert.equal(abandoned.length, 1, `expected one abandoned attempt, got ${JSON.stringify(outcome.attempts)}`);
  assert.equal(abandoned[0].providerId, 'slow');

  // And long after it has settled, only the winner may have recorded health.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(
    health.success,
    ['fast'],
    `only the winner may record a success; an abandoned attempt still settled and recorded ${JSON.stringify(health.success)}`,
  );
  assert.deepEqual(health.failure, [], 'an abandoned attempt must not record a provider failure either');
});

test('every attempt in the ledger has exactly one outcome', async () => {
  // The roadmap's Phase 5.3: a logical request has one deterministic final outcome. Asserted as a
  // property over the ledger rather than a list of expected entries, so a fourth state fails too.
  const candidates = [
    { providerId: 'slow', connectionId: 'c-slow', priority: 1, modelIds: ['m'], resilience: { maxRetries: 0, requestsPerMinute: 100, timeoutMs: 5_000, hedgeAfterMs: 10 } },
    { providerId: 'fast', connectionId: 'c-fast', priority: 2, modelIds: ['m'], resilience: { maxRetries: 0, requestsPerMinute: 100, timeoutMs: 5_000, hedgeAfterMs: 10 } },
  ];
  const reply = (id) => ({ id: 'r', providerId: id, model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: id }, finishReason: 'stop' });
  const executor = new RequestExecutor({
    planRoute: async () => ({ candidates }),
    chat: async (id) => { await new Promise((resolve) => setTimeout(resolve, id === 'slow' ? 140 : 20)); return reply(id); },
    streamChat: async function* () {},
    withDeadline: (signal, _ms, _id, run) => run(signal),
    enforceRateLimit: () => {}, recordRateLimitUse: () => {}, recordSuccess: () => {}, recordFailure: () => {},
  });

  const outcome = await executor.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const winners = outcome.attempts.filter((attempt) => attempt.ok);
  assert.equal(winners.length, 1, `exactly one attempt may succeed, got ${JSON.stringify(outcome.attempts)}`);

  // Every unsuccessful attempt must say why — a bare `ok: false` is a ledger entry nobody can act on.
  // `CANCELLED` is a legitimate loser outcome; what is forbidden is the **winner** carrying it, which
  // would mean an attempt both succeeded and was abandoned.
  for (const attempt of outcome.attempts) {
    assert.ok(attempt.ok || attempt.errorCode, `an unsuccessful attempt must say why: ${JSON.stringify(attempt)}`);
  }
  assert.notEqual(
    winners[0].errorCode,
    'CANCELLED',
    'the winning attempt must not also be recorded as abandoned',
  );

  // And no provider may appear twice: one dispatch, one ledger entry. The abandoned-hedge race was
  // where a second push was most likely.
  const seen = new Set();
  for (const attempt of outcome.attempts) {
    const key = `${attempt.providerId}#${attempt.attempt}`;
    assert.ok(!seen.has(key), `${key} appears twice in the ledger: ${JSON.stringify(outcome.attempts)}`);
    seen.add(key);
  }
});
