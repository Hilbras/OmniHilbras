import assert from 'node:assert/strict';
import test from 'node:test';
import { OWN_PROVIDER_ADAPTERS } from '../../API/dist/src/core/own-provider-adapters.js';
import { scriptedTransport } from './harness/scripted-transport.js';

/**
 * Perplexity's keyed API, cycle 4: a scripted contract, not a live turn. No key was used and nothing
 * was billed. This id is a separate product from `perplexity-web` (a pasted NextAuth cookie on
 * perplexity.ai): its base URL has no `/v1`, so the path assertion is the one that catches a router
 * silently sending a vendor API key to a web-session surface.
 */

test('perplexity is a keyed OpenAI-compatible adapter on its own root-path host', async () => {
  const entry = OWN_PROVIDER_ADAPTERS.perplexity;
  assert.ok(entry, 'perplexity has no factory beside together and fireworks');
  assert.equal(entry.validation, 'none', 'a Check may not claim to prove an unmeasured Perplexity key');
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['sonar-pro'] });
  const adapter = entry.create({ transport });
  assert.equal(adapter.id, 'perplexity');

  const models = await adapter.listModels({ credential: { type: 'api-key', value: 'key' } });
  assert.deepEqual(models.map((model) => model.id), ['sonar-pro']);
  const catalogCall = transport.seen.find((call) => /\/models/.test(call.url));
  assert.ok(catalogCall, 'no catalog request was made');
  assert.equal(new URL(catalogCall.url).hostname, 'api.perplexity.ai');

  const response = await adapter.chat(
    { model: 'sonar-pro', messages: [{ role: 'user', content: 'ping' }] },
    { credential: { type: 'api-key', value: 'key' } },
  );
  assert.ok(response.message, 'the scripted chat turn was not answered');
  const chatCall = transport.seen.find((call) => /chat\/completions/.test(call.url));
  assert.ok(chatCall, 'no chat request was made');
  assert.equal(new URL(chatCall.url).hostname, 'api.perplexity.ai', 'perplexity reached a different host');
  assert.equal(new URL(chatCall.url).pathname, '/chat/completions', 'Perplexity serves chat at the root, not /v1');
  assert.match(chatCall.body ?? '', /sonar-pro/, 'the requested model was dropped');
  assert.equal(chatCall.headers?.authorization ?? chatCall.headers?.Authorization, 'Bearer key');
});

test('the keyed API and the web session keep different hosts', async () => {
  // The card is the record of what a user reads; the adapter is the record of where the key goes.
  // A prefix collision between `perplexity` and `perplexity-web` is harmless only while these differ.
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['sonar'] });
  const adapter = OWN_PROVIDER_ADAPTERS.perplexity.create({ transport });
  await adapter.chat({ model: 'sonar', messages: [{ role: 'user', content: 'ping' }] }, { credential: { type: 'api-key', value: 'key' } });
  assert.doesNotMatch(new URL(transport.seen[0].url).hostname, /^www\./, 'the API key must not be sent to the browser-session host');
});
