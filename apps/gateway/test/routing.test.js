import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderError, ProviderRegistry } from '@hilbras/omnihilbras';
import { GatewayService, InMemoryConnectionStore, InMemoryApiKeyStore, createGatewayServer, HealthRegistry, SlidingWindowRateLimiter, isRetryableFailure, resolveRoute } from '../dist/index.js';

function chattyAdapter(id, behavior = {}) {
  return {
    id,
    name: `${id} provider`,
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() {
      return [{ id: `${id}-model`, providerId: id }];
    },
    async healthCheck() {
      if (behavior.healthThrows) throw new ProviderError('PROVIDER_UNAVAILABLE', 'down');
      return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 12 };
    },
    async chat(request) {
      behavior.calls?.push({ provider: id, model: request.model });
      if (typeof behavior.fail === 'function') await behavior.fail(id, behavior.calls?.length ?? 0);
      return { id: `resp-${id}`, providerId: id, model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: `hello from ${id}` }, finishReason: 'stop' };
    },
    async *streamChat(request) {
      behavior.calls?.push({ provider: id, model: request.model, stream: true });
      if (typeof behavior.fail === 'function') await behavior.fail(id, behavior.calls?.length ?? 0);
      yield { id: `chunk-${id}`, providerId: id, model: request.model, delta: { role: 'assistant' } };
      yield { id: `chunk-${id}-2`, providerId: id, model: request.model, delta: { content: `streamed by ${id}` }, finishReason: 'stop' };
    },
  };
}

function connectionInput(providerId, overrides = {}) {
  return {
    id: providerId,
    providerId,
    name: `${providerId} connection`,
    endpoint: `https://api.${providerId}.example.com/v1`,
    priority: 1,
    proxyPool: 'none',
    modelIds: ['shared/model'],
    ...overrides,
  };
}

async function storeWith(entries) {
  const store = new InMemoryConnectionStore();
  for (const entry of entries) {
    await store.save(connectionInput(entry.providerId ?? entry.id, entry), { type: 'api-key', value: `secret-${entry.providerId ?? entry.id}` });
  }
  return store;
}

function buildService(adapters, store, options) {
  const registry = new ProviderRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return new GatewayService(registry, new InMemorySecretStore({}), store, new InMemoryApiKeyStore(), options);
}

const chatRequest = { model: 'shared/model', messages: [{ role: 'user', content: 'hi' }] };

test('a failing primary retries its own budget before failing over', async () => {
  const calls = [];
  let primaryCalls = 0;
  const primary = chattyAdapter('primary', {
    calls,
    fail: async (id, count) => {
      if (id === 'primary') {
        primaryCalls += 1;
        // Fails the first attempt, then succeeds.
        if (count <= 1) throw new ProviderError('PROVIDER_TIMEOUT', 'timed out', { retryable: true });
      }
    },
  });
  const backup = chattyAdapter('backup', { calls });
  const store = await storeWith([{ id: 'primary', priority: 1, maxRetries: 1, resilience: { maxRetries: 1 } }, { id: 'backup', priority: 2 }]);
  const service = buildService([primary, backup], store);

  const { response, attempts } = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(response.providerId, 'primary');
  assert.equal(primaryCalls, 2, 'the retry budget is spent on the primary');
  assert.deepEqual(attempts.map((attempt) => `${attempt.providerId}#${attempt.attempt}:${attempt.ok ? 'ok' : attempt.errorCode}`), ['primary#1:PROVIDER_TIMEOUT', 'primary#2:ok']);
  assert.equal(calls.filter((call) => call.provider === 'backup').length, 0, 'failover is not needed');
});

test('a retryable failure fails over to the next priority connection', async () => {
  const calls = [];
  const primary = chattyAdapter('primary', { calls, fail: async (id) => { if (id === 'primary') throw new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true }); } });
  const backup = chattyAdapter('backup', { calls });
  const store = await storeWith([{ id: 'primary', priority: 1, resilience: { maxRetries: 0 } }, { id: 'backup', priority: 2 }]);
  const service = buildService([primary, backup], store);

  const { response, attempts } = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(response.providerId, 'backup');
  assert.equal(response.message.content, 'hello from backup');
  assert.deepEqual(attempts.map((attempt) => `${attempt.providerId}:${attempt.ok ? 'ok' : attempt.errorCode}`), ['primary:PROVIDER_UNAVAILABLE', 'backup:ok']);
});

