import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';
import { RequestExecutor } from '../dist/request-executor.js';
import { InMemorySecretStore, ProviderError, ProviderRegistry } from '@hilbras/omnihilbras';

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

test('a request refused only because every connection is rate-limited answers 429, not 502', async (t) => {
  // Measured before the fix, with a limit of 1:
  //
  //   req 1: HTTP 200
  //   req 2: HTTP 502  code=PROVIDER_UNAVAILABLE  retryable=true
  //
  // The connection was skipped during *planning*, so no `RATE_LIMITED` error was ever thrown and
  // `statusForError` — which maps `RATE_LIMITED` to 429 correctly — was never reached. The client was told
  // to retry a connection that was at its RPM ceiling, and got a 502 where the standard answer is 429.
  const adapter = {
    id: 'p', name: 'p',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat() { return { id: 'r', providerId: 'p', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'x' }, finishReason: 'stop' }; },
    async *streamChat() { yield { id: 'c', providerId: 'p', model: 'm', content: 'x' }; },
  };
  const registry = new ProviderRegistry().register(adapter);
  const store = new InMemoryConnectionStore();
  await store.save(
    { id: 'p', providerId: 'p', name: 'P', endpoint: 'https://p.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 1, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: 'k' },
  );
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('rate-limit-code')).key;
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 5 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal((await post()).status, 200, 'the first request is inside the limit');
  const refused = await post();
  assert.equal(refused.status, 429, `a rate-limited-only refusal answered ${refused.status}; 429 is what tells a client to back off rather than retry`);
  const body = await refused.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.notEqual(body.error.retryable, true, 'retrying immediately is what produced the refusal');
});

test('a refusal with any reason other than a limit is never reported as 429', async (t) => {
  // If the only skipped connection is rate-limited, 429 is right. If something else is *also* wrong —
  // no credential, say — then a 429 would send the client to wait when the real answer is "fix this".
  // So the 429 is deliberately narrow.
  const adapter = {
    id: 'p', name: 'p',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat() { return { id: 'r', providerId: 'p', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'x' }, finishReason: 'stop' }; },
    async *streamChat() { yield { id: 'c', providerId: 'p', model: 'm', content: 'x' }; },
  };
  const registry = new ProviderRegistry().register(adapter);
  const store = new InMemoryConnectionStore();
  // Two connections: one rate-limited, one with no credential at all.
  await store.save(
    { id: 'a', providerId: 'a', name: 'A', endpoint: 'https://a.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 1, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: 'k' },
  );
  await store.save(
    { id: 'b', providerId: 'b', name: 'B', endpoint: 'https://b.example/v1', priority: 2, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 60, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'none' },
  );
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('mixed')).key;
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 5 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });

  await post();  // spends A's single slot
  const refused = await post();
  const body = await refused.json();
  // The assertion is **"not 429"**, and nothing stronger. My first version demanded
  // `PROVIDER_UNAVAILABLE` and the gateway answered `AUTHENTICATION_FAILED` — which is *better*: the
  // credential-less connection is the real problem and the code says so. Asserting a specific wrong code
  // would have replaced a good answer with a merely-acceptable one.
  assert.notEqual(
    body.error.code,
    'RATE_LIMITED',
    `a mixed refusal answered ${body.error.code}; 429 would send the client to back off when the real ` +
      'problem is something else entirely',
  );
  // The *message* is the single-route path's own redacted public text — `Provider authentication
  // failed.` — so the skipped-reason list never reaches this client. That is existing, deliberate
  // behaviour ("a single route keeps the adapter's own redacted public message"), not something this
  // change altered. The signal a client acts on is the code, which is asserted above.
});

