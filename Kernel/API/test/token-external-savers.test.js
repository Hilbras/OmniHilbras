import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { startRequestScope } from '../dist/src/core/request-context.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../dist/src/index.js';

/** Prompt shaping and external savers are opt-in, fail open, and report skipped as skipped. */

const plain = [
  { role: 'system', content: 'base instruction' },
  { role: 'user', content: 'x'.repeat(2_000) },
  { role: 'assistant', content: 'ok' },
];

const shortened = [
  { role: 'system', content: 'base instruction' },
  { role: 'user', content: 'x'.repeat(100) },
  { role: 'assistant', content: 'ok' },
];

function adapter(id, captured) {
  return {
    id, name: id, capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    ...(id === 'anthropic' ? { imageContext: true } : {}),
    async listModels() { return [{ id: 'm', providerId: id }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request) {
      captured.push(request);
      return { id: 'r', providerId: id, model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
    },
  };
}

async function serviceWith(options, providers = ['p']) {
  const captured = [];
  const registry = new ProviderRegistry();
  const store = new InMemoryConnectionStore();
  for (const providerId of providers) {
    registry.register(adapter(providerId, captured));
    await store.save({ id: providerId, providerId, name: providerId, endpoint: 'https://p.example/v1', priority: 1, proxyPool: 'none', modelIds: ['m'] }, { type: 'api-key', value: 'key' });
  }
  return { captured, service: new GatewayService(registry, store, store, new InMemoryApiKeyStore(), options) };
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('caveman and ponytail add one system instruction and are reported as ran', async () => {
  const { captured, service } = await serviceWith({ caveman: { level: 'full' }, ponytail: { level: 'lite' } });
  const scope = startRequestScope({ requestedModel: 'm', id: 'prompt-test' });
  await service.chat('p', { model: 'm', messages: plain }, undefined, scope);

  const system = String(captured[0].messages[0].content);
  assert.match(system, /^base instruction\n\n/, 'the existing system prompt was not kept first');
  assert.match(system, /terse caveman/);
  assert.match(system, /lazy senior developer/);
  assert.equal(captured[0].messages.length, plain.length, 'no duplicate system turn was added');

  const telemetry = service.takeCompressionTelemetry(scope.id);
  assert.equal(telemetry?.savers.caveman?.state, 'ran');
  assert.equal(telemetry?.savers.caveman?.detail, 'full');
  assert.equal(telemetry?.savers.ponytail?.state, 'ran');
});

test('a per-request opt-out skips every configured saver', async () => {
  const { captured, service } = await serviceWith({ caveman: { level: 'full' } });
  const scope = startRequestScope({ requestedModel: 'm', id: 'opt-out', tokenSaver: false });
  await service.chat('p', { model: 'm', messages: plain }, undefined, scope);
  assert.deepEqual(captured[0].messages, plain);
  assert.equal(service.takeCompressionTelemetry(scope.id), undefined);
});

test('headroom shrink is applied and a failure is reported as skipped, never as a saving', async () => {
  await withServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (JSON.parse(body).model === 'broken') {
        response.writeHead(500); response.end('down'); return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ messages: shortened, tokens_saved: 400 }));
    });
  }, async (url) => {
    const { captured, service } = await serviceWith({ headroom: { url, timeoutMs: 1_000 } });
    const applied = startRequestScope({ requestedModel: 'm', id: 'headroom-applied' });
    await service.chat('p', { model: 'm', messages: plain }, undefined, applied);
    assert.deepEqual(captured[0].messages, shortened);
    const telemetry = service.takeCompressionTelemetry(applied.id);
    assert.equal(telemetry?.savers.headroom?.state, 'ran');
    assert.ok((telemetry?.savers.headroom?.tokensSaved ?? 0) > 0);

    const failed = startRequestScope({ requestedModel: 'm', id: 'headroom-failed' });
    await service.chat('p', { model: 'broken', messages: plain }, undefined, failed);
    assert.deepEqual(captured[1].messages, plain, 'a failed proxy changed the conversation');
    const skipped = service.takeCompressionTelemetry(failed.id);
    assert.equal(skipped?.savers.headroom?.state, 'skipped');
    assert.match(skipped?.savers.headroom?.detail ?? '', /HTTP 500/);
    assert.equal(skipped?.savers.headroom?.tokensSaved, 0);
  });
});

test('pxpipe runs only for an Anthropic provider, and not for another provider', async () => {
  let calls = 0;
  await withServer((request, response) => {
    calls += 1;
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ applied: true, messages: shortened, imageCount: 1, imageTokens: 4761 }));
  }, async (url) => {
    const { captured, service } = await serviceWith({ pxpipe: { url, minChars: 1_000 } }, ['p', 'anthropic']);

    const other = startRequestScope({ requestedModel: 'm', id: 'px-other' });
    await service.chat('p', { model: 'm', messages: plain }, undefined, other);
    assert.equal(calls, 0, 'pxpipe was called for a non-Anthropic provider');
    assert.equal(service.takeCompressionTelemetry(other.id), undefined);

    const anthropic = startRequestScope({ requestedModel: 'm', id: 'px-anthropic' });
    await service.chat('anthropic', { model: 'm', messages: plain }, undefined, anthropic);
    assert.equal(calls, 1);
    assert.deepEqual(captured[1].messages, shortened);
    const telemetry = service.takeCompressionTelemetry(anthropic.id);
    assert.equal(telemetry?.savers.pxpipe?.state, 'ran');
  });
});
