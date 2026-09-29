import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { ModelCatalog } from '../dist/model-catalog.js';
import { ConnectionManager } from '../dist/connection-manager.js';
import { ProviderError } from '@hilbras/omnihilbras';

/**
 * `ModelCatalog`: what this gateway serves, and which provider serves what.
 *
 * The interesting part is not the list — it is `resolveProviderId`, where each step is a different
 * kind of certainty, and where the last step is a refusal to guess.
 */

const credential = { type: 'api-key', value: 'k' };

const connection = (over = {}) => ({
  id: 'c1', providerId: 'p', name: 'P', endpoint: 'https://p.invalid',
  enabled: true, hasCredential: true, modelIds: [], priority: 1,
  resilience: { timeoutMs: 1000, maxRetries: 0, requestsPerMinute: 0, hedgeAfterMs: 0 },
  ...over,
});

/** An adapter that lists models, and records the context it was asked in. */
function adapter(id, { models = [{ id: 'm1' }], chat = true, canList = true, discover } = {}) {
  const asked = [];
  return {
    id,
    name: `${id} provider`,
    asked,
    capabilities: { chat, streaming: false, models: canList },
    async listModels(context) { asked.push(context); return models; },
    ...(discover ? { async discoverModels(context, options) { asked.push({ context, options }); return discover; } } : {}),
  };
}

function catalog({ connections = [], adapters = [], defaultProviderId = 'fallback' } = {}) {
  const store = new ConnectionManager(
    {
      async list() { return connections; },
      async save(input) { return input; },
      async remove() { return true; },
      async updateModels(id, ids) { return { id, modelIds: ids }; },
      async updateResilience(id) { return { id }; },
    },
    { lock: async (op) => op(), canValidate: () => false, validate: async () => {}, discover: async () => [], readCredential: async () => undefined, noteDiscoveryFailure: () => {} },
  );
  const seen = [];
  const instance = new ModelCatalog({
    connections: store,
    credentials: { contextForProvider: async (providerId, signal) => { seen.push([providerId, signal]); return { credential, ...(signal ? { signal } : {}) }; } },
    resolveAdapter: async (providerId) => adapters.find((item) => item.id === providerId),
    activeAdapters: async () => adapters,
    defaultProviderId,
  });
  return { instance, seen, adapters };
}

// ── what a client is shown ────────────────────────────────────────────────

test('a saved catalogue is what clients see, not what a provider could serve', async () => {
  // A provider's full inventory includes paid tiers the connection has no entitlement to, and
  // advertising them turns every one into a request that fails at the provider instead of a model
  // the client never asks for.
  const { instance, adapters } = catalog({
    connections: [connection({ providerId: 'p', modelIds: ['imported'] })],
    adapters: [adapter('p', { models: [{ id: 'everything-they-sell' }] })],
  });
  const list = await instance.listAll();
  assert.deepEqual(list.models, [{ id: 'imported', providerId: 'p' }]);
  assert.deepEqual(list.unavailable, []);
  assert.equal(adapters[0].asked.length, 0, 'no provider is asked, so none is billed for it');
});

test('a connection without a credential or switched off contributes nothing', async () => {
  // A disabled or uncredentialed connection serves nothing, so offering its models would be a lie
  // the client finds out about by sending a request. My first version of this fixture left the
  // first connection enabled *and* credentialed and then asserted an empty list, which failed
  // because the code was right and the fixture was not.
  const { instance } = catalog({
    connections: [
      connection({ id: 'a', modelIds: ['usable'] }),
      connection({ id: 'b', modelIds: ['no-credential'], hasCredential: false }),
      connection({ id: 'c', modelIds: ['disabled'], enabled: false }),
    ],
  });
  const list = await instance.listAll();
  assert.deepEqual(list.models, [{ id: 'usable', providerId: 'p' }]);
  assert.equal(list.models.some((model) => model.id === 'disabled' || model.id === 'no-credential'), false);
});

test('with nothing saved, the adapters are asked directly', async () => {
  // Not a convenience fallback: it is the only way an embedded service, which has a registry and no
  // connection store, can answer the question at all.
  const { instance, seen } = catalog({ adapters: [adapter('a'), adapter('b', { models: [{ id: 'm2' }] })] });
  const list = await instance.listAll();
  assert.deepEqual(list.models, [{ id: 'm1' }, { id: 'm2' }]);
  assert.deepEqual(seen.map(([providerId]) => providerId), ['a', 'b']);
});

