import assert from 'node:assert/strict';
import test from 'node:test';
import { OWN_PROVIDER_ADAPTERS } from '../../API/dist/src/core/own-provider-adapters.js';
import { scriptedTransport } from './harness/scripted-transport.js';

/**
 * SiliconFlow's cycle-4 tranche: a scripted contract, not a live turn. No key was used and nothing was
 * billed. Its registry entry declares an OpenAI `thinkingFormat`; that is a vendor property, not a
 * claim this generic adapter implements, so the card carries no measured or capability claim.
 */

test('siliconflow is a keyed OpenAI-compatible adapter on its own host', async () => {
  const entry = OWN_PROVIDER_ADAPTERS.siliconflow;
  assert.ok(entry, 'siliconflow has no factory beside together and fireworks');
  assert.equal(entry.validation, 'none', 'a Check may not claim to prove an unmeasured SiliconFlow key');
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['deepseek-ai/DeepSeek-V4-Pro'] });
  const adapter = entry.create({ transport });
  assert.equal(adapter.id, 'siliconflow');

  const models = await adapter.listModels({ credential: { type: 'api-key', value: 'key' } });
  assert.deepEqual(models.map((model) => model.id), ['deepseek-ai/DeepSeek-V4-Pro']);
  const catalogCall = transport.seen.find((call) => /\/models/.test(call.url));
  assert.ok(catalogCall, 'no catalog request was made');
  assert.equal(new URL(catalogCall.url).hostname, 'api.siliconflow.com');

  const response = await adapter.chat(
    { model: 'deepseek-ai/DeepSeek-V4-Pro', messages: [{ role: 'user', content: 'ping' }] },
    { credential: { type: 'api-key', value: 'key' } },
  );
  assert.ok(response.message, 'the scripted chat turn was not answered');
  const chatCall = transport.seen.find((call) => /chat\/completions/.test(call.url));
  assert.ok(chatCall, 'no chat request was made');
  assert.equal(new URL(chatCall.url).hostname, 'api.siliconflow.com', 'siliconflow reached a different host');
  assert.equal(new URL(chatCall.url).pathname, '/v1/chat/completions', 'the card names /v1, so the wire must use /v1');
  assert.match(chatCall.body ?? '', /deepseek-ai\/DeepSeek-V4-Pro/, 'the requested model was dropped');
  assert.equal(chatCall.headers?.authorization ?? chatCall.headers?.Authorization, 'Bearer key');
});

test('a saved endpoint override still wins for a siliconflow-compatible gateway', async () => {
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['router-model'] });
  const adapter = OWN_PROVIDER_ADAPTERS.siliconflow.create({ transport, endpoint: 'https://proxy.example.test/v1' });
  await adapter.listModels({ credential: { type: 'api-key', value: 'key' } });
  assert.equal(new URL(transport.seen[0].url).hostname, 'proxy.example.test');
});
