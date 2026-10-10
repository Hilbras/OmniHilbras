import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/index.js';

// A bare model name such as `claude-x` belongs to a family, and a provider declares the family it serves. Routing
// reads the declaration through the registry, so no provider name has to appear in shared routing code.

function adapter(id, modelFamily) {
  return { id, name: id, capabilities: { chat: true, streaming: false, models: true }, listModels: async () => [], ...(modelFamily === undefined ? {} : { modelFamily }) };
}

test('a provider declares its model family, and the registry answers which providers serve it', () => {
  const registry = new ProviderRegistry()
    .register(adapter('anthropic', 'claude'))
    .register(adapter('openai', 'gpt'))
    .register(adapter('plain'));
  assert.equal(registry.get('anthropic').modelFamily, 'claude');
  assert.deepEqual(registry.providersInFamily('claude'), ['anthropic'], 'only the claude provider serves the claude family');
  assert.deepEqual(registry.providersInFamily('gemini'), [], 'no provider declares gemini, so nothing serves it');
});

test('a provider that declares no family is served by no family, rather than by a guess', () => {
  const registry = new ProviderRegistry().register(adapter('plain'));
  assert.equal(registry.get('plain').modelFamily, undefined);
  assert.deepEqual(registry.providersInFamily('claude'), []);
});
