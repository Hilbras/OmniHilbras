#!/usr/bin/env node
/**
 * Gateway overhead, measured without a provider bill.
 *
 * A local adapter answers immediately, so the number left is the gateway's own work: body parse,
 * routing, credential/context lookup, dispatch and response encoding. It is a floor, not a promise
 * about a real provider's network — but it is stable, free, and catches a regression in the hot path.
 *
 *   node scripts/benchmark-gateway.mjs --n 100
 *   node scripts/benchmark-gateway.mjs --n 200 --json docs/reports/gateway-overhead.json
 */
const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const count = Math.max(1, Number(valueOf('--n', 100)) || 100);
const jsonPath = valueOf('--json', undefined);

const root = new URL('..', import.meta.url).pathname;
const { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } = await import(`${root}Kernel/API/dist/src/index.js`);
const { ProviderRegistry } = await import(`${root}Kernel/API/dist/src/core/index.js`);

const registry = new ProviderRegistry().register({
  id: 'bench', name: 'Benchmark', capabilities: { chat: true, streaming: true, models: true },
  async listModels() { return [{ id: 'bench-model', providerId: 'bench' }]; },
  async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 0, verified: 'inference' }; },
  async chat(request) {
    return { id: 'bench', providerId: 'bench', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
  },
  async *streamChat(request) {
    yield { id: 'bench', providerId: 'bench', model: request.model, delta: { content: 'ok' } };
  },
});

const store = new InMemoryConnectionStore();
await store.save({
  id: 'bench', providerId: 'bench', name: 'Benchmark', endpoint: 'https://bench.invalid/v1',
  priority: 1, proxyPool: 'none', enabled: true, modelIds: ['bench-model'],
}, { type: 'api-key', value: 'bench' });
const keys = new InMemoryApiKeyStore();
const key = (await keys.create('benchmark')).key;
const service = new GatewayService(registry, store, store, keys);
const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function timed(path, body) {
  const startedAt = performance.now();
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  await response.arrayBuffer();
  return performance.now() - startedAt;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const chat = [];
const stream = [];
for (let index = 0; index < count; index += 1) {
  chat.push(await timed('/v1/chat/completions', { model: 'bench-model', messages: [{ role: 'user', content: 'hi' }] }));
  stream.push(await timed('/v1/chat/completions', { model: 'bench-model', messages: [{ role: 'user', content: 'hi' }], stream: true }));
}
await new Promise((resolve) => server.close(resolve));

const report = {
  at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  requests: count,
  chat: { p50: percentile(chat, 50), p95: percentile(chat, 95), max: Math.max(...chat) },
  stream: { p50: percentile(stream, 50), p95: percentile(stream, 95), max: Math.max(...stream) },
  note: 'local adapter, immediate answer; measures gateway overhead only, not provider network time',
};
console.log(JSON.stringify(report, null, 2));
if (jsonPath) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
