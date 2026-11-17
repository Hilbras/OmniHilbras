import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';
import { ProviderRegistry } from '../dist/src/core/index.js';

/**
 * OpenCode Go, as the gateway serves it.
 *
 * The adapter has its own test (`Kernel/SDK/tests/opencode-go.test.js`); this proves the service hands that adapter
 * the transport it was configured with, so the header the SDK sends is the header the gateway's own request carries.
 * It exists because Go used to be `new ZenAdapter({ base: ... })` inside this file, and a wiring test is the only
 * thing that would have noticed the class it built was the one without the session.
 */

const connection = { id: 'opencode-go', providerId: 'opencode-go', name: 'OpenCode Go', endpoint: 'https://opencode.ai/zen/go', priority: 1, proxyPool: 'none', modelIds: ['glm-5.3'] };

function serviceWith(transport) {
  const registry = new ProviderRegistry();
  const store = new InMemoryConnectionStore();
  return { registry, store, service: new GatewayService(registry, store, store, new InMemoryApiKeyStore(), { transport }) };
}

test('the gateway request for a Go model carries x-opencode-session', async () => {
  const requests = [];
  const transport = {
    async request(request) {
      requests.push(request);
      return { status: 200, headers: new Headers(), data: { id: 'r', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } };
    },
    async *stream(request) {
      requests.push(request);
      yield `data: ${JSON.stringify({ id: 'r', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`;
      yield 'data: [DONE]\n\n';
    },
  };
  const { store, service } = serviceWith(transport);
  await store.save(connection, { type: 'api-key', value: 'go-key' });

  const response = await service.chat('opencode-go', { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(response.message.content, 'ok');

  const sent = requests.at(-1);
  assert.equal(sent.url, 'https://opencode.ai/zen/go/v1/chat/completions', 'Go did not use its own base');
  assert.match(sent.headers['x-opencode-session'], /^ses_/, 'the gateway request went out without the session the lane routes by');
  assert.equal(sent.headers.Authorization, 'Bearer go-key');
});
