import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';
import { CLAUDE_TOOL_SUFFIX, DECOY_CALL_NAME } from '@omnihilbras/tools';

/**
 * Claude tool cloaking at the seam the gateway actually uses.
 *
 * The Tools package owns the rename/restore decision; this file proves the gateway applies it to Claude
 * connections only, that the client's declared names are what come back, and that a decoy call never
 * reaches the client — in both the non-streaming and the streaming path.
 */

const tool = (name) => ({ name, description: `${name} tool`, parameters: { type: 'object', properties: {} } });
const call = (name, id) => ({ id, type: 'function', function: { name, arguments: '{}' } });

function harness({ response, chunks } = {}) {
  const requests = [];
  const registry = new ProviderRegistry();
  for (const id of ['anthropic', 'claude-code', 'openai']) {
    registry.register({
      id,
      name: id,
      capabilities: { chat: true, streaming: true, models: true },
      async listModels() { return [{ id: 'm', providerId: id }]; },
      async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
      async chat(request) {
        requests.push(request);
        return response?.(request, id) ?? {
          id: 'r', providerId: id, model: request.model, createdAt: new Date().toISOString(),
          message: { role: 'assistant', content: 'ok' }, finishReason: 'stop',
        };
      },
      async *streamChat(request) {
        requests.push(request);
        for (const chunk of chunks?.(request, id) ?? []) yield chunk;
      },
    });
  }
  const store = new InMemoryConnectionStore();
  for (const id of ['anthropic', 'claude-code', 'openai']) {
    void store.save({ id, providerId: id, name: id, endpoint: 'https://example.invalid/v1', priority: 1, proxyPool: 'none', modelIds: ['m'] }, { type: 'api-key', value: 'key' });
  }
  const service = new GatewayService(registry, store, store, new InMemoryApiKeyStore(), {});
  return { requests, service };
}

test('a Claude connection sends cloaked names and unavailable decoys; another provider does not', async () => {
  const { service } = harness();
  const request = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('lookup')] };
  const claude = await service.applyToolContract('anthropic', request);
  const names = (claude.request.tools ?? []).map((entry) => entry.name);
  assert.equal(names[0], `lookup${CLAUDE_TOOL_SUFFIX}`, 'the client name reached the provider uncloaked');
  assert.ok(names.includes('Read') && names.includes('WebFetch'), 'the decoys are missing');
  assert.equal(names.includes('Bash'), false, 'a shell tool reached the provider');
  assert.deepEqual(claude.declared, ['lookup'], 'a decoy was added to the client allow list');
  assert.equal(claude.renames.get(`lookup${CLAUDE_TOOL_SUFFIX}`), 'lookup');
  assert.equal(claude.renames.get('Read'), DECOY_CALL_NAME);

  const other = await service.applyToolContract('openai', request);
  assert.deepEqual((other.request.tools ?? []).map((entry) => entry.name), ['lookup'], 'a non-Claude provider was cloaked');
  assert.equal(other.cloaked, false);
});

test('a Claude connection reached through an alias connection is cloaked too', async () => {
  const { service } = harness();
  const result = await service.applyToolContract('openai', {
    model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('lookup')],
  }, false, 'anthropic');
  assert.equal(result.cloaked, true, 'the connection’s provider decides the cloak, not just the route id');
  assert.equal((result.request.tools ?? [])[0].name, `lookup${CLAUDE_TOOL_SUFFIX}`);
});

test('the client sees its own declared name; a decoy call is dropped from a non-streaming answer', async () => {
  const { service } = harness({
    response: (request) => ({
      id: 'r', providerId: 'anthropic', model: request.model, createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: null, toolCalls: [call(`lookup${CLAUDE_TOOL_SUFFIX}`, 'c1'), call('Read', 'c2')] },
      finishReason: 'tool_calls',
    }),
  });
  const response = await service.chat('anthropic', {
    model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('lookup')],
  });
  assert.deepEqual(response.message.toolCalls, [call('lookup', 'c1')], 'a cloaked or decoy name reached the client');
  assert.equal(response.finishReason, 'tool_calls');
});

test('the streaming guard restores a cloaked name and swallows a decoy call', async () => {
  const { service } = harness({
    chunks: () => [
      { id: 'r', providerId: 'anthropic', model: 'm', delta: { toolCalls: [{ index: 0, id: 'c1', type: 'function', function: { name: `lookup${CLAUDE_TOOL_SUFFIX}`, arguments: '' } }] } },
      { id: 'r', providerId: 'anthropic', model: 'm', delta: { toolCalls: [{ index: 1, id: 'c2', type: 'function', function: { name: 'Read', arguments: '' } }] } },
      { id: 'r', providerId: 'anthropic', model: 'm', delta: { content: 'ok' }, finishReason: 'tool_calls' },
    ],
  });
  const chunks = [];
  for await (const chunk of service.streamChat('anthropic', {
    model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('lookup')],
  })) chunks.push(chunk);

  const names = chunks.flatMap((chunk) => (chunk.delta?.toolCalls ?? []).map((piece) => piece.function?.name));
  assert.deepEqual(names, ['lookup'], 'a cloaked or decoy name reached the streaming client');
  assert.equal(chunks.at(-1).finishReason, 'tool_calls', 'one real call survived, so the turn is still a tool turn');
});

test('a provider that declared the decoy name keeps its own tool', async () => {
  const { service } = harness({
    response: (request) => ({
      id: 'r', providerId: 'anthropic', model: request.model, createdAt: new Date().toISOString(),
      message: { role: 'assistant', content: null, toolCalls: [call(`Read${CLAUDE_TOOL_SUFFIX}`, 'c1')] },
      finishReason: 'tool_calls',
    }),
  });
  const contracted = await service.applyToolContract('anthropic', {
    model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('Read')],
  });
  const names = (contracted.request.tools ?? []).map((entry) => entry.name);
  assert.equal(names.filter((name) => name === 'Read').length, 0, 'the decoy shadowed a client tool of the same name');
  const response = await service.chat('anthropic', {
    model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [tool('Read')],
  });
  assert.deepEqual(response.message.toolCalls, [call('Read', 'c1')]);
});
