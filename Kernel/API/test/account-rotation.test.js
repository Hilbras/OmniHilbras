import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryConnectionStore } from '../dist/src/index.js';
import { shouldRotateAccount } from '../dist/src/core/routing.js';
import { InMemoryApiKeyStore } from '../dist/src/index.js';

/**
 * Accounts are tried one by one, and an exhausted account is not the request's failure.
 *
 * Reported as: "when I test the models it tests the account one by one, so when the first fails, the
 * second fails, the third works — the third should serve." It did not, for two independent reasons:
 *
 * 1. A pinned account **confined** routing to itself (`explicitConnectionId` filtered the candidates),
 *    so a model test pinned to an exhausted account could only report the failure.
 * 2. A refusal that was not literally `RATE_LIMITED` was terminal. Aggregators report an exhausted
 *    plan as `422`/`400` with `insufficient_quota` in the body, so the next account was never asked.
 *
 * The reference implementation solved both with one loop (`src/sse/handlers/chat.js`): keep an
 * `excludeConnectionIds` set, ask for the next account after each refusal, and decide "refusal" from
 * the provider's **wording first, status second** (`ERROR_RULES` in its `errorConfig.js`). These tests
 * pin that shape.
 */

function provider(behaviour) {
  const registry = new ProviderRegistry();
  registry.register({
    id: 'p',
    name: 'P',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
    async chat(request, context) { return behaviour(context?.credential?.value, request); },
    async *streamChat() {},
  });
  return registry;
}

const answer = (key, request) => ({
  id: 'r',
  providerId: 'p',
  model: request.model,
  createdAt: new Date().toISOString(),
  message: { role: 'assistant', content: `by ${key}` },
  finishReason: 'stop',
});

const account = (id, priority) => ({
  id,
  providerId: 'p',
  name: id,
  endpoint: 'https://p.example/v1',
  priority,
  proxyPool: 'none',
  modelIds: ['m'],
  // No retry budget, so a failure moves to the next *account* rather than repeating this one.
  resilience: { maxRetries: 0 },
});

async function threeAccounts(behaviour) {
  const store = new InMemoryConnectionStore();
  await store.save(account('account-a', 1), { type: 'api-key', value: 'key-A' });
  await store.save(account('account-b', 2), { type: 'api-key', value: 'key-B' });
  await store.save(account('account-c', 3), { type: 'api-key', value: 'key-C' });
  return { store, service: new GatewayService(provider(behaviour), store, store, {}) };
}

const chat = (extra = {}) => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra });
const signal = () => new AbortController().signal;

test('first fails, second fails, third serves — and the ledger names each account', async () => {
  const seen = [];
  const { service } = await threeAccounts((key, request) => {
    seen.push(key);
    if (key === 'key-A') throw new ProviderError('RATE_LIMITED', 'Account A is out.', { providerId: 'p', statusCode: 429, retryable: true });
    // The case that used to stop the chain: a 422 whose *body* says the plan is exhausted.
    if (key === 'key-B') throw new ProviderError('PROVIDER_REQUEST_FAILED', 'The provider rejected the request.', { providerId: 'p', statusCode: 422, details: { providerMessage: 'insufficient_quota: your plan is exhausted' } });
    return answer(key, request);
  });

  const outcome = await service.chatWithFailover(chat(), undefined, signal());
  assert.deepEqual(seen, ['key-A', 'key-B', 'key-C'], 'each account is asked once, in order, until one answers');
  assert.match(outcome.response.message.content, /key-C/);
  assert.deepEqual(
    outcome.attempts.map((attempt) => `${attempt.connectionId}:${attempt.ok ? 'ok' : attempt.errorCode}`),
    ['account-a:RATE_LIMITED', 'account-b:PROVIDER_REQUEST_FAILED', 'account-c:ok'],
  );
});

