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

test('the together and fireworks registrations are real OpenAI-compatible chat adapters', async () => {
  const expected = {
    together: 'api.together.xyz',
    fireworks: 'api.fireworks.ai',
  };
  for (const [id, host] of Object.entries(expected)) {
    const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['router-model'] });
    const adapter = OWN_PROVIDER_ADAPTERS[id].create({ transport });
    assert.equal(adapter.id, id);
    assert.equal(OWN_PROVIDER_ADAPTERS[id].validation, 'none', `${id} must declare why Check cannot prove a public-catalog key`);
    const response = await adapter.chat({ model: 'router-model', messages: [{ role: 'user', content: 'ping' }] }, { credential: { type: 'api-key', value: 'key' } });
    assert.ok(response.message, `${id} did not answer a scripted chat turn`);
    const chatCall = transport.seen.find((call) => /chat\/completions/.test(call.url));
    assert.ok(chatCall, `${id} never sent a chat request`);
    assert.equal(new URL(chatCall.url).hostname, host);
    assert.match(chatCall.body ?? '', /router-model/, `${id} dropped the requested model`);
  }
});

test('a bogus key is refused by every provider that declares a credential check', async () => {
  // The scripted transport answers 401 to everything, which is what a real vendor answers for a key
  // nobody owns. A Check that still reports green here would be the false pass this file exists for.
  const credentialIds = ids.filter((id) => service.providers.validationStrategy(id) === 'credential');
  assert.ok(credentialIds.length >= 10, `only ${credentialIds.length} credential strategies were found; the guard would pass vacuously`);
  for (const id of credentialIds) {
    const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['public-model'] });
    transport.set([], { refuseWith: 401 });
    const scripted = new GatewayService(
      new ProviderRegistry(),
      new InMemorySecretStore({}),
      new InMemoryConnectionStore(),
      new InMemoryApiKeyStore(),
      { transport },
    );
    await assert.rejects(
      scripted.validateConnectionCredential(id, { type: 'api-key', value: 'bogus-key' }),
      (error) => error.code === 'AUTHENTICATION_FAILED' || error.code === 'NOT_SUPPORTED',
      `${id} accepted a bogus key`,
    );
  }
});

test('a public model catalog is never the sole proof of a candidate key', async () => {
  // A `/models` list that answers 200 for any string is not evidence. Providers that cannot prove a
  // key declare `none`, and the gateway refuses a Check before making a request at all — no adapter
  // is allowed to quietly fall back to "the catalog answered, so the key is good".
  for (const id of ids.filter((candidate) => service.providers.validationStrategy(candidate) === 'none')) {
    const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['public-model'] });
    const scripted = new GatewayService(
      new ProviderRegistry(),
      new InMemorySecretStore({}),
      new InMemoryConnectionStore(),
      new InMemoryApiKeyStore(),
      { transport },
    );
    await assert.rejects(
      scripted.validateConnectionCredential(id, { type: 'api-key', value: 'bogus-key' }),
      (error) => error.code === 'NOT_SUPPORTED',
      `${id} accepted a key on a public catalog`,
    );
    assert.equal(transport.seen.length, 0, `${id} sent a key-check request although it declared no check`);
  }
});
