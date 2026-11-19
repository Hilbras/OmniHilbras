import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError, ProviderRegistry } from '../dist/src/core/index.js';
import { CredentialManager } from '../dist/src/core/credential-manager.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * An expired credential is renewed before it is sent, and refused honestly when it cannot be.
 *
 * `CredentialLifecycle.expiredRefusal()` existed for this and was called from nowhere on a request path, so the flow
 * was: send a token the credential itself said had ended, have the provider refuse it, and report the provider's
 * words as a provider error — the one message that does not tell the operator to sign in again. Reported as *"the
 * sign-in lasts about an hour"*.
 */

const capabilities = { chat: true, streaming: false, models: true, embeddings: false };
const resilience = { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 };
const past = () => new Date(Date.now() - 60_000).toISOString();
const request = () => ({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

async function serviceWith(adapter, credential) {
  const store = new InMemoryConnectionStore();
  await store.save(
    { id: 'c', providerId: 'p', name: 'c', endpoint: 'https://p.example/v1', priority: 1, proxyPool: 'none', enabled: true, modelPolicy: 'all', resilience, modelIds: ['m'] },
    credential,
  );
  return { store, service: new GatewayService(new ProviderRegistry().register({ id: 'p', name: 'P', capabilities, ...adapter }), store, store, new InMemoryApiKeyStore(), {}) };
}

test('a request made with an expired credential renews it first, and stores the rotated token', async () => {
  const seen = [];
  let renewed = false;
  const { store, service } = await serviceWith({
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
    isCredentialExpired(credential, now = Date.now()) {
      if (credential?.type !== 'oauth' || typeof credential.expiresAt !== 'string') return undefined;
      return Date.parse(credential.expiresAt) <= now;
    },
    async renewCredential() {
      renewed = true;
      return { type: 'oauth', value: 'access-new', refreshToken: 'refresh-rotated', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    },
    async chat(_request, context) {
      seen.push(context?.credential?.value);
      return { id: 'r', providerId: 'p', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
    },
  }, { type: 'oauth', value: 'access-old', refreshToken: 'refresh-old', expiresAt: past() });

  const answer = await service.chat('p', request(), undefined, undefined, 'c');

  assert.equal(answer.message.content, 'ok');
  assert.equal(renewed, true, 'the provider was asked with a token its own credential said had ended');
  assert.deepEqual(seen, ['access-new'], 'the request carried the renewed credential');
  assert.equal((await store.get('c'))?.refreshToken, 'refresh-rotated', 'the rotated refresh token never reached the vault');
});

test('a request whose credential cannot be renewed is refused with the expiry, not with a provider error', async () => {
  const { service } = await serviceWith({
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
    isCredentialExpired(credential, now = Date.now()) {
      if (credential?.type !== 'oauth' || typeof credential.expiresAt !== 'string') return undefined;
      return Date.parse(credential.expiresAt) <= now;
    },
    async chat() {
      throw new ProviderError('PROVIDER_REQUEST_FAILED', 'This was sent anyway.', { providerId: 'p' });
    },
  }, { type: 'oauth', value: 'access-old', refreshToken: 'refresh-old', expiresAt: past() });

  await assert.rejects(
    () => service.chat('p', request(), undefined, undefined, 'c'),
    (error) => {
      assert.equal(error.code, 'AUTHENTICATION_FAILED', 'an expired session was reported as a provider problem');
      assert.match(String(error.message), /session expired on/, 'the refusal does not name the expiry, so it reads like a bug');
      assert.match(String(error.message), /Sign in again/, 'the refusal does not say what fixes it');
      return true;
    },
  );
});

test('a probe still receives the stale credential instead of an error, because it is asking what it is', async () => {
  // Health and the renewal pass read credentials to report on them. Throwing there made a sweep die on the session it
  // was trying to describe — and, in `service.test.js`, surfaced as an unhandled rejection after the test had ended.
  const secrets = { get: async () => ({ type: 'oauth', value: 'stale', refreshToken: 'r', expiresAt: past() }) };
  const connections = { list: async () => [{ id: 'c', modelPolicy: 'all' }], get: async (id) => (id === 'c' ? { id: 'c', modelPolicy: 'all' } : undefined) };
  // Mirrors the service's callback: it renews, and when it cannot it either refuses or hands back what it read.
  const credentials = new CredentialManager(secrets, connections, async (_id, _provider, credential, { refuseWhenExpired }) => {
    if (refuseWhenExpired) throw new ProviderError('AUTHENTICATION_FAILED', 'This connection’s session expired. Sign in again.', { providerId: 'p' });
    return credential;
  });

  const refused = await credentials.context('c', 'p').then(() => 'resolved', (error) => error.code);
  assert.equal(refused, 'AUTHENTICATION_FAILED', 'a request path accepted an expired credential');

  const probe = await credentials.context('c', 'p', undefined, { refuseWhenExpired: false });
  assert.equal(probe.credential?.value, 'stale', 'a probe could not see the credential it was asked to describe');
});
