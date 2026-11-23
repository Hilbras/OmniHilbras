import assert from 'node:assert/strict';
import test from 'node:test';
import { OWN_PROVIDER_ADAPTERS } from '../../API/dist/src/core/own-provider-adapters.js';
import { scriptedTransport } from './harness/scripted-transport.js';

/**
 * Nebius's cycle-4 tranche: a scripted contract, not a live turn. No key was used and nothing was
 * billed. The 9router registry also names an embedding endpoint; this build does not claim it, and
 * the generic adapter's embeddings capability stays at its conservative default.
 */

test('nebius is a keyed OpenAI-compatible adapter on its own host', async () => {
  const entry = OWN_PROVIDER_ADAPTERS.nebius;
  assert.ok(entry, 'nebius has no factory beside together and fireworks');
  assert.equal(entry.validation, 'none', 'a Check may not claim to prove an unmeasured Nebius key');
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['meta-llama/Llama-3.3-70B-Instruct'] });
  const adapter = entry.create({ transport });
  assert.equal(adapter.id, 'nebius');
  assert.equal(adapter.capabilities.embeddings, false, 'no embedding lane is claimed for this router');

  const models = await adapter.listModels({ credential: { type: 'api-key', value: 'key' } });
  assert.deepEqual(models.map((model) => model.id), ['meta-llama/Llama-3.3-70B-Instruct']);
  const catalogCall = transport.seen.find((call) => /\/models/.test(call.url));
  assert.ok(catalogCall, 'no catalog request was made');
  assert.equal(new URL(catalogCall.url).hostname, 'api.studio.nebius.ai');

  const response = await adapter.chat(
    { model: 'meta-llama/Llama-3.3-70B-Instruct', messages: [{ role: 'user', content: 'ping' }] },
    { credential: { type: 'api-key', value: 'key' } },
  );
  assert.ok(response.message, 'the scripted chat turn was not answered');
  const chatCall = transport.seen.find((call) => /chat\/completions/.test(call.url));
  assert.ok(chatCall, 'no chat request was made');
  assert.equal(new URL(chatCall.url).hostname, 'api.studio.nebius.ai', 'nebius reached a different host');
  assert.equal(new URL(chatCall.url).pathname, '/v1/chat/completions', 'the card names /v1, so the wire must use /v1');
  assert.match(chatCall.body ?? '', /meta-llama\/Llama-3.3-70B-Instruct/, 'the requested model was dropped');
  assert.equal(chatCall.headers?.authorization ?? chatCall.headers?.Authorization, 'Bearer key');
});

test('a saved endpoint override still wins for a nebius-compatible gateway', async () => {
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['router-model'] });
  const adapter = OWN_PROVIDER_ADAPTERS.nebius.create({ transport, endpoint: 'https://proxy.example.test/v1' });
  await adapter.listModels({ credential: { type: 'api-key', value: 'key' } });
  assert.equal(new URL(transport.seen[0].url).hostname, 'proxy.example.test');
});
