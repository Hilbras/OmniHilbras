#!/usr/bin/env node
/**
 * Bounded concurrency benchmark: gateway overhead under N simultaneous requests.
 *
 * Complements `benchmark-gateway.mjs`, which measures overhead one request at a time. The 2026-11-19 baseline
 * recorded p50 447 ms / p99 1357 ms at concurrency 400 against a local adapter; that measurement had no
 * committed harness. This restores one so the number is reproducible rather than a claim in a report.
 *
 *   node scripts/benchmark-concurrency.mjs --n 400 --concurrency 400
 *
 * No provider is contacted: the adapter answers immediately, so the figures are the gateway's own queueing
 * and event-loop cost, not a network promise. Run with a fixed local gateway on an ephemeral port.
 */
const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const count = Math.max(1, Number(valueOf('--n', 400)) || 400);
const concurrency = Math.max(1, Number(valueOf('--concurrency', 400)) || 400);

const root = new URL('..', import.meta.url).pathname;
const { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } = await import(`${root}Kernel/API/dist/src/index.js`);
const { ProviderRegistry } = await import(`${root}Kernel/API/dist/src/core/index.js`);

const registry = new ProviderRegistry().register({
  id: 'bench', name: 'Benchmark', capabilities: { chat: true, streaming: false, models: true },
  async listModels() { return [{ id: 'bench-model', providerId: 'bench' }]; },
  async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 0 }; },
  async chat(request) {
    return { id: 'bench', providerId: 'bench', model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
  },
});
const store = new InMemoryConnectionStore();
await store.save({ id: 'bench', providerId: 'bench', name: 'Benchmark', endpoint: 'https://bench.invalid/v1', priority: 1, proxyPool: 'none', enabled: true, modelIds: ['bench-model'] }, { type: 'api-key', value: 'bench' });
const keys = new InMemoryApiKeyStore();
await keys.setEnforced(false);
// No auth on the hot path: measure gateway queueing, not key parsing. Gate is off in local mode.
const service = new GatewayService(registry, new (await import(`${root}Kernel/API/dist/src/core/index.js`)).InMemorySecretStore({}), store, keys, { failureThreshold: 1000 });
service.setHealthInterval(0);
const server = createGatewayServer(service, { requestsPerMinute: 0 });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const latencies = [];
const errors = [];
let next = 0;
async function worker() {
  while (next < count) {
    const index = next++;
    const started = performance.now();
    try {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'bench-model', messages: [{ role: 'user', content: `ping ${index}` }] }),
      });
      await response.arrayBuffer();
      latencies.push(performance.now() - started);
      if (!response.ok) errors.push(response.status);
    } catch (error) {
      errors.push(String(error));
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
latencies.sort((left, right) => left - right);
const at = (percentile) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * percentile))] ?? 0;
console.log(JSON.stringify({
  node: process.version,
  requests: count,
  concurrency,
  p50: Number(at(0.5).toFixed(2)),
  p95: Number(at(0.95).toFixed(2)),
  p99: Number(at(0.99).toFixed(2)),
  errors: errors.length,
  note: 'local adapter, immediate answer; gateway queueing only, no provider network',
}, null, 2));
await new Promise((resolve) => server.close(resolve));
