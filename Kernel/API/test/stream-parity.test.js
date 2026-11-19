import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError } from '../dist/src/core/index.js';
import { RequestExecutor } from '../dist/src/core/request-executor.js';

/**
 * A stream must walk the same route chain as a non-streaming request, up to the first byte.
 *
 * The stream loop was written separately and had drifted: a limiter refusal threw instead of moving
 * on, the circuit breaker was never consulted, and a provider 429 recorded no model cooldown. These
 * tests describe the shared policy in the terms the chat path already uses.
 */

const candidates = [
  { providerId: 'a', connectionId: 'a', priority: 1, resilience: { maxRetries: 0, requestsPerMinute: 100, timeoutMs: 5_000, hedgeAfterMs: 0 } },
  { providerId: 'b', connectionId: 'b', priority: 2, resilience: { maxRetries: 0, requestsPerMinute: 100, timeoutMs: 5_000, hedgeAfterMs: 0 } },
];

function executor(config = {}) {
  const dispatched = [];
  const cooled = [];
  const breaker = { allowed: [], successes: [], failures: [], abandoned: [], refuseFor: undefined, ...config.breaker };
  const instance = new RequestExecutor({
    planRoute: async () => ({ candidates, skipped: [] }),
    chat: async (providerId, request) => ({ id: 'r', providerId, model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }),
    streamChat: async function* (providerId, request) {
      dispatched.push(`${providerId}:${request.model}`);
      const error = config.fail?.(providerId);
      if (error) throw error;
      yield { id: 'c', providerId, model: request.model, delta: { content: 'ok' } };
    },
    withDeadline: (signal, _ms, _id, run) => run(signal),
    enforceRateLimit: (candidate) => { config.enforce?.(candidate); },
    breaker: {
      allows: (id) => { breaker.allowed.push(id); return id !== breaker.refuseFor; },
      recordSuccess: (id) => breaker.successes.push(id),
      recordFailure: (id) => breaker.failures.push(id),
      recordAbandoned: (id) => breaker.abandoned.push(id),
    },
    recordRateLimitUse: () => {},
    recordSuccess: () => {},
    recordFailure: () => {},
    recordModelRateLimit: (providerId, modelId, _input, connectionId) => cooled.push({ providerId, modelId, connectionId }),
  });
  return { instance, dispatched, cooled, breaker };
}

const request = { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true };
const consume = async (outcome) => { for await (const _chunk of outcome.chunks) { /* drain */ } };

test('a stream refused by the limiter is handed to the next route', async () => {
  const { instance, dispatched } = executor({
    enforce: (candidate) => { if (candidate.providerId === 'a') throw new ProviderError('RATE_LIMITED', 'limited'); },
  });
  const outcome = await instance.stream(request, undefined);
  await consume(outcome);
  assert.deepEqual(dispatched, ['b:m'], 'the stream was ended instead of trying the sibling');
  assert.deepEqual(outcome.attempts.map((attempt) => attempt.connectionId), ['a', 'b']);
  assert.equal(outcome.attempts[0]?.errorCode, 'RATE_LIMITED');
});

test('an open breaker is skipped without a dispatch', async () => {
  const { instance, dispatched, breaker } = executor({ breaker: { refuseFor: 'a' } });
  const outcome = await instance.stream(request, undefined);
  await consume(outcome);
  assert.deepEqual(dispatched, ['b:m']);
  assert.deepEqual(breaker.allowed, ['a', 'b']);
  assert.equal(outcome.attempts[0]?.errorCode, 'CIRCUIT_OPEN');
});

test('a streamed 429 cools the model for that connection', async () => {
  const { instance, cooled, dispatched } = executor({
    fail: (providerId) => providerId === 'a' ? new ProviderError('RATE_LIMITED', 'limited', { retryable: true }) : undefined,
  });
  const outcome = await instance.stream(request, undefined);
  await consume(outcome);
  assert.deepEqual(dispatched, ['a:m', 'b:m']);
  assert.deepEqual(cooled, [{ providerId: 'a', modelId: 'm', connectionId: 'a' }], 'the refused model was not cooled');
});

test('a cancelled stream releases its half-open probe', async () => {
  const controller = new AbortController();
  const { instance, breaker } = executor({
    fail: () => new ProviderError('CANCELLED', 'The request was cancelled.'),
  });
  controller.abort();
  await assert.rejects(() => instance.stream(request, undefined, controller.signal));
  assert.deepEqual(breaker.abandoned, ['a'], 'the half-open probe was left in flight');
});