test('auth and validation failures fail over immediately without retrying', async () => {
  for (const code of ['AUTHENTICATION_FAILED', 'INVALID_REQUEST']) {
    const calls = [];
    const primary = chattyAdapter('primary', { calls, fail: async (id) => { if (id === 'primary') throw new ProviderError(code, 'nope', { retryable: true }); } });
    const backup = chattyAdapter('backup', { calls });
    const store = await storeWith([{ id: 'primary', priority: 1, resilience: { maxRetries: 3 } }, { id: 'backup', priority: 2 }]);
    const service = buildService([primary, backup], store);

    await assert.rejects(() => service.chatWithFailover(chatRequest, undefined), (error) => error instanceof ProviderError && error.code === code);
    assert.equal(calls.filter((call) => call.provider === 'primary').length, 1, `${code} is attempted once`);
    assert.equal(calls.filter((call) => call.provider === 'backup').length, 0, `${code} does not fail over`);
  }
});

test('when every route fails the client gets one clear gateway error', async () => {
  const calls = [];
  const failing = (id) => chattyAdapter(id, { calls, fail: async () => { throw new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true }); } });
  const store = await storeWith([{ id: 'alpha', priority: 1, resilience: { maxRetries: 0 } }, { id: 'beta', priority: 2, resilience: { maxRetries: 0 } }]);
  const service = buildService([failing('alpha'), failing('beta')], store);

  await assert.rejects(
    () => service.chatWithFailover(chatRequest, undefined),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.match(error.publicMessage ?? '', /alpha, beta/);
      return true;
    },
  );
});

test('a connection is ejected after consecutive failures and recovers on success', async () => {
  const calls = [];
  let primaryHealthy = false;
  let now = 1_000_000;
  const primary = chattyAdapter('primary', {
    calls,
    fail: async (id) => {
      if (id === 'primary' && !primaryHealthy) throw new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true });
    },
  });
  const backup = chattyAdapter('backup', { calls });
  const store = await storeWith([{ id: 'primary', priority: 1, resilience: { maxRetries: 0 } }, { id: 'backup', priority: 2 }]);
  const service = buildService([primary, backup], store, { failureThreshold: 2, recoveryCooldownMs: 5_000, now: () => now });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const outcome = await service.chatWithFailover(chatRequest, undefined);
    assert.equal(outcome.response.providerId, 'backup', 'failover covers the failing primary');
  }
  const beforeEjection = calls.filter((call) => call.provider === 'primary').length;
  assert.equal(beforeEjection, 2, 'the threshold is reached after two consecutive failures');

  const afterEjection = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(afterEjection.response.providerId, 'backup');
  assert.equal(calls.filter((call) => call.provider === 'primary').length, beforeEjection, 'the ejected primary is skipped entirely');

  primaryHealthy = true;
  now += 6_000;
  const recovered = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(recovered.response.providerId, 'primary', 'a recovered provider rejoins after the cooldown');
});

test('a per-connection timeout fails over as a retryable error', async () => {
  const calls = [];
  const primary = chattyAdapter('primary', {
    calls,
    fail: async (id) => {
      if (id === 'primary') await new Promise((resolve) => setTimeout(resolve, 80));
    },
  });
  const backup = chattyAdapter('backup', { calls });
  const store = await storeWith([{ id: 'primary', priority: 1, resilience: { maxRetries: 0, timeoutMs: 20 } }, { id: 'backup', priority: 2 }]);
  const service = buildService([primary, backup], store);

  const { response, attempts } = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(response.providerId, 'backup');
  assert.equal(attempts[0].errorCode, 'PROVIDER_TIMEOUT');
});

test('a per-connection rate limit hands off to the next route', async () => {
  const calls = [];
  const primary = chattyAdapter('primary', { calls });
  const backup = chattyAdapter('backup', { calls });
  const store = await storeWith([{ id: 'primary', priority: 1, resilience: { maxRetries: 0, requestsPerMinute: 1 } }, { id: 'backup', priority: 2 }]);
  const service = buildService([primary, backup], store);

  const first = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(first.response.providerId, 'primary');
  const second = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(second.response.providerId, 'backup', 'the limited connection steps aside');
  assert.equal(calls.filter((call) => call.provider === 'primary').length, 1, 'the limit is enforced');
});

