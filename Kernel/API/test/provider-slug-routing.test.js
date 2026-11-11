import assert from 'node:assert/strict';
import test from 'node:test';
import { LEGACY_SLUGS, PROVIDER_SLUGS, providerPrefixes, providerSlug, qualifiedModelId } from '../dist/src/core/index.js';
import { splitProviderPrefix } from '../dist/src/index.js';

const connections = [{ providerId: 'opencode' }, { providerId: 'nara-router' }, { providerId: 'openrouter' }];

/**
 * Provider prefixes are a published surface: a client pastes one into its config, so a rename is a
 * compatibility question rather than a cosmetic one. Two properties are pinned here — every prefix
 * belongs to exactly one provider, and a prefix the gateway used to publish still resolves.
 */

test('a provider has one fixed short slug, and the id is not assumed to be it', () => {
  assert.equal(providerSlug('opencode'), 'opz', 'OpenCode Zen is the title; the id is opencode');
  assert.equal(providerSlug('nara-router'), 'nr');
  assert.equal(qualifiedModelId('opencode', 'big-pickle'), 'opz/big-pickle');
});

test('the requested OAuth and subscription slugs are the short ones', () => {
  assert.deepEqual(
    {
      codex: providerSlug('codex'),
      'kimi-code': providerSlug('kimi-code'),
      'claude-code': providerSlug('claude-code'),
      qoder: providerSlug('qoder'),
      kilocode: providerSlug('kilocode'),
      'minimax-code': providerSlug('minimax-code'),
      'minimax-code-global': providerSlug('minimax-code-global'),
      'codebuddy-intl': providerSlug('codebuddy-intl'),
      'codebuddy-cn': providerSlug('codebuddy-cn'),
      'opencode-console': providerSlug('opencode-console'),
      'agnes-ai': providerSlug('agnes-ai'),
      agentrouter: providerSlug('agentrouter'),
      'aion-labs': providerSlug('aion-labs'),
    },
    {
      codex: 'cd',
      'kimi-code': 'kc',
      'claude-code': 'cc',
      qoder: 'qd',
      // `kc` is Kimi Code's; Kilo Code takes `klc` rather than sharing it.
      kilocode: 'klc',
      'minimax-code': 'mc',
      'minimax-code-global': 'mcg',
      'codebuddy-intl': 'cbg',
      'codebuddy-cn': 'cb',
      'opencode-console': 'opc',
      'agnes-ai': 'ag',
      agentrouter: 'agr',
      'aion-labs': 'aio',
    },
  );
});

test('no two providers share a prefix, and no prefix is another provider id', () => {
  const ids = new Set(Object.keys(PROVIDER_SLUGS));
  const owners = new Map();
  for (const id of new Set([...ids, ...Object.keys(LEGACY_SLUGS)])) {
    for (const prefix of providerPrefixes(id)) {
      assert.equal(
        owners.has(prefix),
        false,
        `prefix '${prefix}' is claimed by both ${owners.get(prefix)} and ${id} — a request cannot be routed unambiguously`,
      );
      owners.set(prefix, id);
    }
  }
  // A prefix that equals another provider's id makes `splitProviderPrefix` order-dependent: the id is
  // checked first, so that provider would win a request meant for the slug's owner.
  for (const [prefix, owner] of owners) {
    if (prefix === owner || !ids.has(prefix)) continue;
    assert.fail(`prefix '${prefix}' of ${owner} is also the provider id of another provider`);
  }
});

test('a provider missing from the table falls back to its id, never an empty prefix', () => {
  assert.equal(providerSlug('brand-new-provider'), 'brand-new-provider');
  assert.equal(qualifiedModelId('brand-new-provider', 'm'), 'brand-new-provider/m');
});

test('a slug-prefixed request is routed to the provider that owns the slug', () => {
  assert.deepEqual(
    splitProviderPrefix('opz/big-pickle', connections),
    { model: 'big-pickle', providerId: 'opencode' },
    'the slug resolves to the internal provider id, which is what the router pins',
  );
});

test('the internal provider id still routes, so existing requests keep working', () => {
  assert.deepEqual(splitProviderPrefix('opencode/big-pickle', connections), { model: 'big-pickle', providerId: 'opencode' });
});

test('a bare model id is unchanged, and a slug for an unconnected provider is not split', () => {
  assert.deepEqual(splitProviderPrefix('big-pickle', connections), { model: 'big-pickle' });
  assert.deepEqual(splitProviderPrefix('qwen/qwen3.8-27b:free', connections), { model: 'qwen/qwen3.8-27b:free' });
});

test('every prefix in the table routes back to its provider, and so does every id', () => {
  // The measurement behind "do it for all providers": for every entry, the published prefix and the
  // internal id both resolve to that provider — and a legacy prefix resolves too, where one exists.
  for (const [id, slug] of Object.entries(PROVIDER_SLUGS)) {
    const own = [{ providerId: id }];
    assert.deepEqual(splitProviderPrefix(`${slug}/m`, own), { model: 'm', providerId: id }, `${slug}/ must route to ${id}`);
    assert.deepEqual(splitProviderPrefix(`${id}/m`, own), { model: 'm', providerId: id }, `${id}/ must keep routing`);
    for (const legacy of LEGACY_SLUGS[id] ?? []) {
      assert.deepEqual(splitProviderPrefix(`${legacy}/m`, own), { model: 'm', providerId: id }, `${legacy}/ must still route to ${id}`);
    }
  }
});

test('a prefix this table used to publish keeps resolving, so no saved client breaks', () => {
  assert.deepEqual(
    splitProviderPrefix('opencode-zen/big-pickle', connections),
    { model: 'big-pickle', providerId: 'opencode' },
    'opencode was published as `opencode-zen` before the short slugs',
  );
  assert.deepEqual(
    splitProviderPrefix('nararouter/llama-4', connections),
    { model: 'llama-4', providerId: 'nara-router' },
  );
  const lineConnections = [{ providerId: 'cline' }, { providerId: 'clinepass' }];
  assert.deepEqual(splitProviderPrefix('cline/claude-sonnet-5.5', lineConnections), { model: 'claude-sonnet-5.5', providerId: 'cline' });
  assert.deepEqual(splitProviderPrefix('clp/qwen3.7-max', lineConnections), { model: 'qwen3.7-max', providerId: 'clinepass' });
});