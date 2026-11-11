import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';

// The Servers page says "the gateway is up"; this route says what machine it is up on. It is a
// measurement, so the assertion is about ranges and shape, not a fixed number a busy CI box would
// make flaky.

async function start(t) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('system')).key;
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), apiKeys);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, key };
}

test('the system route refuses an unauthenticated caller', async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/v1/system`);
  assert.equal(response.status, 401, 'machine load is management data, not public status');
});

test('the system route reports a live CPU and memory sample, not invented numbers', async (t) => {
  const { base, key } = await start(t);
  const started = Date.now();
  const response = await fetch(`${base}/v1/system`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const body = await response.json();

  assert.ok(Date.parse(body.sampledAt) >= started - 1000, 'sampledAt names when the sample was taken');
  assert.equal(typeof body.cpu.percent, 'number');
  assert.ok(body.cpu.percent >= 0 && body.cpu.percent <= 100, `cpu.percent was ${body.cpu.percent}`);
  assert.ok(Number.isInteger(body.cpu.cores) && body.cpu.cores >= 1, 'a machine has at least one core');
  assert.equal(body.cpu.loadAverage.length, 3);

  assert.ok(body.memory.totalBytes > 0, 'total memory must be a real size');
  assert.ok(body.memory.freeBytes >= 0);
  assert.ok(body.memory.usedBytes >= 0);
  assert.equal(body.memory.usedBytes + body.memory.freeBytes, body.memory.totalBytes);
  assert.ok(body.memory.percent >= 0 && body.memory.percent <= 100, `memory.percent was ${body.memory.percent}`);

  assert.ok(Number.isInteger(body.uptimeSeconds) && body.uptimeSeconds >= 0);
  assert.equal(/hostname|authorization|token/i.test(JSON.stringify(body)), false, 'the sample carries no host identity or credential');
});
