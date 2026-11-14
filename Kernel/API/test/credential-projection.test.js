import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryProxyPoolStore, InMemoryTunnelStore, ProviderRegistry } from '../dist/src/core/index.js';
import { InMemoryApiKeyStore, InMemoryConnectionStore, GatewayService, createGatewayServer } from '../dist/src/index.js';

/**
 * Two credential-exposure findings from the security audit, as assertions.
 *
 * 1. **Tunnel tokens.** The management route returned the whole tunnel record, `token` included, and the
 *    store kept it in cleartext in the state directory. The token is enough to run `cloudflared`
 *    elsewhere and attach to the operator's named tunnel.
 * 2. **Proxy pool entries.** They were filtered by `typeof p === 'string'` — so a typo, a bare hostname,
 *    or any scheme got stored — and returned verbatim, credentials and all. A paid proxy's URL routinely
 *    carries `user:pass@`.
 */

function adapter(id) {
  return {
    id, name: id, capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    async listModels() { return [{ id: `model-${id}`, providerId: id }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request) { return { id: 'r', providerId: id, model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }; },
  };
}

async function gateway() {
  const store = new InMemoryConnectionStore();
  const keys = new InMemoryApiKeyStore();
  const key = (await keys.create('security')).key;
  const tunnels = new InMemoryTunnelStore();
  const proxyPools = new InMemoryProxyPoolStore();
  const service = new GatewayService(new ProviderRegistry().register(adapter('a')), store, store, keys, { tunnels, proxyPools });
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    key, tunnels, proxyPools,
    close: () => new Promise((resolve) => server.close(resolve)),
    call: (path, init = {}) => fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
    }),
  };
}

const tunnelToken = 'cf-tunnel-secret-value-should-never-be-returned';

test('a tunnel token is never returned by the API, and its presence is', async (t) => {
  const gw = await gateway();
  t.after(gw.close);

  const created = await gw.call('/v1/tunnels', {
    method: 'POST',
    body: JSON.stringify({ id: 'office', name: 'Office', provider: 'cloudflare', token: tunnelToken, publicUrl: 'https://office.example' }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal('token' in createdBody.tunnel, false, 'the create response must not carry the token');
  assert.equal(createdBody.tunnel.hasToken, true, 'it must say that a token is stored');

  const listed = await (await gw.call('/v1/tunnels')).json();
  assert.equal(listed.data.length, 1);
  assert.equal('token' in listed.data[0], false, 'the list response must not carry the token');
  assert.equal(listed.data[0].hasToken, true);

  const fetched = await (await gw.call('/v1/tunnels/office')).json();
  assert.equal('token' in fetched.tunnel, false, 'the single-record response must not carry the token');

  // The value is still stored: redacting the response must not break the feature it exists for.
  const stored = await gw.tunnels.get('office');
  assert.equal(stored.token, tunnelToken, 'the token is still stored for the tunnel to be started');

  // And the whole response body must not contain the secret anywhere, including nested fields.
  assert.equal(JSON.stringify(listed).includes(tunnelToken), false);
});

test('proxy credentials are stored but redacted on the way out', async (t) => {
  const gw = await gateway();
  t.after(gw.close);

  const created = await gw.call('/v1/proxy-pools', {
    method: 'POST',
    body: JSON.stringify({ id: 'paid', name: 'Paid', proxies: ['http://user:secret@proxy.example:8080', 'socks5://proxy.example:1080'] }),
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.deepEqual(body.proxyPool.proxies, ['http://***:***@proxy.example:8080', 'socks5://proxy.example:1080']);

  const listed = await (await gw.call('/v1/proxy-pools')).json();
  assert.equal(JSON.stringify(listed).includes('secret'), false, 'no response may carry the credential');

  const stored = await gw.proxyPools.get('paid');
  assert.equal(stored.proxies[0], 'http://user:secret@proxy.example:8080', 'the stored entry keeps its credential, which is what the proxy needs');
});

test('a proxy entry that is not a usable proxy is refused, and the refusal does not quote it', async (t) => {
  const gw = await gateway();
  t.after(gw.close);

  const bad = await gw.call('/v1/proxy-pools', { method: 'POST', body: JSON.stringify({ id: 'bad', proxies: ['proxy.example:8080'] }) });
  assert.equal(bad.status, 400, 'a bare host:port is not a URL and must be refused');

  const wrongScheme = await gw.call('/v1/proxy-pools', { method: 'POST', body: JSON.stringify({ id: 'wrong', proxies: ['ftp://proxy.example'] }) });
  assert.equal(wrongScheme.status, 400);

  // An error message is a log line, so it must not echo a credential.
  const leaky = await gw.call('/v1/proxy-pools', { method: 'POST', body: JSON.stringify({ id: 'leak', proxies: ['http://user:secret@proxy.example:8080'] }) });
  assert.equal(leaky.status, 201, 'a valid proxy with credentials is accepted');
  const ftpWithCredential = await gw.call('/v1/proxy-pools', { method: 'POST', body: JSON.stringify({ id: 'leak2', proxies: ['ftp://user:secret@proxy.example'] }) });
  const text = await ftpWithCredential.text();
  assert.equal(ftpWithCredential.status, 400);
  assert.equal(text.includes('secret'), false, 'the refusal must not quote the value it refused');
  assert.match(text, /ftp:/, 'but it should name the scheme, which is the actionable part');
});
