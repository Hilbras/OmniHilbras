import assert from 'node:assert/strict';
import test from 'node:test';
import { createSocket } from 'node:dgram';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore, createGatewayServer } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { clearDestinationCache } from '../dist/src/core/destination-check.js';

/**
 * POST /v1/fetch: a real bounded document read, not a placeholder URL.
 *
 * The transport is scripted so no provider is billed and no network is needed for the success case.
 * The DNS stub exists for the SSRF case: a hostname whose *text* looks public but whose A record is
 * 127.0.0.1. `url.ts` only judges hostname text, so this case proves the route uses the async
 * `assertPublicDestination` guard rather than that cheaper check.
 */

const answers = {
  'private-resolves.test': '127.0.0.1',
  'public.example.test': '93.184.216.34',
};
const dns = createSocket('udp4');
dns.unref();
dns.on('message', (message, rinfo) => {
  if (message.length < 12 || message.readUInt16BE(4) !== 1) return;
  const labels = [];
  let offset = 12;
  while (offset < message.length && message[offset] !== 0) {
    const length = message[offset];
    labels.push(message.subarray(offset + 1, offset + 1 + length).toString());
    offset += 1 + length;
  }
  const end = offset + 5;
  const header = Buffer.from(message.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  const answer = answers[labels.join('.').toLowerCase()];
  header.writeUInt16BE(answer ? 1 : 0, 6);
  const parts = [header, message.subarray(12, end)];
  if (answer) {
    const record = Buffer.alloc(16);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(1, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(0, 6);
    record.writeUInt16BE(4, 10);
    answer.split('.').forEach((octet, index) => record.writeUInt8(Number(octet), 12 + index));
    parts.push(record);
  }
  void dns.send(Buffer.concat(parts), rinfo.port, rinfo.address);
});
await new Promise((resolve) => dns.bind(0, '127.0.0.1', resolve));
process.env.OMNIHILBRAS_PUBLIC_DNS = `127.0.0.1:${dns.address().port}`;
clearDestinationCache();

function scriptedTransport({ body = 'a'.repeat(300), status = 200 } = {}) {
  return {
    calls: [],
    async request(request) {
      this.calls.push(request);
      return { status, headers: new Headers({ 'content-type': 'text/plain' }), data: body };
    },
    async *stream() { throw new Error('fetch must not stream'); },
  };
}

async function gateway(t, { transport = scriptedTransport() } = {}) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('fetch')).key;
  const usage = new InMemoryUsageStore();
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore(), apiKeys, { usageStore: usage, transport });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    key,
    usage,
    transport,
    post: (body) => fetch(`http://127.0.0.1:${server.address().port}/v1/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    }),
  };
}

test('a bounded fetch reaches the transport and returns its text with a request id', async (t) => {
  const gw = await gateway(t);
  const response = await gw.post({ url: 'https://public.example.test/doc', maxBytes: 64 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'fetch');
  assert.equal(body.status, 200);
  assert.equal(body.bytes, 64, 'the response is bounded to maxBytes');
  assert.equal(body.truncated, true);
  assert.equal(body.text, 'a'.repeat(64));
  assert.ok(body.gateway.requestId, 'the caller can quote a request id');
  assert.equal(gw.transport.calls.length, 1, 'one real transport call');
  assert.equal(gw.transport.calls[0].url, 'https://public.example.test/doc');

  const records = await gw.usage.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].model, 'web-fetch');
  assert.equal(records[0].requestId, body.gateway.requestId);
  const forbidden = ['prompt', 'response', 'messages', 'text', 'content', 'body'];
  for (const key of forbidden) assert.equal(key in records[0], false, `a usage record leaked ${key}`);
});

test('a named provider without a fetch capability is refused by name', async (t) => {
  const gw = await gateway(t);
  const response = await gw.post({ url: 'https://public.example.test/doc', provider: 'fake-provider' });
  assert.equal(response.status, 501);
  const body = await response.json();
  assert.equal(body.error.code, 'NOT_SUPPORTED');
  assert.match(body.error.message, /fake-provider.*does not support web fetch/);
  assert.equal(gw.transport.calls.length, 0, 'a refused provider never reaches the transport');
});

test('SSRF: http loopback literals, loopback names and private-resolving names are refused', async (t) => {
  const gw = await gateway(t);
  for (const url of ['http://127.0.0.1/admin', 'https://localhost/admin', 'https://private-resolves.test/admin']) {
    const response = await gw.post({ url });
    assert.equal(response.status, 400, `${url} was allowed through`);
    const body = await response.json();
    assert.equal(body.error.code, 'INVALID_REQUEST');
  }
  assert.equal(gw.transport.calls.length, 0, 'no refused destination reached the transport');
});