test('only the connection that owns the model is used when several share it', async () => {
  const calls = [];
  const openrouter = chattyAdapter('openrouter', { calls });
  const backup = chattyAdapter('backup', { calls });
  const store = await storeWith([
    { id: 'openrouter', priority: 1, modelIds: ['shared/model'], name: 'OpenRouter' },
    { id: 'backup', priority: 2, modelIds: ['other/model'], name: 'Backup' },
  ]);
  const service = buildService([openrouter, backup], store);

  const { response } = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(response.providerId, 'openrouter');
  assert.equal(calls.filter((call) => call.provider === 'backup').length, 0, 'an unrelated provider stays out of the chain');
});

test('an explicit provider pin is served even when the model is not catalogued', async () => {
  const calls = [];
  const primary = chattyAdapter('primary', { calls });
  const store = await storeWith([{ id: 'primary', priority: 1, modelIds: ['shared/model'] }]);
  const service = buildService([primary], store);

  const { response } = await service.chatWithFailover({ ...chatRequest, model: 'unlisted/model' }, 'primary');
  assert.equal(response.providerId, 'primary');
  assert.equal(response.model, 'unlisted/model');
});

test('streaming fails over only before the first chunk is sent', async () => {
  const calls = [];
  const primary = chattyAdapter('primary', { calls, fail: async (id) => { if (id === 'primary') throw new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true }); } });
  const backup = chattyAdapter('backup', { calls });
  const store = await storeWith([{ id: 'primary', priority: 1, resilience: { maxRetries: 0 } }, { id: 'backup', priority: 2 }]);
  const service = buildService([primary, backup], store);

  const { chunks, attempts } = await service.streamChatWithFailover({ ...chatRequest, stream: true }, undefined);
  const received = [];
  for await (const chunk of chunks) received.push(chunk.delta.content ?? chunk.delta.role);
  assert.deepEqual(received, ['assistant', 'streamed by backup']);
  assert.deepEqual(attempts.map((attempt) => `${attempt.providerId}:${attempt.ok ? 'ok' : attempt.errorCode}`), ['primary:PROVIDER_UNAVAILABLE', 'backup:ok']);
});

test('a mid-stream failure is reported instead of silently restarting', async () => {
  const midStream = {
    id: 'flaky',
    name: 'Flaky provider',
    capabilities: { chat: false, streaming: true, models: false },
    async *streamChat() {
      yield { id: 'c1', providerId: 'flaky', model: 'shared/model', delta: { role: 'assistant' } };
      throw new ProviderError('PROVIDER_REQUEST_FAILED', 'connection reset', { retryable: true });
    },
  };
  const store = await storeWith([{ id: 'flaky', priority: 1, resilience: { maxRetries: 0 } }]);
  const service = buildService([midStream], store);

  const { chunks } = await service.streamChatWithFailover({ ...chatRequest, stream: true }, undefined);
  const received = [];
  await assert.rejects(async () => {
    for await (const chunk of chunks) received.push(chunk);
  }, (error) => error instanceof ProviderError);
  assert.equal(received.length, 1, 'the chunk already delivered is not replayed');
});

test('background health polling marks a provider unhealthy without a request', async () => {
  const primary = chattyAdapter('primary', { healthThrows: true });
  const backup = chattyAdapter('backup');
  const store = await storeWith([{ id: 'primary', priority: 1 }, { id: 'backup', priority: 2 }]);
  const service = buildService([primary, backup], store, { failureThreshold: 1 });

  const health = await service.refreshHealth();
  assert.equal(health.status, 'degraded');
  assert.equal(health.providers.find((provider) => provider.providerId === 'primary').status, 'unavailable');

  const routing = await service.describeRouting();
  const primaryState = routing.connections.find((connection) => connection.providerId === 'primary');
  assert.equal(primaryState.failures >= 1, true);
  assert.equal(primaryState.ejected, true, 'an unhealthy provider is marked ejected in the dashboard view');
  assert.match(primaryState.lastError ?? '', /PROVIDER_UNAVAILABLE/);

  const { response } = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(response.providerId, 'backup', 'an unhealthy provider is skipped');
  service.stopHealthMonitor();
});

test('the health monitor can be started and stopped without leaking timers', async () => {
  const service = buildService([chattyAdapter('primary')], await storeWith([{ id: 'primary' }]));
  service.startHealthMonitor(20);
  await new Promise((resolve) => setTimeout(resolve, 60));
  service.stopHealthMonitor();
  const before = (await service.describeRouting()).connections[0].successes;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await service.describeRouting()).connections[0].successes, before, 'polling stopped');
  service.stopHealthMonitor();
});

