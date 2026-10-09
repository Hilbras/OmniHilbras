import assert from 'node:assert/strict';
import test from 'node:test';
import { splitProviderPrefix } from '../dist/index.js';

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
