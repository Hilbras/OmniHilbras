import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../../API/dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../../API/dist/src/core/index.js';
import { OWN_PROVIDER_ADAPTERS } from '../../API/dist/src/core/own-provider-adapters.js';
import { scriptedTransport } from './harness/scripted-transport.js';

/**
 * MiMo Code Free's cycle-7 slice: a scripted contract, not a live turn. No key was used, no Xiaomi
 * account was signed in and nothing was billed. The 9router registry entry's client impersonation,
 * CLI identity and validation claims are deliberately not copied. The published endpoint is already
 * the chat path, so the one assertion that matters is that the gateway does not append
 * `/chat/completions` to it. No model listing was measured, so none is asserted and the card claims
 * no model count or model list.
 */

test('mimo-free is a keyed OpenAI-compatible adapter on the published chat path', async () => {
  const entry = OWN_PROVIDER_ADAPTERS['mimo-free'];
  assert.ok(entry, 'mimo-free has no factory beside the other openAiRouter entries');
  assert.equal(entry.validation, 'none', 'a Check may not claim to prove an unmeasured free key');
  const transport = scriptedTransport({ wireFormat: 'openai' });
  const adapter = entry.create({ transport });
  assert.equal(adapter.id, 'mimo-free');

  const response = await adapter.chat(
    { model: 'mimo-auto', messages: [{ role: 'user', content: 'ping' }] },
    { credential: { type: 'api-key', value: 'key' } },
  );
  assert.ok(response.message, 'the scripted chat turn was not answered');
  const chatCall = transport.seen.find((call) => call.method === 'POST');
  assert.ok(chatCall, 'no chat request was made');
  const url = new URL(chatCall.url);
  assert.equal(url.hostname, 'api.xiaomimimo.com', 'mimo-free reached a different host');
  assert.equal(url.pathname, '/api/free-ai/openai/chat', 'the published endpoint is the chat path; do not append /chat/completions');
  assert.match(chatCall.body ?? '', /mimo-auto/, 'the requested model was dropped');
  assert.equal(chatCall.headers?.authorization ?? chatCall.headers?.Authorization, 'Bearer key');
  const headerNames = Object.keys(chatCall.headers ?? {}).map((name) => name.toLowerCase());
  assert.ok(!headerNames.includes('x-api-key'), 'the reference client identity was not copied');
  assert.ok(!headerNames.some((name) => name.startsWith('x-command-') || name === 'user-agent'),
    'no CLI identity was copied onto the wire');
  // No catalog call was scripted and no model path was configured: a /models request would be a
  // guess about a third-party surface, and a success from it would be an invented card field.
  assert.ok(!transport.seen.some((call) => /\/models/.test(call.url)), 'an unmeasured model listing was requested');
});

test('a saved endpoint override still wins for a mimo-compatible gateway', async () => {
  const transport = scriptedTransport({ wireFormat: 'openai' });
  const adapter = OWN_PROVIDER_ADAPTERS['mimo-free'].create({ transport, endpoint: 'https://proxy.example.test' });
  await adapter.chat({ model: 'mimo-auto', messages: [{ role: 'user', content: 'ping' }] }, { credential: { type: 'api-key', value: 'key' } });
  const url = new URL(transport.seen[0].url);
  assert.equal(url.hostname, 'proxy.example.test');
  assert.equal(url.pathname, '/api/free-ai/openai/chat', 'the override changes the host, not the published chat path');
});

test('the registry declares no key check for a public free catalog', async () => {
  // `validation: 'none'` is a decision, not an omission. A public free catalog cannot prove a pasted
  // key belongs to the caller, so Check must refuse rather than report green for any string.
  assert.equal(OWN_PROVIDER_ADAPTERS['mimo-free'].validation, 'none');
  const transport = scriptedTransport({ wireFormat: 'openai' });
  const service = new GatewayService(
    new ProviderRegistry(),
    new InMemorySecretStore({}),
    new InMemoryConnectionStore(),
    new InMemoryApiKeyStore(),
    { transport },
  );
  assert.equal(service.providers.validationStrategy('mimo-free'), 'none', 'the registration must not inherit a strategy');
  await assert.rejects(
    service.validateConnectionCredential('mimo-free', { type: 'api-key', value: 'bogus-key' }),
    (error) => error.code === 'NOT_SUPPORTED',
    'a public catalog was accepted as a key check',
  );
  assert.equal(transport.seen.length, 0, 'a key-check request was sent despite validation none');
});