test('resilience settings persist and validate at the store boundary', async () => {
  const store = new InMemoryConnectionStore();
  await store.save(connectionInput('primary', { resilience: { timeoutMs: 5_000, maxRetries: 2, requestsPerMinute: 30 } }), { type: 'api-key', value: 'secret' });
  const [saved] = await store.list();
  assert.deepEqual(saved.resilience, { timeoutMs: 5_000, maxRetries: 2, requestsPerMinute: 30, hedgeAfterMs: 0 });

  const updated = await store.updateResilience('primary', { maxRetries: 4 });
  assert.equal(updated.resilience.maxRetries, 4);
  assert.equal(updated.resilience.timeoutMs, 5_000, 'unspecified fields are preserved');
  assert.equal(await store.updateResilience('missing', { maxRetries: 1 }), undefined);

  await assert.rejects(() => store.updateResilience('primary', { maxRetries: 99 }), /maxRetries must be an integer/);
  await assert.rejects(() => store.updateResilience('primary', { timeoutMs: -1 }), /timeoutMs must be an integer/);
  await assert.rejects(() => store.updateResilience('primary', { requestsPerMinute: 1.5 }), /requestsPerMinute must be an integer/);
});

test('the sliding window limiter does not allow a double burst across a minute', () => {
  let now = 0;
  const limiter = new SlidingWindowRateLimiter(() => now);
  assert.equal(limiter.check('a', 2), 0);
  assert.equal(limiter.check('a', 2), 0);
  assert.equal(limiter.check('a', 2) > 0, true, 'the third request waits');
  now = 30_000;
  assert.equal(limiter.check('a', 2) > 0, true, 'still limited halfway through the window');
  now = 60_001;
  assert.equal(limiter.check('a', 2), 0, 'the window slides');
  assert.equal(limiter.check('b', 0), 0, 'a zero limit never blocks');
  assert.equal(limiter.check('c', 0), 0);

  now = 500_000;
  limiter.prune();
  assert.equal(limiter.check('a', 2), 0);
});

test('a slow leader is hedged and the faster route wins', async () => {
  const calls = [];
  const slow = chattyAdapter('slow', {
    calls,
    fail: async (id) => {
      if (id === 'slow') await new Promise((resolve) => setTimeout(resolve, 300));
    },
  });
  const fast = chattyAdapter('fast', { calls });
  const store = await storeWith([{ id: 'slow', priority: 1, resilience: { maxRetries: 0, hedgeAfterMs: 30 } }, { id: 'fast', priority: 2 }]);
  const service = buildService([slow, fast], store);

  const startedAt = Date.now();
  const { response, attempts } = await service.chatWithFailover(chatRequest, undefined);
  const elapsed = Date.now() - startedAt;

  assert.equal(response.providerId, 'fast', 'the hedge wins when it is faster');
  assert.equal(response.message.content, 'hello from fast');
  assert.ok(elapsed < 250, `the client waited for the hedge, not the leader (${elapsed} ms)`);
  assert.equal(calls.filter((call) => call.provider === 'fast').length, 1, 'exactly one hedge is sent');
  const won = attempts.find((attempt) => attempt.ok);
  assert.equal(won.providerId, 'fast', 'the winning attempt is in the trace');
  const abandoned = attempts.find((attempt) => attempt.providerId === 'slow');
  assert.equal(abandoned.ok, false, 'the abandoned leader appears in the trace');
  assert.equal(abandoned.errorCode, 'CANCELLED', 'the leader is reported as cancelled, not failed');
});

test('a fast leader is never hedged', async () => {
  const calls = [];
  const quick = chattyAdapter('quick', { calls });
  const backup = chattyAdapter('backup', { calls });
  const store = await storeWith([{ id: 'quick', priority: 1, resilience: { maxRetries: 0, hedgeAfterMs: 200 } }, { id: 'backup', priority: 2 }]);
  const service = buildService([quick, backup], store);

  const { response, attempts } = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(response.providerId, 'quick');
  assert.equal(calls.filter((call) => call.provider === 'backup').length, 0, 'the backup is never contacted');
  assert.equal(attempts.length, 1, 'a single attempt needs no trace');
});