test('a pinned account is spent first, and hands over when it refuses', async () => {
  const seen = [];
  const { service } = await threeAccounts((key, request) => {
    seen.push(key);
    // A is healthy but must NOT be spent: the caller asked for B. B refuses; C answers.
    if (key === 'key-B') throw new ProviderError('RATE_LIMITED', 'Account B is out.', { providerId: 'p', statusCode: 429, retryable: true });
    return answer(key, request);
  });

  const outcome = await service.chatWithFailover(chat({ connectionId: 'account-b' }), undefined, signal());
  // B first even though A has the better priority — the pin outranks priority — then the siblings in
  // their own order, which here means A before C. The pinned account goes first, not first-and-only.
  assert.deepEqual(seen, ['key-B', 'key-A'], 'the pinned account first, then its siblings');
  assert.match(outcome.response.message.content, /key-A/, 'the first sibling with quota answered');
});

test('the quota vocabulary rotates the account; a plain bad request does not', () => {
  const said = (providerMessage, statusCode = 400) =>
    new ProviderError('PROVIDER_REQUEST_FAILED', 'The provider rejected the request.', { providerId: 'p', statusCode, details: { providerMessage } });

  // Exhausted allowance, however the provider wrapped it.
  for (const wording of [
    'insufficient_quota',
    'insufficient quota',
    'You exceeded your current quota',
    'quota exceeded',
    'Rate limit reached for gpt',
    'too many requests',
    'insufficient balance',
    'Your credit balance is too low',
    'capacity exceeded',
    'The model is overloaded',
    /**
     * The real one, taken from ZCode. This is the sentence that was NOT rotating and is the whole
     * reason the phrase list became a rule: "quota exceeded" was on the list, "exceed quota limit" —
     * the wording ZCode actually uses, inside a `200` and inside an SSE error event — was not. The
     * account stayed terminal, so its siblings were never asked and the model test always failed on
     * the first account. Note it arrives with **no status code at all**.
     */
    'ZCode refused the turn: 1005 exceed quota limit',
    'The ZCode stream returned an error: 1005 exceed quota limit',
  ]) {
    assert.equal(shouldRotateAccount(said(wording)), true, `${wording} is about the account`);
  }

  // A quota word with no scarcity word beside it is about something else.
  assert.equal(shouldRotateAccount(said('unknown field: quota')), false);
  assert.equal(shouldRotateAccount(said('the quota header is malformed')), false);

  // The request is the problem: another account would refuse it identically, and cooling a healthy
  // account over a bad body removes it from rotation for everyone.
  assert.equal(shouldRotateAccount(said('model does not exist in this catalog')), false);
  assert.equal(shouldRotateAccount(new ProviderError('INVALID_REQUEST', 'messages is required.', { publicMessage: 'messages is required.' })), false);
  assert.equal(shouldRotateAccount(new ProviderError('NOT_SUPPORTED', 'no embeddings', { publicMessage: 'no embeddings' })), false);
  assert.equal(shouldRotateAccount(new ProviderError('CANCELLED', 'The request was cancelled.', {})), false);

  // The allowance is gone: the account is spent, the request is fine, a sibling answers.
  for (const status of [402, 403, 404, 429, 500, 503]) {
    assert.equal(shouldRotateAccount(said('', status)), true, `${status} is about the account`);
  }

  /**
   * A dead credential is **not** the allowance, and deliberately does not rotate.
   *
   * Rotating would succeed, and would quietly bill a sibling for every request while the operator's
   * broken account stays broken and invisible. The failure belongs to the account that owns the key.
   */
  for (const status of [401, 400, 422]) {
    assert.equal(shouldRotateAccount(said('', status)), false, `${status} with no quota wording is not the allowance`);
  }
  assert.equal(shouldRotateAccount(new ProviderError('AUTHENTICATION_FAILED', 'The credential was refused.', { providerId: 'p', statusCode: 401 })), false);

  // …unless the provider says in words that the account has no allowance left, whatever the status.
  // This is the case that was reported: an exhausted plan answered as 422 with `insufficient_quota`.
  assert.equal(shouldRotateAccount(said('insufficient_quota: your plan is exhausted', 422)), true);
  assert.equal(shouldRotateAccount(said('You have exceeded your current quota', 403)), true);
});

