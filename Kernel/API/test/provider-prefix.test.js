import assert from 'node:assert/strict';
import test from 'node:test';
import { splitProviderPrefix } from '../dist/src/index.js';

const connections = [{ providerId: 'opencode-console' }, { providerId: 'openrouter' }];

test('a prefix naming a connected provider is split off', () => {
  assert.deepEqual(
    splitProviderPrefix('opencode-console/mimo-v2.6-flash', connections),
    { model: 'mimo-v2.6-flash', providerId: 'opencode-console' },
  );
});

test('a real model id that contains a slash is left whole when its prefix is not a connected provider', () => {
  assert.deepEqual(
    splitProviderPrefix('qwen/qwen3.8-27b:free', connections),
    { model: 'qwen/qwen3.8-27b:free' },
    'qwen is not a connected provider here, so the id is a model name and must not be cut',
  );
});

test('a bare model id passes through unchanged', () => {
  assert.deepEqual(splitProviderPrefix('mimo-v2.6-flash', connections), { model: 'mimo-v2.6-flash' });
});

test('an empty model after the slash is not a prefix', () => {
  assert.deepEqual(splitProviderPrefix('openrouter/', connections), { model: 'openrouter/' });
});

test('a leading slash is not a prefix', () => {
  assert.deepEqual(splitProviderPrefix('/mimo', connections), { model: '/mimo' });
});

test('surrounding whitespace is trimmed before the prefix is read', () => {
  assert.deepEqual(
    splitProviderPrefix('  openrouter/gpt-x  ', connections),
    { model: 'gpt-x', providerId: 'openrouter' },
  );
});

test('a vendor namespace that is also a connected provider id is not stripped when the catalog owns the whole id', () => {
  // NVIDIA publishes `nvidia/nemotron-3.5-super-vl-120b-a12b`; `nvidia` is also its provider id. Stripping
  // the namespace sent `nemotron-3.5-super-vl-120b-a12b` upstream, and NVIDIA answered 404 page not found.
  // The same model through the explicit `nv/` prefix worked. Measured 2026-11-27.
  const nvidia = [{ providerId: 'nvidia', modelIds: ['nvidia/nemotron-3.5-super-vl-120b-a12b'] }];
  assert.deepEqual(
    splitProviderPrefix('nvidia/nemotron-3.5-super-vl-120b-a12b', nvidia),
    { model: 'nvidia/nemotron-3.5-super-vl-120b-a12b' },
    'the catalog id is the model, not a prefix',
  );
  assert.deepEqual(
    splitProviderPrefix('nv/nvidia/nemotron-3.5-super-vl-120b-a12b', nvidia),
    { model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', providerId: 'nvidia' },
    'an explicit provider prefix still selects the provider and is still removed',
  );
});

test('a full id catalogued by another provider does not get captured by a name-colliding provider id', () => {
  // `deepseek/deepseek-v4.1-flash` is a TokenRouter model id whose first segment is also a provider id.
  // The whole-id match must win, or the request is sent to DeepSeek with a name it does not serve.
  const both = [
    { providerId: 'tokenrouter', modelIds: ['deepseek/deepseek-v4.1-flash'] },
    { providerId: 'deepseek', modelIds: ['deepseek-chat'] },
  ];
  assert.deepEqual(
    splitProviderPrefix('deepseek/deepseek-v4.1-flash', both),
    { model: 'deepseek/deepseek-v4.1-flash' },
  );
});