test('hedging is skipped when only one connection can serve the model', async () => {
  const calls = [];
  const only = chattyAdapter('only', { calls, fail: async (id) => { if (id === 'only') await new Promise((resolve) => setTimeout(resolve, 120)); } });
  const other = chattyAdapter('other', { calls });
  const store = await storeWith([
    { id: 'only', priority: 1, modelIds: ['shared/model'], resilience: { maxRetries: 0, hedgeAfterMs: 20 } },
    { id: 'other', priority: 2, modelIds: ['other/model'] },
  ]);
  const service = buildService([only, other], store);

  const { response } = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(response.providerId, 'only');
  assert.equal(calls.filter((call) => call.provider === 'other').length, 0, 'an unrelated provider is not raced in');
});

test('a hedged request still returns the leader when it wins', async () => {
  const calls = [];
  const leader = chattyAdapter('leader', {
    calls,
    fail: async (id) => {
      if (id === 'leader') await new Promise((resolve) => setTimeout(resolve, 150));
    },
  });
  const backup = chattyAdapter('backup', { calls, fail: async (id) => { if (id === 'backup') await new Promise((resolve) => setTimeout(resolve, 400)); } });
  const store = await storeWith([{ id: 'leader', priority: 1, resilience: { maxRetries: 0, hedgeAfterMs: 30 } }, { id: 'backup', priority: 2 }]);
  const service = buildService([leader, backup], store);

  const { response } = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(response.providerId, 'leader');
  assert.equal(response.message.content, 'hello from leader');
});

test('both hedged routes failing falls through to the chain', async () => {
  const calls = [];
  const slowFail = chattyAdapter('slowfail', {
    calls,
    fail: async (id) => {
      if (id === 'slowfail') {
        await new Promise((resolve) => setTimeout(resolve, 120));
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true });
      }
    },
  });
  const hedgeFail = chattyAdapter('hedgefail', { calls, fail: async (id) => { if (id === 'hedgefail') throw new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true }); } });
  const last = chattyAdapter('last', { calls });
  const store = await storeWith([
    { id: 'slowfail', priority: 1, resilience: { maxRetries: 0, hedgeAfterMs: 20 } },
    { id: 'hedgefail', priority: 2, resilience: { maxRetries: 0 } },
    { id: 'last', priority: 3, resilience: { maxRetries: 0 } },
  ]);
  const service = buildService([slowFail, hedgeFail, last], store);

  const { response } = await service.chatWithFailover(chatRequest, undefined);
  assert.equal(response.providerId, 'last', 'the chain continues after a failed race');
});

test('a saved connection without a registered adapter can still serve traffic', async () => {
  // An empty registry: the connection endpoint must be resolved on demand.
  const store = new InMemoryConnectionStore();
  await store.save({
    id: 'ollama',
    providerId: 'ollama',
    name: 'Local Ollama',
    // A loopback port with nothing listening, so the request fails fast at the
    // transport rather than hanging the test.
    endpoint: 'http://127.0.0.1:9/v1',
    priority: 1,
    proxyPool: 'none',
    modelIds: ['llama3.2'],
    resilience: { maxRetries: 0, timeoutMs: 500 },
  }, { type: 'api-key', value: 'ollama' });
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({ ollama: { type: 'api-key', value: 'ollama' } }), store, new InMemoryApiKeyStore());

  // The adapter is built from the saved endpoint, so capability checks pass
  // without a registry entry. The point is that routing and adapter resolution
  // happened rather than failing with "provider not registered".
  let failure;
  try {
    await service.chatWithFailover({ model: 'llama3.2', messages: [] }, undefined);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof ProviderError, `expected a ProviderError, got ${failure}`);
  assert.doesNotMatch(failure.message, /not registered/i);
  assert.match(failure.code, /PROVIDER|UNAVAILABLE|TIMEOUT/);

  const routing = await service.describeRouting();
  assert.equal(routing.connections[0].providerId, 'ollama');
});

test('retryable classification keeps permanent failures out of the retry loop', () => {
  assert.equal(isRetryableFailure(new ProviderError('PROVIDER_TIMEOUT', 'x', { retryable: true })), true);
  assert.equal(isRetryableFailure(new ProviderError('RATE_LIMITED', 'x')), true);
  assert.equal(isRetryableFailure(new ProviderError('PROVIDER_UNAVAILABLE', 'x')), true);
  assert.equal(isRetryableFailure(new ProviderError('INVALID_REQUEST', 'x')), false);
  assert.equal(isRetryableFailure(new ProviderError('AUTHENTICATION_FAILED', 'x')), false);
  assert.equal(isRetryableFailure(new ProviderError('CANCELLED', 'x')), false);
  assert.equal(isRetryableFailure(new Error('boom')), false);
});