test('a refusal by the rate limiter does not record a provider failure', async () => {
  // Measured before the fix, with the limiter refusing the only candidate:
  //
  //   client saw      : PROVIDER_REQUEST_FAILED
  //   provider calls  : 0   enforce calls: 1
  //   recordFailure   : ["p:PROVIDER_REQUEST_FAILED"]
  //
  // Nothing was sent, so there was nothing to learn about the provider — and the provider was recorded as
  // having failed anyway. Same class as the cancellation fix (1.52.0) and the abandoned hedge (1.53.0): a
  // health counter recording something that did not happen.
  const health = { success: [], failure: [] };
  let calls = 0;
  let enforced = 0;
  const candidate = { providerId: 'p', connectionId: 'c', priority: 1, modelIds: ['m'], resilience: { maxRetries: 2, requestsPerMinute: 1, timeoutMs: 5_000, hedgeAfterMs: 0 } };
  const executor = new RequestExecutor({
    planRoute: async () => ({ candidates: [candidate] }),
    chat: async () => { calls += 1; return { id: 'r', providerId: 'p', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'x' }, finishReason: 'stop' }; },
    streamChat: async function* () {},
    withDeadline: (signal, _ms, _id, run) => run(signal),
    enforceRateLimit: () => { enforced += 1; const error = new Error('at the limit'); error.code = 'RATE_LIMITED'; throw error; },
    recordRateLimitUse: () => {},
    recordSuccess: (id) => health.success.push(id),
    recordFailure: (id, code) => health.failure.push(`${id}:${code}`),
  });

  await assert.rejects(() => executor.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, undefined));
  assert.equal(calls, 0, 'the provider was never contacted, so it cannot have failed');
  assert.deepEqual(health.failure, [], 'a provider the limiter kept us from calling must not be recorded as failing');
  assert.deepEqual(health.success, [], 'nor as succeeding');
  assert.equal(enforced, 1, 'the refusal was the limiter\'s, not a retry loop');
});

test('a limiter refusal answers 429 and is not retryable, not 502 telling the client to retry', async () => {
  // `statusForError` maps RATE_LIMITED to 429, but the limiter's error never reached it — the refusal was
  // caught and rewrapped as a generic provider failure. A client obeying that would retry a connection at
  // its RPM ceiling, which is the same defect 1.54.0 fixed for the planning-skip path.
  const candidate = { providerId: 'p', connectionId: 'c', priority: 1, modelIds: ['m'], resilience: { maxRetries: 2, requestsPerMinute: 1, timeoutMs: 5_000, hedgeAfterMs: 0 } };
  const executor = new RequestExecutor({
    planRoute: async () => ({ candidates: [candidate] }),
    chat: async () => { throw new Error('the provider works; the limiter refused before this ran'); },
    streamChat: async function* () {},
    withDeadline: (signal, _ms, _id, run) => run(signal),
    enforceRateLimit: () => { const error = new Error('at the limit'); error.code = 'RATE_LIMITED'; throw error; },
    recordRateLimitUse: () => {}, recordSuccess: () => {}, recordFailure: () => {},
  });

  const error = await executor.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, undefined).then(() => null, (caught) => caught);
  assert.equal(error.code, 'RATE_LIMITED', `the client saw ${error?.code}`);
  assert.notEqual(error.retryable, true, 'retrying immediately is what produced the refusal');
});

test('two requests racing one connection: the loser gets 429 and the provider stays healthy', async (t) => {
  // The end-to-end shape of the same defect, over real HTTP. Both requests pass planning — the provider is
  // slow — and then race at `enforce()`. One gets the slot; the other is refused.
  const adapter = {
    id: 'p', name: 'p',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat() { await new Promise((resolve) => setTimeout(resolve, 60)); return { id: 'r', providerId: 'p', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'x' }, finishReason: 'stop' }; },
    async *streamChat() { yield { id: 'c', providerId: 'p', model: 'm', content: 'x' }; },
  };
  const registry = new ProviderRegistry().register(adapter);
  const store = new InMemoryConnectionStore();
  await store.save(
    { id: 'p', providerId: 'p', name: 'P', endpoint: 'https://p.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 1, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: 'k' },
  );
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('enforce-race')).key;
  // failureThreshold 1: a single false failure would eject this connection outright, which is the
  // consequence being asserted against.
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });

  const statuses = (await Promise.all([post(), post()])).map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 429], `a refused race answered ${statuses.join('/')}; 429 is what tells the client to wait`);

  // The connection is still usable: it was refused, not failed.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const report = await (await fetch(`${base}/v1/routing`, { headers: { authorization: `Bearer ${key}` } })).json();
  const connection = report.connections[0];
  assert.notEqual(
    connection.health?.status,
    'unhealthy',
    'a limiter refusal ejected a working provider; the operator would be sent to debug a provider that never failed',
  );
});

