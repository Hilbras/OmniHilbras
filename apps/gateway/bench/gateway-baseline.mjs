// Gateway baseline benchmark. Runs the real HTTP route against a deterministic in-process provider, so the
// numbers measure the gateway's own overhead, not a live provider's latency. Run after `pnpm build`.
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore, createGatewayServer } from '../dist/index.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

const PROVIDER_DELAY_MS = 5;
const CHUNKS = 20;
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 25);
const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 400);

function mockProvider() {
  return {
    id: 'mock',
    name: 'mock',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'm', providerId: 'mock' }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat() {
      await new Promise((r) => setTimeout(r, PROVIDER_DELAY_MS));
      return { id: 'r', providerId: 'mock', model: 'm', createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *streamChat() {
      for (let i = 0; i < CHUNKS; i += 1) {
        await new Promise((r) => setTimeout(r, 1));
        yield { id: `c${i}`, providerId: 'mock', model: 'm', delta: { content: 'x' } };
      }
    },
  };
}

async function start() {
  const registry = new ProviderRegistry().register(mockProvider());
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'conn-mock', providerId: 'mock', name: 'mock', endpoint: 'https://mock.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 30_000, hedgeAfterMs: 0 } }, { type: 'api-key', value: 'k' });
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('bench')).key;
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000_000, usageStore: new InMemoryUsageStore() });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, key };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function runPool(total, worker) {
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < total) {
      next += 1;
      await worker(next);
    }
  }));
  return performance.now() - started;
}

async function main() {
  const { server, base, key } = await start();
  try {
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    const latencies = [];
    let errors = 0;
    const wallNonStream = await runPool(REQUESTS, async () => {
      const t0 = performance.now();
      const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body });
      await res.text();
      if (res.status !== 200) errors += 1;
      latencies.push(performance.now() - t0);
    });
    latencies.sort((a, b) => a - b);

    const firstChunk = [];
    const streamBody = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const streamRequests = Math.max(20, Math.floor(REQUESTS / 4));
    const wallStream = await runPool(streamRequests, async () => {
      const t0 = performance.now();
      const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: streamBody });
      const reader = res.body.getReader();
      let seen = false;
      for (;;) {
        const { done } = await reader.read();
        if (!seen) { firstChunk.push(performance.now() - t0); seen = true; }
        if (done) break;
      }
    });
    firstChunk.sort((a, b) => a - b);

    const report = {
      environment: { node: process.version, platform: `${process.platform}-${process.arch}`, cpus: (await import('node:os')).cpus().length },
      workload: { providerDelayMs: PROVIDER_DELAY_MS, streamChunks: CHUNKS, concurrency: CONCURRENCY, nonStreamRequests: REQUESTS, streamRequests },
      nonStreaming: {
        p50Ms: round(percentile(latencies, 50)), p95Ms: round(percentile(latencies, 95)), p99Ms: round(percentile(latencies, 99)),
        throughputPerSec: round((REQUESTS / wallNonStream) * 1000), errors,
      },
      streaming: {
        firstChunkP50Ms: round(percentile(firstChunk, 50)), firstChunkP95Ms: round(percentile(firstChunk, 95)),
        throughputPerSec: round((streamRequests / wallStream) * 1000),
      },
      gatewayOverheadNote: `The provider adds ~${PROVIDER_DELAY_MS}ms per request; the non-streaming p50 above minus that is the gateway's own cost, measured here, not assumed.`,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    server.close();
  }
}

function round(value) { return Number.isFinite(value) ? Math.round(value * 100) / 100 : value; }

main().catch((error) => { console.error(error); process.exitCode = 1; });
