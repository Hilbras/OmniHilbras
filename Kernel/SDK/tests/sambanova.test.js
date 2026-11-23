import assert from 'node:assert/strict';
import test from 'node:test';
import { OWN_PROVIDER_ADAPTERS } from '../../API/dist/src/core/own-provider-adapters.js';
import { scriptedTransport } from './harness/scripted-transport.js';

/**
 * SambaNova's cycle-4 tranche: a scripted contract, not a live turn. No key was used and nothing was
 * billed. The assertions are the three things a shared router can get wrong — the id, the host and the
 * decision about what Check is allowed to prove from a public catalog.
 */

test('sambanova is a keyed OpenAI-compatible adapter on its own host', async () => {
  const entry = OWN_PROVIDER_ADAPTERS.sambanova;
  assert.ok(entry, 'sambanova has no factory beside together and fireworks');
  assert.equal(entry.validation, 'none', 'a Check may not claim to prove an unmeasured SambaNova key');
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['MiniMax-M2.7'] });
  const adapter = entry.create({ transport });
  assert.equal(adapter.id, 'sambanova');

  const models = await adapter.listModels({ credential: { type: 'api-key', value: 'key' } });
  assert.deepEqual(models.map((model) => model.id), ['MiniMax-M2.7']);
  const catalogCall = transport.seen.find((call) => /\/models/.test(call.url));
  assert.ok(catalogCall, 'no catalog request was made');
  assert.equal(new URL(catalogCall.url).hostname, 'api.sambanova.ai');

  const response = await adapter.chat(
    { model: 'MiniMax-M2.7', messages: [{ role: 'user', content: 'ping' }] },
    { credential: { type: 'api-key', value: 'key' } },
  );
  assert.ok(response.message, 'the scripted chat turn was not answered');
  const chatCall = transport.seen.find((call) => /chat\/completions/.test(call.url));
  assert.ok(chatCall, 'no chat request was made');
  assert.equal(new URL(chatCall.url).hostname, 'api.sambanova.ai', 'sambanova reached a different host');
  assert.equal(new URL(chatCall.url).pathname, '/v1/chat/completions', 'the card names /v1, so the wire must use /v1');
  assert.match(chatCall.body ?? '', /MiniMax-M2\.7/, 'the requested model was dropped');
  assert.equal(chatCall.headers?.authorization ?? chatCall.headers?.Authorization, 'Bearer key');
});

test('a saved endpoint override still wins for a sambanova-compatible gateway', async () => {
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['router-model'] });
  const adapter = OWN_PROVIDER_ADAPTERS.sambanova.create({ transport, endpoint: 'https://proxy.example.test/v1' });
  await adapter.listModels({ credential: { type: 'api-key', value: 'key' } });
  assert.equal(new URL(transport.seen[0].url).hostname, 'proxy.example.test');
});
