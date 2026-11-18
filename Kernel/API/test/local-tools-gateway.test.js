import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'oh-gateway-tools-'));
  writeFileSync(join(root, 'notes.txt'), 'hello from disk\n');
  return root;
}

/** Builds a service while the local-tool env is set, then restores the process env. */
function serviceWith(providerId, adapter, root) {
  const saved = { ...process.env };
  process.env.OMNIHILBRAS_LOCAL_TOOLS = '1';
  process.env.OMNIHILBRAS_LOCAL_TOOL_ROOTS = root;
  try {
    const registry = new ProviderRegistry().register({
      ...adapter,
      id: providerId,
      name: providerId,
      capabilities: { chat: true, streaming: true, models: true },
      async listModels() { return [{ id: 'm', providerId }]; },
      async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
    });
    const connections = new InMemoryConnectionStore();
    void connections.save({ id: providerId, providerId, name: providerId, endpoint: 'https://example.invalid/v1', priority: 1, proxyPool: 'none', modelIds: ['m'] }, { type: 'api-key', value: 'k' });
    return new GatewayService(registry, new InMemorySecretStore({ [providerId]: { type: 'api-key', value: 'k' } }), connections, undefined, {});
  } finally {
    process.env = saved;
  }
}

test('a native provider can call a local read tool and gets the result on the next round', async () => {
  const root = sandbox();
  const seen = [];
  let round = 0;
  const adapter = {
    async chat(request) {
      seen.push(request);
      round += 1;
      if (round === 1) {
        return {
          id: 'r1', providerId: 'openai', model: 'm', createdAt: new Date().toISOString(),
          message: { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'local_read', arguments: '{"path":"notes.txt"}' } }] },
          finishReason: 'tool_calls',
        };
      }
      return { id: 'r2', providerId: 'openai', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
    },
    async *streamChat() { throw new Error('not used'); },
  };
  const service = serviceWith('openai', adapter, root);
  const response = await service.chat('openai', { model: 'm', messages: [{ role: 'user', content: 'read the note' }] });
  assert.equal(response.message.content, 'done');
  assert.equal(seen.length, 2, 'the tool result was not fed back to the provider');
  const result = seen[1].messages.find((message) => message.role === 'tool');
  assert.equal(result.content, 'hello from disk\n');
  assert.ok(seen[0].tools.some((tool) => tool.name === 'local_read'), 'the local tool was not declared to the provider');
});

test('a provider without tools reaches the same local tool through the prompt form', async () => {
  const root = sandbox();
  const seen = [];
  let round = 0;
  const adapter = {
    async chat(request) {
      seen.push(request);
      round += 1;
      if (round === 1) {
        return {
          id: 'r1', providerId: 'qwen-web', model: 'm', createdAt: new Date().toISOString(),
          message: { role: 'assistant', content: '```local-tool\n{"name":"local_read","arguments":{"path":"notes.txt"}}\n```' },
          finishReason: 'stop',
        };
      }
      return { id: 'r2', providerId: 'qwen-web', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
    },
    async *streamChat() { throw new Error('not used'); },
  };
  const service = serviceWith('qwen-web', adapter, root);
  const response = await service.chat('qwen-web', { model: 'm', messages: [{ role: 'user', content: 'read the note' }] });
  assert.equal(response.message.content, 'done');
  assert.equal(seen.length, 2, 'the prompt tool round did not happen');
  assert.match(seen[0].messages.map((message) => message.content).join('\n'), /You have read-only local tools/);
  const result = seen[1].messages.at(-1);
  assert.match(result.content, /hello from disk/);
});
