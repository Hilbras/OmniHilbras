import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ProviderResolver } from '../dist/provider-resolver.js';
import { ProviderRegistry, ProviderError } from '@hilbras/omnihilbras';

/**
 * `ProviderResolver`, and the invariant it exists to protect.
 *
 * The last provider-coupled surface in the Core was six `if (providerId === '…')` branches in the
 * resolution path. This file ends by asserting that the file which replaced them contains no
 * provider id at all — because an invariant nobody checks is a comment.
 */

const stubAdapter = (id) => ({ id, name: id, capabilities: { chat: true, streaming: false, models: false }, async chat() { return {}; } });

function registryWith(...ids) {
  const registry = new ProviderRegistry();
  for (const id of ids) registry.register(stubAdapter(id));
  return registry;
}

test('a registered adapter is returned as it is', async () => {
  const registered = stubAdapter('openai');
  const registry = new ProviderRegistry().register(registered);
  const resolver = new ProviderResolver(registry);
  assert.equal(await resolver.resolve('openai'), registered);
});

test('an on-demand adapter is built when first needed, not at registration', async () => {
  // These adapters cannot be constructed up front: each needs a connection id, a lazily-created
  // driver, or a shared access-token cache. Building one eagerly would mean a driver per
  // provider id, created whether or not anyone ever asked it.
  let built = 0;
  const resolver = new ProviderResolver(new ProviderRegistry()).onDemand('lazy', ({ providerId }) => { built += 1; return stubAdapter(providerId); });
  assert.equal(built, 0, 'registration must not build anything');
  const adapter = await resolver.resolve('lazy');
  assert.equal(built, 1);
  assert.equal(adapter.id, 'lazy');
});

test('the factory is given the saved connection, not just the provider id', async () => {
  // This is the fix. Two callers used to supply different values: the resolution path passed the
  // provider id where the health path passed the connection id, and the adapters built from it
  // write refreshed credentials back to the store under that value. The adapter is cached, so
  // whichever caller built first decided the key.
  const seen = [];
  const resolver = new ProviderResolver(new ProviderRegistry()).onDemand('multi', (context) => { seen.push(context); return stubAdapter(context.providerId); });
  await resolver.resolve('multi', undefined, async () => [
    { id: 'connection-7', providerId: 'multi', endpoint: 'https://m.invalid/v1', name: 'Multi' },
  ]);
  assert.deepEqual(seen, [{ providerId: 'multi', connection: { id: 'connection-7' } }]);
});

test('the resolution path and the health path now agree on the connection', async () => {
  // Both go through the same lookup, so a Kiro adapter built by a health probe keys its
  // refreshed-credential writes to the same connection as one built by a request.
  const built = [];
  const factory = (context) => { built.push(context.connection?.id); return stubAdapter(context.providerId); };
  const connections = [{ id: 'connection-7', providerId: 'multi', hasCredential: true, endpoint: 'https://m.invalid/v1', name: 'Multi' }];
  const resolver = new ProviderResolver(new ProviderRegistry()).onDemand('multi', factory);
  await resolver.resolve('multi', undefined, async () => connections);
  const active = await resolver.active(connections);
  assert.equal(active.length, 1);
  assert.deepEqual(built, ['connection-7', 'connection-7'], 'one answer, not two');
});

test('a provider with no credential is not probed, and an on-demand adapter that needs one is told so', async () => {
  // Probing without a credential spends a request that cannot succeed, so an unconnected
  // provider contributes no adapter at all. The factory is told the connection is absent rather
  // than being handed a provider id to mistake for one.
  const seen = [];
  const resolver = new ProviderResolver(new ProviderRegistry()).onDemand('multi', (context) => { seen.push(context.connection); return stubAdapter(context.providerId); });
  assert.deepEqual(await resolver.active([{ id: 'c', providerId: 'multi', hasCredential: false }]), [], 'no credential, no adapter');
  assert.deepEqual(seen, [], 'and the factory is not even called');
  await resolver.resolve('multi');
  assert.deepEqual(seen, [undefined], 'a resolution with no saved connection is told so plainly');
});

test('an on-demand factory wins over a registry entry for the same id', async () => {
  // A deliberate `.onDemand()` registration is the more specific claim, so it wins. Both being
  // present is a configuration mistake rather than a design question, and resolving to the
  // generic one would silently ignore the factory someone wrote on purpose.
  const fromFactory = stubAdapter('both');
  const registry = new ProviderRegistry().register(stubAdapter('both'));
  const resolver = new ProviderResolver(registry).onDemand('both', () => fromFactory);
  assert.equal(await resolver.resolve('both'), fromFactory);
});

test('active() lists the registered adapters as well as the credentialed on-demand ones', async () => {
  // The registered half is free, and a provider with static configuration is always worth probing;
  // only a provider with none needs a credential to have anything to probe *with*.
  const registered = stubAdapter('openai');
  const resolver = new ProviderResolver(new ProviderRegistry().register(registered)).onDemand('multi', ({ providerId }) => stubAdapter(providerId));
  const adapters = await resolver.active([{ id: 'c', providerId: 'multi', hasCredential: true }]);
  assert.deepEqual(adapters.map((adapter) => adapter.id), ['multi']);
  assert.equal(adapters.includes(registered), false, 'the caller adds the registry itself; duplicating it here would double-probe');
});

