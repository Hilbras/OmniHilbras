import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError as CoreProviderError, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';
// The adapter's **own** copy of the class, which is the point of this file: an adapter lives in its own
// package with its own `ProviderError`, and `instanceof` is false across that boundary.
import { ProviderError as SdkProviderError } from '@omnihilbras/sdk-zcode-start-plan/dist/lib/errors.js';

/**
 * An error from an adapter package must be recognised as a provider error.
 *
 * This is the bug behind "first account has no quota, second works, and it errors anyway" — and it
 * survived two previous attempts to fix the rotation, because every test used the *core* `ProviderError`
 * while the real adapter throws its *own* copy of the class.
 *
 * `routing.ts` guarded its rules with `error instanceof ProviderError`. Across the package boundary that
 * is `false`, so `isRetryableFailure` returned `false` and `shouldRotateAccount` returned `false` for
 * every error a real adapter raised — and `RetryPolicy.afterFailure` therefore answered `stop` on the
 * first attempt. Measured on the live gateway before this fix: a pinned exhausted ZCode account
 * produced a one-entry ledger (`zcode:PROVIDER_REQUEST_FAILED`) and the working sibling was never
 * asked. The codebase already had the portable check for exactly this reason — `isProviderError` tests
 * `name === 'ProviderError'` and a string `code` — it simply was not used on these paths.
 */

test('the adapter copy of ProviderError is a different class, which is why this matters', () => {
  const foreign = new SdkProviderError('PROVIDER_REQUEST_FAILED', 'nope');
  assert.equal(foreign instanceof CoreProviderError, false, 'the two packages really do hold different classes');
  assert.equal(foreign.name, 'ProviderError', 'and the portable check is what bridges them');
  assert.equal(typeof foreign.code, 'string');
});

const answer = (key, request) => ({
  id: 'r',
  providerId: 'p',
  model: request.model,
  createdAt: new Date().toISOString(),
  message: { role: 'assistant', content: `by ${key}` },
  finishReason: 'stop',
});

/**
 * Two accounts, the first saved under the provider id, and the adapter refusing with an error built by
 * the **SDK's** class — exactly what ZCode does.
 */
async function serviceWithForeignErrors() {
  const seen = [];
  const registry = new ProviderRegistry();
  registry.register({
    id: 'p',
    name: 'P',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
    async chat(request, context) {
      const key = context?.credential?.value;
      seen.push(key);
      if (key === 'spent') {
        // The shape ZCode actually raises: no HTTP status, the wording in the message and the details.
        throw new SdkProviderError('PROVIDER_REQUEST_FAILED', 'ZCode refused the turn: exceed quota limit', {
          providerId: 'p',
          publicMessage: 'ZCode refused the turn: exceed quota limit',
          details: { providerMessage: 'exceed quota limit' },
        });
      }
      return answer(key, request);
    },
    async *streamChat() {},
  });
  const store = new InMemoryConnectionStore();
  const connection = (id, priority) => ({ id, providerId: 'p', name: id, endpoint: 'https://p.example/v1', priority, proxyPool: 'none', modelIds: ['m'], resilience: { maxRetries: 0 } });
  await store.save(connection('p', 1), { type: 'api-key', value: 'spent' });
  await store.save(connection('p-second', 2), { type: 'api-key', value: 'working' });
  return { seen, service: new GatewayService(registry, store, store, new InMemoryApiKeyStore(), { failureThreshold: 2 }) };
}

test('an adapter-package quota refusal rotates to the sibling account', async () => {
  const { seen, service } = await serviceWithForeignErrors();
  const outcome = await service.chatWithFailover(
    { model: 'm', messages: [{ role: 'user', content: 'hi' }], connectionId: 'p' },
    'p',
    new AbortController().signal,
  );
  assert.deepEqual(seen, ['spent', 'working'], 'the refused account first, then the working one');
  assert.match(outcome.response.message.content, /working/, 'and the working account served it');
  assert.deepEqual(
    outcome.attempts.map((attempt) => `${attempt.connectionId}:${attempt.ok ? 'ok' : attempt.errorCode}`),
    ['p:PROVIDER_REQUEST_FAILED', 'p-second:ok'],
    'the ledger names both accounts, and keeps the provider\'s own code',
  );
});

test('an adapter-package error keeps its own code instead of a guessed one', async () => {
  // `error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED'` replaced a real code with
  // a guess for every adapter-package error — so a genuine RATE_LIMITED read as a generic failure and
  // took the wrong branch.
  const registry = new ProviderRegistry();
  registry.register({
    id: 'q',
    name: 'Q',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'm', providerId: 'q' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
    async chat() { throw new SdkProviderError('RATE_LIMITED', 'slow down'); },
    async *streamChat() {},
  });
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'q', providerId: 'q', name: 'q', endpoint: 'https://q.example/v1', priority: 1, proxyPool: 'none', modelIds: ['m'], resilience: { maxRetries: 0 } }, { type: 'api-key', value: 'k' });
  const service = new GatewayService(registry, store, store, new InMemoryApiKeyStore());
  const failure = await service.chatWithFailover({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, 'q', new AbortController().signal).then(() => null, (error) => error);
  assert.ok(failure, 'the request failed, as it must');
  assert.equal(failure.code, 'RATE_LIMITED', 'the provider\'s own code, not PROVIDER_REQUEST_FAILED');
});