test('one provider failing does not take the list down with it', async () => {
  const broken = adapter('broken');
  broken.listModels = async () => { throw new ProviderError('PROVIDER_UNAVAILABLE', 'down'); };
  const { instance } = catalog({ adapters: [broken, adapter('working', { models: [{ id: 'm' }] })] });
  const list = await instance.listAll();
  assert.deepEqual(list.models, [{ id: 'm' }], 'the other provider still answers');
  // Reported rather than omitted, so the dashboard can say *this provider offers nothing right now*
  // instead of leaving a card blank and letting the operator wonder whether the toggle worked.
  assert.deepEqual(list.unavailable, [{ providerId: 'broken', code: 'PROVIDER_UNAVAILABLE' }]);
});

test('a provider that cannot list models is reported as unsupported, not as empty', async () => {
  const { instance } = catalog({ adapters: [adapter('silent', { canList: false })] });
  const list = await instance.listAll();
  assert.deepEqual(list.models, []);
  assert.deepEqual(list.unavailable, [{ providerId: 'silent', code: 'NOT_SUPPORTED' }]);
});

test('one provider refusing does not name it as unavailable', () => {
  // Present, and listed with its models: an empty list with no explanation is indistinguishable
  // from a provider that genuinely offers nothing.
  return catalog({ connections: [connection({ providerId: 'p', modelIds: [] })] }).instance.listAll().then((list) => {
    assert.deepEqual(list.models, []);
    assert.deepEqual(list.unavailable, [], 'nothing is wrong with a provider that simply has no models yet');
  });
});

// ── which provider serves a model ─────────────────────────────────────────

test('a provider the caller named is not overruled', async () => {
  const { instance } = catalog({ connections: [connection({ providerId: 'p', modelIds: ['m'] })] });
  assert.equal(await instance.resolveProviderId('m', 'named'), 'named', 'the caller knowing better is not this method’s job to correct');
});

test('one saved connection owning a model is unambiguous', async () => {
  const { instance } = catalog({ connections: [connection({ providerId: 'solo', modelIds: ['m'] })] });
  assert.equal(await instance.resolveProviderId('m'), 'solo');
});

test('when several own it, a chat-capable one wins', async () => {
  // Owning a model in a catalog is not the same as being able to answer it, and a model that routes
  // to an embeddings-only connection fails for a reason nobody can see from the catalog.
  const { instance } = catalog({
    connections: [connection({ id: 'a', providerId: 'embeddings', modelIds: ['m'] }), connection({ id: 'b', providerId: 'chatter', modelIds: ['m'] })],
    adapters: [adapter('embeddings', { chat: false }), adapter('chatter', { chat: true })],
  });
  assert.equal(await instance.resolveProviderId('m'), 'chatter');
});

test('when none of the owners can chat, the first owner is used anyway', async () => {
  // Better than refusing: something owns the model, and the failure of a wrong guess is visible in
  // the request, whereas a refusal names no provider at all.
  const { instance } = catalog({
    connections: [connection({ id: 'a', providerId: 'first', modelIds: ['m'] }), connection({ id: 'b', providerId: 'second', modelIds: ['m'] })],
    adapters: [adapter('first', { chat: false }), adapter('second', { chat: false })],
  });
  assert.equal(await instance.resolveProviderId('m'), 'first');
});

test('a stale catalogue still routes, when there is only one connection', async () => {
  // The manually added model case. A single-connection gateway should not refuse to answer because
  // its provider's saved catalog is behind — that is exactly what a custom model id is for.
  const { instance } = catalog({ connections: [connection({ providerId: 'only', modelIds: [] })] });
  assert.equal(await instance.resolveProviderId('added-by-hand'), 'only');
});

test('with several connections and nothing owning the model, the default is used', async () => {
  // The last step is a refusal to guess. Picking one of several unconnected-by-model providers would
  // send traffic somewhere arbitrary and report the failure as that provider's fault.
  const { instance } = catalog({ connections: [connection({ id: 'a', providerId: 'a', modelIds: ['x'] }), connection({ id: 'b', providerId: 'b', modelIds: ['y'] })] });
  assert.equal(await instance.resolveProviderId('nobody-owns-this'), 'fallback');
});