test('route resolution reports why a connection was skipped', () => {
  const health = new HealthRegistry();
  health.recordFailure('unhealthy', 'PROVIDER_UNAVAILABLE', 'down');
  health.recordFailure('unhealthy', 'PROVIDER_UNAVAILABLE', 'down');
  const connections = [
    { id: 'a', providerId: 'unhealthy', name: 'A', endpoint: 'https://a.example.com', priority: 1, proxyPool: 'none', enabled: true, hasCredential: true, modelPolicy: 'all', modelIds: ['m'], customModelIds: [], resilience: { timeoutMs: 0, maxRetries: 0, requestsPerMinute: 0 }, createdAt: '', updatedAt: '' },
    { id: 'b', providerId: 'limited', name: 'B', endpoint: 'https://b.example.com', priority: 2, proxyPool: 'none', enabled: true, hasCredential: true, modelPolicy: 'all', modelIds: ['m'], customModelIds: [], resilience: { timeoutMs: 0, maxRetries: 0, requestsPerMinute: 5 }, createdAt: '', updatedAt: '' },
    { id: 'c', providerId: 'ok', name: 'C', endpoint: 'https://c.example.com', priority: 3, proxyPool: 'none', enabled: true, hasCredential: true, modelPolicy: 'all', modelIds: ['m'], customModelIds: [], resilience: { timeoutMs: 0, maxRetries: 0, requestsPerMinute: 0 }, createdAt: '', updatedAt: '' },
    { id: 'd', providerId: 'off', name: 'D', endpoint: 'https://d.example.com', priority: 4, proxyPool: 'none', enabled: false, hasCredential: true, modelPolicy: 'all', modelIds: ['m'], customModelIds: [], resilience: { timeoutMs: 0, maxRetries: 0, requestsPerMinute: 0 }, createdAt: '', updatedAt: '' },
  ];
  const decision = resolveRoute({ connections, model: 'm', health, failureThreshold: 2, rateLimitWaitMs: new Map([['b', 5_000]]) });
  assert.deepEqual(decision.candidates.map((candidate) => candidate.providerId), ['ok']);
  assert.deepEqual(decision.skipped, [
    { providerId: 'unhealthy', reason: 'unhealthy' },
    { providerId: 'limited', reason: 'rate-limited' },
  ]);
});

test('the gateway reports failover attempts and accepts resilience updates over HTTP', async (t) => {
  const calls = [];
  const primary = chattyAdapter('primary', { calls, fail: async (id) => { if (id === 'primary') throw new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true }); } });
  const backup = chattyAdapter('backup', { calls });
  const store = await storeWith([{ id: 'primary', priority: 1, resilience: { maxRetries: 0 } }, { id: 'backup', priority: 2 }]);
  const service = buildService([primary, backup], store);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const created = await (await fetch(`${baseUrl}/v1/keys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Test' }) })).json();

  const completion = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${created.key}` },
    body: JSON.stringify({ model: 'shared/model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(completion.status, 200);
  const body = await completion.json();
  assert.equal(body.provider, 'backup');
  assert.deepEqual(body.gateway.attempts.map((attempt) => `${attempt.provider}:${attempt.ok ? 'ok' : attempt.error}`), ['primary:PROVIDER_UNAVAILABLE', 'backup:ok']);

  const updated = await fetch(`${baseUrl}/v1/connections/primary/resilience`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxRetries: 3, requestsPerMinute: 120, timeoutMs: 15_000, hedgeAfterMs: 400 }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).connection.resilience, { timeoutMs: 15_000, maxRetries: 3, requestsPerMinute: 120, hedgeAfterMs: 400 });

  const invalid = await fetch(`${baseUrl}/v1/connections/primary/resilience`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxRetries: 99 }),
  });
  assert.equal(invalid.status, 400);

  const invalidHedge = await fetch(`${baseUrl}/v1/connections/primary/resilience`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hedgeAfterMs: 60_000 }),
  });
  assert.equal(invalidHedge.status, 400);

  const empty = await fetch(`${baseUrl}/v1/connections/primary/resilience`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(empty.status, 400);

  const routing = await (await fetch(`${baseUrl}/v1/routing`)).json();
  assert.equal(routing.failureThreshold, 3);
  assert.equal(routing.connections.find((connection) => connection.providerId === 'primary').resilience.maxRetries, 3);
});
