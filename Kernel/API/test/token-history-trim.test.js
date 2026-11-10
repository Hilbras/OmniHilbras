import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { startRequestScope } from '../dist/src/core/request-context.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/** History trimming is a whole-turn saver: it keeps the request, the system prompt, the recent window and errors. */

const long = (prefix) => `${prefix} ${'x'.repeat(400)}`;

function registry(captured) {
  return new ProviderRegistry().register({
    id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request) {
      captured.push(request);
      return { id: 'r', providerId: 'p', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
    },
  });
}

async function serviceWith(options) {
  const captured = [];
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'p', providerId: 'p', name: 'P', endpoint: 'https://p.example/v1', priority: 1, proxyPool: 'none', modelIds: ['m'] }, { type: 'api-key', value: 'key' });
  const service = new GatewayService(registry(captured), store, store, new InMemoryApiKeyStore(), options);
  return { captured, service };
}

const messages = [
  { role: 'system', content: 'You are terse.' },
  { role: 'user', content: long('first request') },
  { role: 'assistant', content: long('old answer one') },
  { role: 'tool', toolCallId: 'call-1', content: long('old tool output') },
  { role: 'tool', toolCallId: 'call-2', isError: true, content: long('FATAL: database is locked') },
  { role: 'assistant', content: long('middle answer') },
  { role: 'user', content: 'recent question' },
  { role: 'assistant', content: 'recent answer' },
];

test('history trimming works without content compression, and the trimmed body is what the adapter receives', async () => {
  const { captured, service } = await serviceWith({ historyTrim: { maxInputTokens: 100, keepRecent: 2 } });
  const scope = startRequestScope({ requestedModel: 'm', id: 'history-trim-test' });
  await service.chat('p', { model: 'm', messages }, undefined, scope);

  const sent = captured[0].messages;
  assert.equal(sent.length, messages.length, 'the turn count must not change: whole messages are stubbed, not dropped');
  assert.deepEqual(sent[0], messages[0], 'the system prompt is kept');
  assert.deepEqual(sent[1], messages[1], 'the first user ask is kept');
  assert.deepEqual(sent[6], messages[6], 'the recent window is kept');
  assert.deepEqual(sent[7], messages[7], 'the last message is kept');
  assert.deepEqual(sent[4], messages[4], 'an error-bearing tool result is kept');
  assert.ok(String(sent[2].content).includes('token-saver:'), 'an old assistant turn is retrievable, not lost');

  const telemetry = service.takeCompressionTelemetry(scope.id);
  assert.ok(telemetry, 'no telemetry was recorded');
  assert.ok(telemetry.totalTokensSaved > 0);
  assert.ok(telemetry.savers['history-trim'], 'the saver is not attributable');
  assert.equal(telemetry.savers['history-trim'].requests, 1);
  assert.equal(service.takeCompressionTelemetry(scope.id), undefined, 'telemetry is handed out twice');
});

test('a conversation below the threshold is passed through untouched', async () => {
  const { captured, service } = await serviceWith({ historyTrim: { maxInputTokens: 1_000_000, keepRecent: 2 } });
  const scope = startRequestScope({ requestedModel: 'm', id: 'history-no-trim' });
  await service.chat('p', { model: 'm', messages }, undefined, scope);
  assert.deepEqual(captured[0].messages, messages);
  assert.equal(service.takeCompressionTelemetry(scope.id), undefined);
});

test('the cache-anchor flag reaches the adapter', async () => {
  const { captured, service } = await serviceWith({ cacheAnchor: true });
  await service.chat('p', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(captured[0].cacheAnchor, true);

  const { captured: plain, service: plainService } = await serviceWith({});
  await plainService.chat('p', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal('cacheAnchor' in plain[0], false, 'an unset anchor is not invented');
});
