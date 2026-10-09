import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { CredentialLifecycle } from '../dist/credential-lifecycle.js';
import { HealthManager } from '../dist/health.js';
import { ClineAdapter } from '@hilbras/omnihilbras';
import { ChatGptWebAdapter } from '@hilbras/omnihilbras';
import { ProviderError } from '@hilbras/omnihilbras';
import { providerIds } from './support/providerIds.js';

/**
 * `CredentialLifecycle`: the one question about a credential that needs no request.
 *
 * The saving is concrete rather than architectural. A ChatGPT Web health check *launches a browser*,
 * so a connection whose session ended was launching one on every sweep to be told what the stored
 * credential already said in writing. These tests are about the pre-check being right, and — more
 * importantly — about it being *wrong in the cheap direction only*.
 */

const NOW = 1_700_000_000_000;

const oauth = (expiresAt) => ({ type: 'oauth', value: 'token', ...(expiresAt ? { expiresAt } : {}) });
const apiKey = { type: 'api-key', value: 'k' };

function lifecycle({ adapter, now = NOW } = {}) {
  return new CredentialLifecycle({ adapterFor: () => adapter, now: () => now });
}

// ── what a credential can say about itself ─────────────────────────────────

test('a Cline credential past its expiry is expired, and says so without a request', () => {
  const adapter = new ClineAdapter();
  const past = new Date(NOW - 1_000).toISOString();
  assert.equal(lifecycle({ adapter }).standing('cline', oauth(past)).state, 'expired');
  // An hour later it is still expired, because it expired an hour before *that*.
  assert.equal(lifecycle({ adapter, now: NOW + 3_600_000 }).standing('cline', oauth(past)).state, 'expired');
  // And a credential that has not ended yet is not expired, which is the case a one-sided check
  // would get wrong.
  assert.equal(lifecycle({ adapter }).standing('cline', oauth(new Date(NOW + 60_000).toISOString())).state, 'valid');
});

test('a ChatGPT Web session past its expiry is expired, read out of the stored value', () => {
  // The expiry is inside the credential's JSON, so this is the case where parsing it wrongly would
  // eject a working connection.
  const adapter = new ChatGptWebAdapter({ driver: { available: async () => ({ ok: false }), ask: async () => ({ text: '' }) } });
  const credential = (expiresAt) => ({ type: 'api-key', value: JSON.stringify({ cookies: [{ name: '__Secure-next-auth.session-token', value: 't' }], ...(expiresAt ? { expiresAt } : {}) }) });
  assert.equal(lifecycle({ adapter }).standing('chatgpt-web', credential(new Date(NOW - 1_000).toISOString())).state, 'expired');
  assert.equal(lifecycle({ adapter }).standing('chatgpt-web', credential(new Date(NOW + 3_600_000).toISOString())).state, 'valid');
});

// ── the direction every uncertainty must resolve to ────────────────────────

test('everything uncertain resolves to "go and ask", never to "expired"', () => {
  // The asymmetry is the whole design. Three ways to be wrong, and only one is cheap: a credential
  // that is not expired when it is spends a request; a wrong guess that ejects a working connection
  // does not.
  const adapter = new ClineAdapter();
  const cases = [
    ['no credential at all', undefined],
    ['a credential with no expiry', oauth(undefined)],
    ['an api key, which has no expiry to check', apiKey],
    ['an expiry that is not a date', oauth('not-a-date')],
  ];
  for (const [what, credential] of cases) {
    assert.equal(lifecycle({ adapter }).standing('cline', credential).state, 'unknown', what);
  }
  assert.equal(lifecycle({ adapter: undefined }).standing('cline', oauth('2020-01-01T00:00:00.000Z')).state, 'unknown', 'a provider with no adapter is unknown, not expired');
});

test('an adapter whose expiry check throws is unknown, and never takes the sweep down', () => {
  // A provider's expiry check throwing is that provider's bug. Letting it escape would fail a
  // health sweep for every *other* provider because one of them misbehaved.
  const broken = { id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: false }, isCredentialExpired() { throw new Error('a provider bug'); } };
  assert.equal(lifecycle({ adapter: broken }).standing('p', oauth('2020-01-01T00:00:00.000Z')).state, 'unknown');
});

test('a provider with no expiry capability is asked anyway, because only it knows', () => {
  const plain = { id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: false } };
  const instance = lifecycle({ adapter: plain });
  assert.equal(instance.standing('p', apiKey).state, 'unknown');
  assert.equal(instance.needsNetworkCheck('p', apiKey), true, 'so the network check still happens, exactly as before');
});

