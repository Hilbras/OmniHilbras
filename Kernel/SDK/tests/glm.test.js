import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../../API/dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../../API/dist/src/core/index.js';
import { OWN_PROVIDER_ADAPTERS } from '../../API/dist/src/core/own-provider-adapters.js';
import { scriptedTransport } from './harness/scripted-transport.js';

/**
 * GLM's cycle-5 tranche: a scripted contract, not a live turn. No key was used, no Z.ai account was
 * signed in and nothing was billed. The 9router registry entry for this id carries a second,
 * Claude-header transport, a ZCode CLI OAuth grant and client metadata; none of that is copied. What
 * is asserted here is the plain keyed OpenAI chat path and the decision that Check cannot prove a
 * pasted key from a public catalog.
 */

test('glm is a keyed OpenAI-compatible adapter on the Z.ai coding chat path', async () => {
  const entry = OWN_PROVIDER_ADAPTERS.glm;
  assert.ok(entry, 'glm has no factory beside the other openAiRouter entries');
  assert.equal(entry.validation, 'none', 'a Check may not claim to prove an unmeasured Z.ai coding key');
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['glm-5.3'] });
  const adapter = entry.create({ transport });
  assert.equal(adapter.id, 'glm');

  const models = await adapter.listModels({ credential: { type: 'api-key', value: 'key' } });
  assert.deepEqual(models.map((model) => model.id), ['glm-5.3']);
  const catalogCall = transport.seen.find((call) => /\/models/.test(call.url));
  assert.ok(catalogCall, 'no catalog request was made');
  assert.equal(new URL(catalogCall.url).hostname, 'api.z.ai');

  const response = await adapter.chat(
    { model: 'glm-5.3', messages: [{ role: 'user', content: 'ping' }] },
    { credential: { type: 'api-key', value: 'key' } },
  );
  assert.ok(response.message, 'the scripted chat turn was not answered');
  const chatCall = transport.seen.find((call) => /chat\/completions/.test(call.url));
  assert.ok(chatCall, 'no chat request was made');
  const url = new URL(chatCall.url);
  assert.equal(url.hostname, 'api.z.ai', 'glm reached a different host');
  assert.equal(url.pathname, '/api/coding/paas/v4/chat/completions', 'the wire must use the coding-plan chat path');
  assert.match(chatCall.body ?? '', /glm-5\.3/, 'the requested model was dropped');
  assert.equal(chatCall.headers?.authorization ?? chatCall.headers?.Authorization, 'Bearer key');
  const headerNames = Object.keys(chatCall.headers ?? {}).map((name) => name.toLowerCase());
  assert.ok(!headerNames.includes('x-api-key'), 'the reference Claude-header lane was not copied');
  assert.ok(!headerNames.some((name) => name.startsWith('x-command-') || name === 'user-agent'),
    'no CLI identity was copied onto the wire');
});

test('a saved endpoint override still wins for a Z.ai-compatible gateway', async () => {
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['router-model'] });
  const adapter = OWN_PROVIDER_ADAPTERS.glm.create({ transport, endpoint: 'https://proxy.example.test/v4' });
  await adapter.listModels({ credential: { type: 'api-key', value: 'key' } });
  assert.equal(new URL(transport.seen[0].url).hostname, 'proxy.example.test');
});

test('the public catalog cannot be used as a candidate-key check', async () => {
  // `validation: 'none'` is a decision, not an omission. A /models answer that says 200 for any
  // string must never be reported as proof that the pasted coding key belongs to the caller.
  assert.equal(OWN_PROVIDER_ADAPTERS.glm.validation, 'none');
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['glm-5.3'] });
  const service = new GatewayService(
    new ProviderRegistry(),
    new InMemorySecretStore({}),
    new InMemoryConnectionStore(),
    new InMemoryApiKeyStore(),
    { transport },
  );
  assert.equal(service.providers.validationStrategy('glm'), 'none', 'the registration must not inherit a strategy');
  await assert.rejects(
    service.validateConnectionCredential('glm', { type: 'api-key', value: 'bogus-key' }),
    (error) => error.code === 'NOT_SUPPORTED',
    'a public catalog was accepted as a key check',
  );
  assert.equal(transport.seen.length, 0, 'a key-check request was sent despite validation none');
});
