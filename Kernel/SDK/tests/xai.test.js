import assert from 'node:assert/strict';
import test from 'node:test';
import { OWN_PROVIDER_ADAPTERS } from '../../API/dist/src/core/own-provider-adapters.js';
import { scriptedTransport } from './harness/scripted-transport.js';

/**
 * xAI's one-id tranche, driven through a scripted transport.
 *
 * This is a local contract test, not a live vendor turn: no key was used and nothing was billed. It
 * proves the new id has its own adapter, its own host, and its own connection identity, and that the
 * declared Check strategy says "none" rather than claiming a proof nobody measured.
 */

test('xai has its own OpenAI-compatible adapter and sends the saved key to xAI', async () => {
  const entry = OWN_PROVIDER_ADAPTERS.xai;
  assert.ok(entry, 'xai has no registration beside together and fireworks');
  assert.equal(entry.validation, 'none', 'a Check may not claim to prove an unmeasured xAI key');
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['grok-4-fast'] });
  const adapter = entry.create({ transport });
  assert.equal(adapter.id, 'xai');

  const models = await adapter.listModels({ credential: { type: 'api-key', value: 'key' } });
  assert.deepEqual(models.map((model) => model.id), ['grok-4-fast']);
  const catalogCall = transport.seen.find((call) => /\/models/.test(call.url));
  assert.ok(catalogCall, 'no catalog request was made');
  assert.equal(new URL(catalogCall.url).hostname, 'api.x.ai');

  const response = await adapter.chat(
    { model: 'grok-4-fast', messages: [{ role: 'user', content: 'ping' }] },
    { credential: { type: 'api-key', value: 'key' } },
  );
  assert.ok(response.message, 'the scripted chat turn was not answered');
  const chatCall = transport.seen.find((call) => /chat\/completions/.test(call.url));
  assert.ok(chatCall, 'no chat request was made');
  assert.equal(new URL(chatCall.url).hostname, 'api.x.ai', 'xai reached a different host');
  assert.match(chatCall.body ?? '', /grok-4-fast/, 'the requested model was dropped');
  assert.equal(chatCall.headers?.authorization ?? chatCall.headers?.Authorization, 'Bearer key');
});

test('a saved endpoint override still wins for a separately configured xAI-compatible gateway', async () => {
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['router-model'] });
  const adapter = OWN_PROVIDER_ADAPTERS.xai.create({ transport, endpoint: 'https://proxy.example.test/v1' });
  await adapter.listModels({ credential: { type: 'api-key', value: 'key' } });
  assert.equal(new URL(transport.seen[0].url).hostname, 'proxy.example.test');
});

test('the lanes are chat, streaming and video only — no OAuth, Responses, image or search surface', async () => {
  // The card says exactly this in its description and risk notice (asserted in tests/provider-cards.test.js).
  // This half checks the adapter beneath the words: a lane must be absent from the wire as well as from
  // the card, or the card would be an honest description of a dishonest build.
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['grok-4-fast'] });
  const adapter = OWN_PROVIDER_ADAPTERS.xai.create({ transport });
  assert.equal(adapter.capabilities.video, true, 'xAI really does create and poll video jobs');
  assert.equal(typeof adapter.beginSignIn, 'undefined', 'there is no xAI OAuth device flow to start');

  await adapter.chat({ model: 'grok-4-fast', messages: [{ role: 'user', content: 'ping' }] }, { credential: { type: 'api-key', value: 'key' } });
  const chatCall = transport.seen.find((call) => /chat\/completions/.test(call.url));
  assert.ok(chatCall, 'no chat completion was sent');
  assert.doesNotMatch(chatCall.url, /\/responses(\?|$)/, 'the Responses lane is not served on this id');
  assert.equal(adapter.capabilities.images, undefined, 'the xAI image config is not implemented here');
});