test('only an expired credential skips the network check', () => {
  const adapter = new ClineAdapter();
  const instance = lifecycle({ adapter });
  assert.equal(instance.needsNetworkCheck('cline', oauth(new Date(NOW - 1).toISOString())), false);
  assert.equal(instance.needsNetworkCheck('cline', oauth(new Date(NOW + 60_000).toISOString())), true, 'a live credential may still have been revoked, so it is still checked');
  assert.equal(instance.needsNetworkCheck('cline', apiKey), true);
});

// ── what the user is told ─────────────────────────────────────────────────

test('an expired session is an authentication failure, not an unavailable provider', () => {
  // This is the difference that matters to the person reading it. A session that ended is fixed by
  // signing in again; a provider being unavailable is not fixed by anything they can do. Getting it
  // backwards sends them to wait for a provider that is perfectly healthy.
  const refusal = lifecycle({ adapter: new ClineAdapter() }).expiredRefusal('cline', { state: 'expired' });
  assert.equal(refusal.code, 'AUTHENTICATION_FAILED');
  assert.match(refusal.message, /expired/);
  assert.match(refusal.message, /Sign in again/, 'and says what to do about it');
  assert.equal(refusal.publicMessage, refusal.message, 'and the user is told the same thing the operator sees');
});

test('a refusal carries the provider it belongs to', () => {
  // Two connections can be expired at once, and "some session expired" does not say which.
  assert.equal(lifecycle({ adapter: new ClineAdapter() }).expiredRefusal('cline', { state: 'expired' }).providerId, 'cline');
});

// ── the saving, measured through the health path ──────────────────────────

test('an expired credential is reported without the provider being asked at all', async () => {
  // The point of the whole thing. The adapter's `healthCheck` here would throw, so a probe that
  // reached it would be visible; a probe that answers from the credential cannot have.
  let healthChecks = 0;
  const adapter = {
    id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: false },
    isCredentialExpired: () => true,
    async healthCheck() { healthChecks += 1; throw new ProviderError('PROVIDER_UNAVAILABLE', 'should never be reached'); },
  };
  const credential = oauth(new Date(NOW - 1).toISOString());
  const manager = new HealthManager({
    adapters: async () => [adapter],
    contextFor: async () => ({ credential }),
    credentialStanding: async (adapterId) => lifecycle({ adapter }).standing(adapterId, credential),
  }, { intervalMs: 0 });
  const report = await manager.refresh();
  assert.equal(healthChecks, 0, 'no request was spent to learn something the credential already said');
  assert.equal(report.providers[0].status, 'unavailable');
  assert.match(report.providers[0].message, /expired/, 'and the reason names the expiry rather than a provider fault');
});

test('a live credential is still checked over the network, because it may have been revoked', async () => {
  // The pre-check is a pre-check. A credential that is not expired can still be dead, and skipping
  // the check would report revoked sessions as healthy — the exact confidence-without-evidence
  // this project refuses elsewhere.
  let healthChecks = 0;
  const adapter = {
    id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: false },
    isCredentialExpired: () => false,
    async healthCheck() { healthChecks += 1; return { status: 'healthy', checkedAt: new Date(NOW).toISOString(), latencyMs: 4 }; },
  };
  const credential = oauth(new Date(NOW + 60_000).toISOString());
  const manager = new HealthManager({
    adapters: async () => [adapter],
    contextFor: async () => ({ credential }),
    credentialStanding: async (adapterId) => lifecycle({ adapter }).standing(adapterId, credential),
  }, { intervalMs: 0 });
  await manager.refresh();
  assert.equal(healthChecks, 1, 'the provider was still asked');
});

test('a source with no lifecycle answer is asked as it always was', async () => {
  // Optional on purpose, so an embedder that does not track expiry is unaffected — including a
  // *broken* answer, which must not stop the sweep.
  let healthChecks = 0;
  const adapter = {
    id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: false },
    async healthCheck() { healthChecks += 1; return { status: 'healthy', checkedAt: new Date(NOW).toISOString(), latencyMs: 4 }; },
  };
  const manager = new HealthManager({ adapters: async () => [adapter], contextFor: async () => ({ credential: apiKey }) }, { intervalMs: 0 });
  await manager.refresh();
  assert.equal(healthChecks, 1);
});

// ── the invariant ──────────────────────────────────────────────────────────

test('THE INVARIANT: the lifecycle names no provider', () => {
  const adapters = providerIds();
  const source = readFileSync(new URL('../src/credential-lifecycle.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const found = adapters.filter((id) => new RegExp("['\"`]" + id + "['\"`]").test(code));
  assert.deepEqual(found, [], `the lifecycle must name no provider, found: ${found.join(', ')}`);
});