test('a rate-limit refusal on the STREAMING path is not recorded as a provider failure either', async () => {
  // The chat path was fixed first and I did not go looking for the others — I reasoned that streaming
  // would share the code. It does not: `stream()` has its own dispatch loop. Enumerating every
  // `enforceRateLimit` call site found it immediately.
  //
  //   client saw      : PROVIDER_REQUEST_FAILED
  //   stream calls    : 0
  //   recordFailure   : ["p:PROVIDER_REQUEST_FAILED"]
  const health = { success: [], failure: [] };
  let streamCalls = 0;
  const candidate = { providerId: 'p', connectionId: 'c', priority: 1, modelIds: ['m'], resilience: { maxRetries: 0, requestsPerMinute: 1, timeoutMs: 5_000, hedgeAfterMs: 0 } };
  const executor = new RequestExecutor({
    planRoute: async () => ({ candidates: [candidate] }),
    chat: async () => { throw new Error('not reached'); },
    streamChat: async function* () { streamCalls += 1; yield { id: 'c', providerId: 'p', model: 'm', content: 'x' }; },
    withDeadline: (signal, _ms, _id, run) => run(signal),
    enforceRateLimit: () => { const error = new Error('at the limit'); error.code = 'RATE_LIMITED'; throw error; },
    recordRateLimitUse: () => {},
    recordSuccess: (id) => health.success.push(id),
    recordFailure: (id, code) => health.failure.push(`${id}:${code}`),
  });

  // `await` matters: without it the rejection escapes the try and the probe reported "no defect".
  // That was a false negative I believed for a minute, and it is the reason this test is written the way
  // it is rather than around a `for await` drain.
  const error = await executor.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, undefined).then(() => null, (caught) => caught);
  assert.equal(error?.code, 'RATE_LIMITED', `the client saw ${error?.code}`);
  assert.equal(streamCalls, 0, 'the provider was never contacted, so it cannot have failed');
  assert.deepEqual(health.failure, [], 'a provider the limiter kept us from calling must not be recorded as failing');
});

test('every dispatch path refuses on the limiter OUTSIDE its provider-error handling', () => {
  // The structural rule behind the two bugs above, so a *third* dispatch path cannot reintroduce it.
  //
  // Both fixes work by hoisting `enforceRateLimit` out of the `try` that records provider health — one
  // finds the same shape twice, the other reason about it. This enumerates the call sites instead, so the
  // next path added is covered by being present rather than by being remembered.
  const source = readFileSync(new URL('../src/request-executor.ts', import.meta.url), 'utf8');
  const callSites = [...source.matchAll(/^(\s*)this\.deps\.enforceRateLimit\(candidate\);/gm)];

  // Three dispatch paths dispatch a request: `chat` (sequential), `tryHedgedRace`, and `stream`. I wrote
  // `>= 4` from memory of the file and it failed on the real count — the hedge has one call site, not two.
  // A guard that encodes a guessed number is a guard that will be "fixed" by whoever hits it first.
  assert.equal(callSites.length, 3, `expected one call site per dispatch path (chat, hedge, stream), found ${callSites.length}`);

  for (const [index, site] of callSites.entries()) {
    // Walk back to the enclosing `try {`, then forward to the `enforceRateLimit` call. If a
    // `recordFailure` or `recordSuccess` appears in that window, the limiter is inside provider handling.
    const before = source.slice(Math.max(0, site.index - 700), site.index);
    const tryIndex = before.lastIndexOf('try {');
    assert.ok(tryIndex >= 0, `call site ${index + 1} has no enclosing try; the refusal would not be handled at all`);
    const window = source.slice(Math.max(0, site.index - 700) + tryIndex, site.index);
    assert.ok(
      !/recordFailure|recordSuccess/.test(window),
      `call site ${index + 1} calls enforceRateLimit inside a block that records provider health, so a\n` +
        'limiter refusal would be recorded as a provider failure. Hoist it above the try, as the chat and\n' +
        'stream paths now do.',
    );
  }
});

