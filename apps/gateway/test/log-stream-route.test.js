import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore, createGatewayServer } from '../dist/index.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

// The operator watches a long swarm run through this stream. It carries the same fields the usage store keeps, so a
// line can show what happened without any message content or credential.

async function start(t) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('logs')).key;
  const usage = new InMemoryUsageStore();
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), apiKeys, { failureThreshold: 3, usageStore: usage });
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, key, service, server };
}

test('the log stream is an admin route: an unauthenticated caller is refused', async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/v1/logs/stream`);
  assert.equal(response.status, 401, 'an unauthenticated caller cannot watch requests');
});

test('the log stream sends each finished request as an event, with no message content', async (t) => {
  const { base, key, service, server } = await start(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/v1/logs/stream`, { headers: { authorization: `Bearer ${key}` }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  await service.usage.record({ at: new Date().toISOString(), model: 'fake-1', providerId: 'fake', connectionId: 'c1', outcome: 'success', attempts: 1, latencyMs: 12, requestId: 'req-1' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 3000;
  while (!text.includes('req-1') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  assert.match(text, /data: .*"requestId":"req-1"/, 'the finished request appears on the stream');
  assert.equal(/"(content|messages|prompt)"/.test(text), false, 'no message content is streamed');
});