test('an account restriction stops the walk instead of moving to the sibling', async () => {
  /**
   * Reported from the field, CodeBuddy's own refusal:
   *
   *   HTTP 503 ← [codebuddy-intl/deepseek-v4.1-flash] [403]:
   *   {"code":11140,"msg":"request illegal","displayMsg":{"en":"Your account has been restricted due to
   *    unusual activity","zh":"账号存在异常行为,已被限制使用"}}
   *
   * A `403` used to be classified "the allowance is gone" and rotated to the next account — through the
   * same IDE fingerprint, from the same address, one request later. That is the pattern the provider is
   * objecting to, so rotating spreads the restriction rather than routing around it.
   */
  const seen = [];
  const { service } = await threeAccounts((key, request) => {
    seen.push(key);
    if (key === 'key-A') {
      throw new ProviderError('PROVIDER_REQUEST_FAILED', 'The provider refused the request.', {
        providerId: 'p',
        statusCode: 403,
        details: {
          providerMessage: '{"code":11140,"msg":"request illegal","displayMsg":{"en":"Your account has been restricted due to unusual activity","zh":"账号存在异常行为,已被限制使用"}}',
        },
      });
    }
    return answer(key, request);
  });

  const failure = await service
    .chatWithFailover(chat(), undefined, signal())
    .then(() => null, (error) => error);

  assert.ok(failure, 'the request fails: the provider refused this account');
  assert.deepEqual(seen, ['key-A'], 'and no sibling was asked through the same fingerprint');
  assert.equal((failure.details?.attempts ?? []).length, 1, 'the ledger shows a single attempt');
});

test('a restricted account is stood down for that model, not asked again next request', async () => {
  let now = 1_000_000;
  const seen = [];
  const registry = new ProviderRegistry();
  registry.register({
    id: 'p',
    name: 'P',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
    async chat(request, context) {
      seen.push(context?.credential?.value);
      throw new ProviderError('PROVIDER_REQUEST_FAILED', 'The provider refused the request.', {
        providerId: 'p',
        statusCode: 403,
        details: { providerMessage: 'request illegal: your account has been restricted due to unusual activity' },
      });
    },
    async *streamChat() {},
  });
  const store = new InMemoryConnectionStore();
  await store.save(account('account-a', 1), { type: 'api-key', value: 'key-A' });
  const service = new GatewayService(registry, store, store, new InMemoryApiKeyStore(), { failureThreshold: 2, now: () => now });

  await service.chatWithFailover(chat(), undefined, signal()).catch(() => {});
  assert.equal(seen.length, 1, 'first request reached the account');

  // The account is cooling, so the next request does not ask the same restricted session again.
  const plan = await service.planRoute('m');
  assert.deepEqual(plan.skipped.map((entry) => entry.reason), ['model-cooling-down'], 'the pair is cooling down');

  now += 61_000;
  await service.chatWithFailover(chat(), undefined, signal()).catch(() => {});
  assert.equal(seen.length, 2, 'and it is tried again once the cool-down expires');
});

test('the restriction wording is recognised in both languages, and not confused with a plan ceiling', () => {
  const restricted = (providerMessage) => new ProviderError('PROVIDER_REQUEST_FAILED', 'The provider refused the request.', { providerId: 'p', statusCode: 403, details: { providerMessage } });
  for (const wording of [
    'request illegal',
    'Your account has been restricted due to unusual activity',
    '账号存在异常行为,已被限制使用',
    'account suspended',
  ]) {
    assert.equal(shouldRotateAccount(restricted(wording)), false, `${wording} stops the walk`);
  }
  // A 403 that is about the allowance still rotates: the two are different answers.
  assert.equal(shouldRotateAccount(restricted('insufficient_quota: your plan is exhausted')), true);
  assert.equal(shouldRotateAccount(restricted('')), true, 'and a bare 403 keeps its old meaning');
});