test('a leader that fails before the hedge fires still reaches the next route, instead of hanging', async (t) => {
  // The leader fails at 5 ms, well before the 200 ms hedge timer. The timer then finds nothing left to hedge
  // with and clears itself without waking the waiting loop. Before the fix the request never answered.
  const calls = [];
  const leader = scripted('leader', {
    calls,
    chat: async () => { await new Promise((r) => setTimeout(r, 5)); throw Object.assign(new Error('boom'), { code: 'PROVIDER_UNAVAILABLE' }); },
    async *stream() { yield { id: 'c', providerId: 'leader', model: 'm', content: 'x' }; },
  });
  const backup = scripted('backup', {
    calls,
    chat: async () => ({ id: 'r', providerId: 'backup', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'backup' }, finishReason: 'stop' }),
    async *stream() { yield { id: 'c', providerId: 'backup', model: 'm', content: 'x' }; },
  });
  const { base, auth } = await serve(t, [leader, backup], [
    { input: { id: 'leader', providerId: 'leader', name: 'Leader', endpoint: 'https://leader.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 100, timeoutMs: 5_000, hedgeAfterMs: 200 } }, credential: { type: 'api-key', value: 'k' } },
    { input: { id: 'backup', providerId: 'backup', name: 'Backup', endpoint: 'https://backup.example/v1', priority: 2, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 100, timeoutMs: 5_000, hedgeAfterMs: 0 } }, credential: { type: 'api-key', value: 'k' } },
  ], { failureThreshold: 3 });

  const response = await Promise.race([
    fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }) }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('the request hung past 3 s')), 3_000)),
  ]);
  assert.equal(response.status, 200, 'the backup route answers once the leader has failed');
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'backup');
});

test('a route that hits its rate limit between planning and dispatch hands the request on, instead of ending it', async (t) => {
  // The planner sees B with budget. The test then uses up B's one call after planning and before dispatch, so
  // B's dispatch is refused. That refusal must move the request on to C, not end the chain.
  const calls = [];
  const a = scripted('a', {
    calls,
    chat: async () => { throw new ProviderError('PROVIDER_UNAVAILABLE', 'down', { providerId: 'a', retryable: true }); },
    async *stream() { yield { id: 'c', providerId: 'a', model: 'm', content: 'x' }; },
  });
  const b = scripted('b', {
    calls,
    chat: async () => ({ id: 'r', providerId: 'b', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'b' }, finishReason: 'stop' }),
    async *stream() { yield { id: 'c', providerId: 'b', model: 'm', content: 'x' }; },
  });
  const c = scripted('c', {
    calls,
    chat: async () => ({ id: 'r', providerId: 'c', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'from-c' }, finishReason: 'stop' }),
    async *stream() { yield { id: 'c', providerId: 'c', model: 'm', content: 'x' }; },
  });
  const limited = { maxRetries: 0, requestsPerMinute: 1, timeoutMs: 5_000, hedgeAfterMs: 0 };
  const open = { maxRetries: 0, requestsPerMinute: 100, timeoutMs: 5_000, hedgeAfterMs: 0 };
  const { base, auth, service } = await serve(t, [a, b, c], [
    { input: { id: 'a', providerId: 'a', name: 'A', endpoint: 'https://a.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: open }, credential: { type: 'api-key', value: 'k' } },
    { input: { id: 'b', providerId: 'b', name: 'B', endpoint: 'https://b.example/v1', priority: 2, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: limited }, credential: { type: 'api-key', value: 'k' } },
    { input: { id: 'c', providerId: 'c', name: 'C', endpoint: 'https://c.example/v1', priority: 3, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: open }, credential: { type: 'api-key', value: 'k' } },
  ], { failureThreshold: 3 });

  // After the plan, B's single call is spent, so the dispatch to B is refused by the limiter.
  service.testAfterPlan = () => { service.rateLimiter.record('b'); };
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });
  service.testAfterPlan = undefined;
  assert.equal(response.status, 200, 'the request refused at B\'s dispatch is answered by C, not ended');
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'from-c');
});