test('a registered adapter is never shadowed by the synthesised one', async () => {
  // The order that actually matters. A saved endpoint exists for plenty of providers that also
  // have a registered adapter, and synthesising a generic one for those would be *wrong* — a
  // wrong answer that serves traffic is worse than a refusal.
  const registered = stubAdapter('openai');
  const resolver = new ProviderResolver(new ProviderRegistry().register(registered));
  assert.equal(await resolver.resolve('openai', { endpoint: 'https://elsewhere.invalid/v1', name: 'Elsewhere' }, async () => []), registered);
});

test('a saved endpoint is served generically, with no code anywhere', async () => {
  // This is the path that lets a dashboard-added custom endpoint serve traffic. It is the reason
  // the "no Core changes" promise is mostly already true.
  const resolver = new ProviderResolver(new ProviderRegistry());
  const adapter = await resolver.resolve(
    'my-endpoint',
    { endpoint: 'https://example.invalid/v1', name: 'Mine' },
    async () => [],
  );
  assert.equal(adapter.id, 'my-endpoint');
  assert.equal(adapter.name, 'Mine');
});

test('a saved endpoint is found without the caller having to pass it', async () => {
  const resolver = new ProviderResolver(new ProviderRegistry());
  const adapter = await resolver.resolve('saved', undefined, async () => [{ providerId: 'saved', endpoint: 'https://saved.invalid/v1', name: 'Saved' }]);
  assert.equal(adapter.name, 'Saved');
});

test('an adapter is reused for a stable endpoint, and rebuilt when the endpoint moves', async () => {
  // Reusing across a changed endpoint would keep sending to the old host, which is a far more
  // confusing failure than building a second adapter.
  const resolver = new ProviderResolver(new ProviderRegistry());
  const first = await resolver.resolve('moving', { endpoint: 'https://a.invalid/v1', name: 'A' }, async () => []);
  const again = await resolver.resolve('moving', { endpoint: 'https://a.invalid/v1', name: 'A' }, async () => []);
  const moved = await resolver.resolve('moving', { endpoint: 'https://b.invalid/v1', name: 'B' }, async () => []);
  assert.equal(again, first, 'a stable endpoint should reuse the adapter');
  assert.notEqual(moved, first, 'a changed endpoint must not reuse the old adapter');
  assert.equal(moved.name, 'B');
});

test('a provider that is not connected is named, not invented', async () => {
  // Falling through to a synthesised adapter with no endpoint would mean sending the request
  // nowhere and reporting a provider error, instead of saying the provider was never connected.
  const resolver = new ProviderResolver(new ProviderRegistry());
  await assert.rejects(
    () => resolver.resolve('nothing'),
    (error) => error instanceof ProviderError,
  );
});

test('require() refuses rather than synthesising', async () => {
  const resolver = new ProviderResolver(registryWith('openai'));
  assert.equal(resolver.require('openai').id, 'openai');
  assert.throws(() => resolver.require('absent'), (error) => error instanceof ProviderError);
});

test('the registrations are inspectable', () => {
  const resolver = new ProviderResolver(new ProviderRegistry())
    .onDemand('a', (id) => stubAdapter(id))
    .onDemand('b', (id) => stubAdapter(id));
  assert.deepEqual(resolver.onDemandIds(), ['a', 'b']);
});

test('save-time validation is declared, not inferred from the adapter', async () => {
  // The failure this prevents: I first read "any on-demand provider with a `validateCredential`"
  // and every on-demand provider has one, so saving a ChatGPT Web credential started opening a
  // browser. Real requests only — and a save button that silently launches one is worse.
  const withValidator = { ...stubAdapter('web'), validateCredential: async () => ({}) };
  const resolver = new ProviderResolver(new ProviderRegistry())
    .onDemand('web', () => withValidator)
    .onDemand('declared', () => withValidator, { validateOnSave: true });

  assert.equal(resolver.canValidateCredential('web'), false, 'having a validator is not a declaration');
  assert.equal(resolver.canValidateCredential('declared'), true);
  assert.equal(resolver.canValidateCredential('absent'), false);
});

test('a registered adapter is asked what it can do, rather than declaring', () => {
  const registry = new ProviderRegistry()
    .register({ ...stubAdapter('yes'), validateCredential: async () => ({}) })
    .register(stubAdapter('no'));
  const resolver = new ProviderResolver(registry);
  assert.equal(resolver.canValidateCredential('yes'), true);
  assert.equal(resolver.canValidateCredential('no'), false);
});

test('a registration cannot be used to shadow a registered adapter’s own capability', () => {
  // A registered adapter is asked directly, so there is no way to talk the resolver out of a
  // provider's real capability — the declaration only covers providers the registry cannot see.
  const registry = new ProviderRegistry().register(stubAdapter('registered'));
  const resolver = new ProviderResolver(registry).onDemand('registered', () => ({ ...stubAdapter('registered'), validateCredential: async () => ({}) }));
  assert.equal(resolver.canValidateCredential('registered'), false);
});

test('THE INVARIANT: the resolver names no provider', () => {
  // The whole point of the extraction. If a provider id ever appears in this file, the abstraction
  // has leaked and adding a provider has gone back to being an edit to someone else's code.
  const source = readFileSync(new URL('../src/provider-resolver.ts', import.meta.url), 'utf8');
  // Strip comments and doc text, which *discuss* provider names on purpose.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const offenders = [...code.matchAll(/['"]([a-z0-9]+(?:-[a-z0-9]+)+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(offenders, [], `the resolver must contain no provider id, found: ${offenders.join(', ')}`);
});
