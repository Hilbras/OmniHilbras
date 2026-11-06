import assert from 'node:assert/strict';
import test from 'node:test';
import { providerSlug, qualifiedModelId } from '../dist/src/core/index.js';
import { splitProviderPrefix } from '../dist/src/index.js';

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

test('cline and clinepass hand out short slugs, and the long ids they replaced still route', () => {
  assert.equal(providerSlug('cline'), 'cl');
  assert.equal(providerSlug('clinepass'), 'clp');
  assert.equal(qualifiedModelId('cline', 'claude-sonnet-5.5'), 'cl/claude-sonnet-5.5');
  assert.equal(qualifiedModelId('clinepass', 'qwen3.7-max'), 'clp/qwen3.7-max');
});

test('an id saved under the old prefixes keeps resolving, so no saved client breaks', () => {
  const clineConnections = [{ providerId: 'cline' }, { providerId: 'clinepass' }];
  assert.deepEqual(splitProviderPrefix('cline/claude-sonnet-5.5', clineConnections), { model: 'claude-sonnet-5.5', providerId: 'cline' });
  assert.deepEqual(splitProviderPrefix('clinepass/cline-pass/qwen3.7-max', clineConnections), { model: 'cline-pass/qwen3.7-max', providerId: 'clinepass' });
  assert.deepEqual(splitProviderPrefix('cl/claude-sonnet-5.5', clineConnections), { model: 'claude-sonnet-5.5', providerId: 'cline' });
  assert.deepEqual(splitProviderPrefix('clp/qwen3.7-max', clineConnections), { model: 'qwen3.7-max', providerId: 'clinepass' });
});