test('an empty model id is the default rather than a lookup for nothing', async () => {
  const { instance } = catalog({ connections: [connection({ providerId: 'p', modelIds: ['m'] })] });
  assert.equal(await instance.resolveProviderId('   '), 'fallback');
});

test('a disabled connection does not claim a model', async () => {
  // Otherwise switching a connection off would leave its models routed to it.
  const { instance } = catalog({ connections: [connection({ providerId: 'off', modelIds: ['m'], enabled: false })] });
  assert.equal(await instance.resolveProviderId('m'), 'fallback');
});

// ── discovery, and the policy travelling twice ────────────────────────────

test('the import policy travels on the context and as an argument', async () => {
  // A provider may read it either way, and a `free` import that is correct on connect and comes
  // back in full on the next refresh is a toggle that stops working once you stop looking at it.
  const withDiscovery = adapter('p', { discover: [{ id: 'd' }] });
  const { instance } = catalog({ adapters: [withDiscovery] });
  await instance.discover({ providerId: 'p', credential, policy: 'free' });
  const [record] = withDiscovery.asked;
  assert.equal(record.context.importPolicy, 'free');
  assert.equal(record.options.policy, 'free');
});

test('a provider that cannot narrow still returns its list, and a free connection stays refreshable', async () => {
  // Gating the branch on `policy === 'all'` looked stricter and was worse: it made a free-only
  // connection **unrefreshable**, so the toggle could create a connection that broke the next time
  // anybody asked the provider what it serves.
  const plain = adapter('p', { models: [{ id: 'everything' }] });
  const { instance } = catalog({ adapters: [plain] });
  const discovered = await instance.discover({ providerId: 'p', credential, policy: 'free' });
  assert.deepEqual(discovered, [{ id: 'everything' }], 'a provider that ignores the policy documents that as its meaning of free');
});

test('a provider that can list but not discover is asked to list', async () => {
  const { instance } = catalog({ adapters: [adapter('p', { models: [{ id: 'm' }] })] });
  assert.deepEqual(await instance.discover({ providerId: 'p', credential, policy: 'all' }), [{ id: 'm' }]);
});

test('a provider that offers neither is refused by name, and which of the two it lacks', async () => {
  const { instance } = catalog({ adapters: [adapter('p', { canList: false })] });
  await assert.rejects(() => instance.discover({ providerId: 'p', credential, policy: 'all' }), (error) => {
    assert.equal(error.code, 'NOT_SUPPORTED');
    assert.match(error.message, /p provider does not support model discovery/);
    return true;
  });
});

test('a free-only connection names free model discovery, so the message matches the toggle', async () => {
  const { instance } = catalog({ adapters: [adapter('p', { canList: false })] });
  await assert.rejects(() => instance.discover({ providerId: 'p', credential, policy: 'free' }), (error) => /free model discovery/.test(error.message));
});

// ── the invariant ──────────────────────────────────────────────────────────

test('THE INVARIANT: the catalog names no provider', () => {
  // Checked against the SDK's actual adapter ids rather than "any hyphenated string".
  //
  // My first version matched a pattern for any hyphenated word, which passed only because no such
  // word happened to appear in the file — the moment RetryPolicy introduced 'next-route' it failed,
  // on a name that is not a provider. A guard that can be silenced by a naming choice is a weak
  // guard, and worse, it trains you to reach for an allowlist instead of fixing the code.
  //
  // Reading the adapter directory makes it self-maintaining: a new provider cannot be added without
  // this noticing, and nothing else in the file can trip it.
  const adapters = readdirSync(new URL('../../../packages/omnihilbras-sdk/src/adapters/', import.meta.url))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .map((file) => file.replace(/\.ts$/, ''));
  const source = readFileSync(new URL('../src/model-catalog.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const found = adapters.filter((id) => new RegExp("['\"\`]" + id + "['\"\`]").test(code));
  assert.deepEqual(found, [], `the model-catalog must name no provider, found: ${found.join(', ')}`);
});
