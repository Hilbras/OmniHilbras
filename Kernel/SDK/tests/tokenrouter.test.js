import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../../API/dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../../API/dist/src/core/index.js';
import { OWN_PROVIDER_ADAPTERS } from '../../API/dist/src/core/own-provider-adapters.js';
import { scriptedTransport } from './harness/scripted-transport.js';

/**
 * TokenRouter: a scripted contract, not a live turn. No key was used and nothing was billed.
 *
 * The published `/v1/models` was measured unauthenticated on 2026-11-27 and answered 401, which is
 * why this provider declares an authenticated-catalog check rather than the `none` every public
 * catalog declares. Model ids keep their vendor namespace, so the request body is the one place to
 * prove the gateway did not strip `anthropic/` before sending it upstream.
 */

test('tokenrouter is a keyed OpenAI-compatible gateway on api.tokenrouter.com/v1', async () => {
  const entry = OWN_PROVIDER_ADAPTERS.tokenrouter;
  assert.ok(entry, 'tokenrouter has no factory beside the other keyed routers');
  assert.equal(entry.validation, 'models', 'the measured 401 catalog is the evidence for this check');
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['anthropic/claude-sonnet-4.6'] });
  const adapter = entry.create({ transport });
  assert.equal(adapter.id, 'tokenrouter');

  const models = await adapter.listModels({ credential: { type: 'api-key', value: 'key' } });
  assert.deepEqual(models.map((model) => model.id), ['anthropic/claude-sonnet-4.6']);
  const catalogCall = transport.seen.find((call) => /\/models/.test(call.url));
  assert.ok(catalogCall, 'no catalog request was made');
  const catalogUrl = new URL(catalogCall.url);
  assert.equal(catalogUrl.hostname, 'api.tokenrouter.com');
  assert.equal(catalogUrl.pathname, '/v1/models');

  const response = await adapter.chat(
    { model: 'anthropic/claude-sonnet-4.6', messages: [{ role: 'user', content: 'ping' }], tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }], toolChoice: 'required' },
    { credential: { type: 'api-key', value: 'key' } },
  );
  assert.ok(response.message, 'the scripted chat turn was not answered');
  const chatCall = transport.seen.find((call) => /chat\/completions/.test(call.url));
  assert.ok(chatCall, 'no chat request was made');
  const url = new URL(chatCall.url);
  assert.equal(url.hostname, 'api.tokenrouter.com');
  assert.equal(url.pathname, '/v1/chat/completions');
  assert.match(chatCall.body ?? '', /"model":"anthropic\/claude-sonnet-4\.6"/, 'the vendor namespace was stripped from the model id');
  assert.match(chatCall.body ?? '', /"tool_choice":"required"/, 'a forced tool call was dropped');
  assert.equal(chatCall.headers?.authorization ?? chatCall.headers?.Authorization, 'Bearer key');
});

test('tokenrouter declares an authenticated-catalog key check', async () => {
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['openai/gpt-5.4'] });
  const service = new GatewayService(
    new ProviderRegistry(),
    new InMemorySecretStore({}),
    new InMemoryConnectionStore(),
    new InMemoryApiKeyStore(),
    { transport },
  );
  assert.equal(service.providers.validationStrategy('tokenrouter'), 'models', 'the registration lost its measured strategy');
  const result = await service.validateConnectionCredential('tokenrouter', { type: 'api-key', value: 'candidate' });
  assert.equal(result.valid, true);
  const call = transport.seen.find((entry) => /\/models/.test(entry.url));
  assert.ok(call, 'the key check did not read the authenticated catalog');
});
