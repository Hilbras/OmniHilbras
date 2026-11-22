import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../Kernel/API/dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../Kernel/API/dist/src/core/index.js';
import { providerResponsesPath } from '../Kernel/API/dist/src/core/provider-responses-lane.js';

/**
 * The Responses lane is only useful if the adapter the gateway actually builds has it.
 *
 * `providerResponsesPath('agentrouter')` has said `/responses` for a long time, but that value was applied
 * only to generic adapters. The dedicated AgentRouter adapter did not receive it, so the relay's own
 * "use /v1/responses" refusal was thrown to the caller. This guard checks the built registration, not a
 * grep of the factory table.
 */

test('the gateway table names the measured AgentRouter lane', () => {
  assert.equal(providerResponsesPath('agentrouter'), '/responses');
});

test('the adapter the gateway resolves carries that lane', async () => {
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), new InMemoryApiKeyStore(), {});
  const adapter = await service.providers.resolve('agentrouter');
  assert.equal(adapter.responsesPath, '/responses', 'a refused model cannot be switched to the endpoint that serves it');
});