test('a request the caller got wrong does not count against the provider\'s health', async () => {
  // A refusal of the request (INVALID_REQUEST, NOT_SUPPORTED) says nothing about the provider. Recording it as
  // a provider failure let three bad requests from one client eject a healthy provider for everyone.
  const health = { failure: [] };
  const candidates = [{ providerId: 'p', connectionId: 'c-p', priority: 1, modelIds: ['m'], resilience: { maxRetries: 0, requestsPerMinute: 100, timeoutMs: 5_000, hedgeAfterMs: 0 } }];
  const executor = new RequestExecutor({
    planRoute: async () => ({ candidates }),
    chat: async () => { throw new ProviderError('INVALID_REQUEST', 'bad field', { providerId: 'p' }); },
    streamChat: async function* () {},
    withDeadline: (signal, _ms, _id, run) => run(signal),
    enforceRateLimit: () => {},
    recordRateLimitUse: () => {},
    recordSuccess: () => {},
    recordFailure: (id, code) => health.failure.push(`${id}:${code}`),
  });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => executor.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, undefined));
  }
  assert.deepEqual(health.failure, [], 'three client errors must not be recorded as provider failures');
});

test('a real provider outage still counts against the provider\'s health', async () => {
  const health = { failure: [] };
  const candidates = [{ providerId: 'p', connectionId: 'c-p', priority: 1, modelIds: ['m'], resilience: { maxRetries: 0, requestsPerMinute: 100, timeoutMs: 5_000, hedgeAfterMs: 0 } }];
  const executor = new RequestExecutor({
    planRoute: async () => ({ candidates }),
    chat: async () => { throw new ProviderError('PROVIDER_UNAVAILABLE', 'down', { providerId: 'p', retryable: true }); },
    streamChat: async function* () {},
    withDeadline: (signal, _ms, _id, run) => run(signal),
    enforceRateLimit: () => {},
    recordRateLimitUse: () => {},
    recordSuccess: () => {},
    recordFailure: (id, code) => health.failure.push(`${id}:${code}`),
  });
  await assert.rejects(() => executor.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, undefined));
  assert.deepEqual(health.failure, ['p:PROVIDER_UNAVAILABLE'], 'an outage is still recorded');
});

test('a 429 cools that model on that provider, with the provider\'s reset time, and does not count as a provider failure', async () => {
  const cooled = [];
  const health = { failure: [] };
  const candidates = [{ providerId: 'p', connectionId: 'c-p', priority: 1, modelIds: ['m'], resilience: { maxRetries: 0, requestsPerMinute: 100, timeoutMs: 5_000, hedgeAfterMs: 0 } }];
  const executor = new RequestExecutor({
    planRoute: async () => ({ candidates }),
    chat: async () => { throw new ProviderError('RATE_LIMITED', 'limited', { providerId: 'p', retryable: true, details: { retryAfterMs: 120_000 } }); },
    streamChat: async function* () {},
    withDeadline: (signal, _ms, _id, run) => run(signal),
    enforceRateLimit: () => {},
    recordRateLimitUse: () => {},
    recordSuccess: () => {},
    recordFailure: (id, code) => health.failure.push(`${id}:${code}`),
    recordModelRateLimit: (providerId, modelId, input) => cooled.push({ providerId, modelId, ...input }),
  });
  await assert.rejects(() => executor.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, undefined));
  assert.deepEqual(cooled, [{ providerId: 'p', modelId: 'm', retryAfterMs: 120_000 }], 'the model is cooled with the reset time the provider gave');
});
