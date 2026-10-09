import assert from 'node:assert/strict';
import test from 'node:test';
import { providerSlug, qualifiedModelId } from '@hilbras/omnihilbras';
import { splitProviderPrefix } from '../dist/index.js';

const connections = [{ providerId: 'opencode' }, { providerId: 'nara-router' }, { providerId: 'openrouter' }];

test('a provider has one fixed slug, taken from its title, not its internal id', () => {
  assert.equal(providerSlug('opencode'), 'opencode-zen', 'OpenCode Zen is the title; the id is opencode');
  assert.equal(providerSlug('nara-router'), 'nararouter');
  assert.equal(qualifiedModelId('opencode', 'big-pickle'), 'opencode-zen/big-pickle');
});

test('a provider missing from the table falls back to its id, never an empty prefix', () => {
  assert.equal(providerSlug('brand-new-provider'), 'brand-new-provider');
  assert.equal(qualifiedModelId('brand-new-provider', 'm'), 'brand-new-provider/m');
});

test('a slug-prefixed request is routed to the provider that owns the slug', () => {
  assert.deepEqual(
    splitProviderPrefix('opencode-zen/big-pickle', connections),
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
