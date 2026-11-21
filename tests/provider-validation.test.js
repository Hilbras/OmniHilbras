import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../Kernel/API/dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../Kernel/API/dist/src/core/index.js';
import { OWN_PROVIDER_ADAPTERS } from '../Kernel/API/dist/src/core/own-provider-adapters.js';
import { scriptedTransport } from '../Kernel/SDK/tests/harness/scripted-transport.js';

/**
 * A Check button that reports green for a key nobody proved is worse than one that refuses: the
 * dashboard is where a person pastes a credential, and a false pass there is believed. This guard
 * makes the two decisions explicit at the registration boundary: what a provider may check, and
 * whether the adapter it builds actually uses the gateway's transport rather than the SDK default.
 */

function gateway() {
  return new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), new InMemoryApiKeyStore(), {});
}

const service = gateway();
const ids = service.providers.onDemandIds();

test('every on-demand registration states what a Check may prove', () => {
  assert.ok(ids.length > 40, 'the guard must see the real registration set, not an empty resolver');
  for (const id of ids) {
    assert.equal(service.providers.hasDeclaredValidation(id), true, `${id} inherited 'none' instead of declaring it`);
  }
});

test('a declared credential check has a real validator behind it', async () => {
  for (const id of ids) {
    if (service.providers.validationStrategy(id) !== 'credential') continue;
    const adapter = await service.providers.resolve(id);
    assert.equal(typeof adapter.validateCredential, 'function', `${id} claims a credential check it cannot perform`);
  }
});

test('an authenticated-catalog check needs an evidence entry, not an assumption', () => {
  // No provider has a measured, authenticated-only catalog today. Adding one is fine, but it has to
  // be a decision with a reason in this list — the NVIDIA lesson is that a public /models endpoint
  // answers 200 for a bogus key and looks exactly like a successful check.
  const withEvidence = new Set();
  const undeclared = ids.filter((id) => service.providers.validationStrategy(id) === 'models' && !withEvidence.has(id));
  assert.deepEqual(undeclared, [], 'a catalog-only check without a measurement would accept any key');
});

test('every own-provider factory forwards the gateway transport', async () => {
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: [] });
  for (const [id, entry] of Object.entries(OWN_PROVIDER_ADAPTERS)) {
    const adapter = entry.create({ transport });
    assert.equal(adapter.transport, transport, `${id} built its own transport and lost the gateway deadline`);
  }
  for (const id of Object.keys(OWN_PROVIDER_ADAPTERS)) {
    const adapter = await service.providers.resolve(id);
    assert.equal(adapter.transport, service.transport, `${id} is registered without the gateway transport`);
  }
});
