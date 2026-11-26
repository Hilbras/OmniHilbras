import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { OtelExporter, otelConfigFromEnv, spanFromUsage } from '../dist/src/core/otel.js';

function collector(t) {
  const bodies = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => { bodies.push(body); response.writeHead(200); response.end('{}'); });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => new Promise((done) => server.close(done)));
    resolve({ url: `http://127.0.0.1:${server.address().port}/v1/traces`, bodies });
  }));
}

test('a usage record becomes a span with counts and no prompt content', async (t) => {
  const collectorServer = await collector(t);
  const exporter = new OtelExporter({ endpoint: collectorServer.url, serviceName: 'test' });
  const span = spanFromUsage({
    requestId: 'abcdef0123456789abcdef0123456789', providerId: 'openai', model: 'gpt', outcome: 'success',
    latencyMs: 120, inputTokens: 3, outputTokens: 4, attempts: 1, apiKeyId: 'key_a', at: new Date().toISOString(),
  });
  assert.ok(span);
  exporter.record(span);
  await exporter.flush();
  assert.equal(collectorServer.bodies.length, 1);
  const body = JSON.parse(collectorServer.bodies[0]);
  const attributes = body.resourceSpans[0].scopeSpans[0].spans[0].attributes;
  const keys = attributes.map((entry) => entry.key);
  assert.ok(keys.includes('gen_ai.request.model'));
  assert.ok(keys.includes('gen_ai.usage.input_tokens'));
  assert.ok(!keys.some((key) => /prompt|message|content|argument/i.test(key)), 'a content-shaped attribute was exported');
});

test('a collector that is down drops spans instead of failing the caller', async () => {
  const exporter = new OtelExporter({ endpoint: 'http://127.0.0.1:1/v1/traces' });
  const span = spanFromUsage({ requestId: 'a'.repeat(32), model: 'm', outcome: 'success', latencyMs: 1, attempts: 1, at: new Date().toISOString() });
  exporter.record(span);
  await exporter.flush();
  assert.equal(exporter.dropped, 1);
});

test('no endpoint means no exporter, and a sample rate of zero drops everything', () => {
  assert.equal(otelConfigFromEnv({}), undefined);
  const exporter = new OtelExporter({ endpoint: 'http://127.0.0.1:1/x', sampleRate: 0 });
  exporter.record(spanFromUsage({ requestId: 'b'.repeat(32), model: 'm', outcome: 'success', latencyMs: 1, attempts: 1, at: new Date().toISOString() }));
  assert.equal(exporter.dropped, 0);
});
