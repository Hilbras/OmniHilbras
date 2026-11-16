import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryConnectionStore } from '../dist/src/index.js';

/**
 * The renewal pass has to renew — and what it renews has to reach the vault.
 *
 * `TokenRenewal` is the only thing keeping an idle sign-in alive: the request path renews lazily on the way
 * through, so a connection nobody talks to for longer than its access token lives would otherwise drift past its
 * expiry and be discovered by the next real request. The pass existed, but it gated on `adapter.isCredentialExpired`
 * — four adapters do not implement that predicate, so no pass ever touched them — and `renewCredential` was cast to
 * `Promise<void>` at the call site, so a rotated refresh token could only reach the vault through the adapter's own
 * hook. A provider that rotates its refresh tokens leaves the stored one dead the moment it issues a new one, which
 * is what *"the sign-in lasts about an hour"* was.
 */

const capabilities = { chat: true, streaming: false, models: true, embeddings: false };
const resilience = { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 };

function save(store, id, priority, credential) {
  return store.save(
    { id, providerId: 'p', name: id, endpoint: 'https://p.example/v1', priority, proxyPool: 'none', enabled: true, modelPolicy: 'all', resilience, modelIds: ['m'] },
    credential,
  );
}

function registryFor(renewCredential, extra = {}) {
  return new ProviderRegistry().register({
    id: 'p',
    name: 'P',
    capabilities,
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
    ...(renewCredential ? { renewCredential } : {}),
    ...extra,
  });
}

const inTenMinutes = () => new Date(Date.now() + 10 * 60_000).toISOString();
const inThirtyDays = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();

test('the pass renews what expires inside the window, stores the rotated refresh token, and leaves the rest alone', async () => {
  const store = new InMemoryConnectionStore();
  await save(store, 'due', 1, { type: 'oauth', value: 'access-due', refreshToken: 'refresh-due', expiresAt: inTenMinutes() });
  await save(store, 'later', 2, { type: 'oauth', value: 'access-later', refreshToken: 'refresh-later', expiresAt: inThirtyDays });

  const renewed = [];
  const registry = registryFor(async (credential) => {
    renewed.push(credential.value);
    return { type: 'oauth', value: 'access-new', refreshToken: 'refresh-rotated', expiresAt: inTenMinutes() };
  });
  const service = new GatewayService(registry, store, store, undefined, {});

  await service.renewExpiringTokens();

  assert.deepEqual(renewed, ['access-due'], 'only the connection inside the window is renewed');
  assert.equal((await store.get('due'))?.refreshToken, 'refresh-rotated', 'the rotated refresh token never reached the vault');
  assert.equal((await store.get('later'))?.refreshToken, 'refresh-later', 'a connection outside the window was rewritten');
});

test('an adapter that cannot say whether the credential expired is still renewed, from the credential itself', async () => {
  // The four adapters this covers — claude-code, codex, kimi-code, opencode-console — implement no
  // `isCredentialExpired`, and the pass used to return before looking at them. claude-code's own comment calls its
  // tokens short-lived, so "the session lasts about an hour" was those providers never being renewed at all.
  const store = new InMemoryConnectionStore();
  await save(store, 'due', 1, { type: 'oauth', value: 'access-due', refreshToken: 'refresh-due', expiresAt: inTenMinutes() });

  const renewed = [];
  const registry = registryFor(async (credential) => {
    renewed.push(credential.value);
    return { type: 'oauth', value: 'access-new', refreshToken: 'refresh-rotated', expiresAt: inTenMinutes() };
  });
  const service = new GatewayService(registry, store, store, undefined, {});

  await service.renewExpiringTokens();

  assert.deepEqual(renewed, ['access-due'], 'the pass skipped an adapter that only states its expiry on the credential');
  assert.equal((await store.get('due'))?.refreshToken, 'refresh-rotated', 'the renewal was not stored');
});

test('a refused renewal on one account does not stop the pass, and does not rewrite its sibling', async () => {
  const store = new InMemoryConnectionStore();
  await save(store, 'dead', 1, { type: 'oauth', value: 'access-dead', refreshToken: 'refresh-dead', expiresAt: inTenMinutes() });
  await save(store, 'ok', 2, { type: 'oauth', value: 'access-ok', refreshToken: 'refresh-ok', expiresAt: inTenMinutes() });

  const renewed = [];
  const registry = registryFor(async (credential) => {
    renewed.push(credential.value);
    if (credential.value === 'access-dead') {
      throw new ProviderError('AUTHENTICATION_FAILED', 'This refresh token was already rejected; please re-authenticate.', { providerId: 'p' });
    }
    return { type: 'oauth', value: 'access-new', refreshToken: 'refresh-rotated', expiresAt: inTenMinutes() };
  });
  const service = new GatewayService(registry, store, store, undefined, {});

  await service.renewExpiringTokens();

  assert.deepEqual(renewed, ['access-dead', 'access-ok'], 'the pass stopped at the refused account');
  assert.equal((await store.get('dead'))?.refreshToken, 'refresh-dead', 'a refused renewal overwrote the stored credential');
  assert.equal((await store.get('ok'))?.refreshToken, 'refresh-rotated', 'the sibling account was never renewed');
});

test('the refused login is recorded against the account, not the provider', async () => {
  const store = new InMemoryConnectionStore();
  await save(store, 'dead', 1, { type: 'oauth', value: 'access-dead', refreshToken: 'refresh-dead', expiresAt: inTenMinutes() });
  await save(store, 'ok', 2, { type: 'oauth', value: 'access-ok', refreshToken: 'refresh-ok', expiresAt: inTenMinutes() });

  const registry = registryFor(async (credential) => {
    if (credential.value === 'access-dead') {
      throw new ProviderError('AUTHENTICATION_FAILED', 'This refresh token was already rejected; please re-authenticate.', { providerId: 'p' });
    }
    return credential;
  });
  const service = new GatewayService(registry, store, store, undefined, {});

  await service.renewExpiringTokens();

  const state = service.healthManager.snapshotRegistry();
  assert.match(state.snapshot('dead', 3).lastError, /sign-in again/, 'the row that needs a sign-in cannot say so');
  assert.equal(state.snapshot('p', 3), undefined, 'the provider was marked, so a healthy sibling reads as dead');
});
