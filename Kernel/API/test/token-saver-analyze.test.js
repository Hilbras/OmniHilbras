import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

/** The analysis endpoint is real, and it stores nothing. */
test('an analysis returns before/after and per-saver rows without persisting the text', async (t) => {
  const keys = new InMemoryApiKeyStore();
  const key = (await keys.create('analysis')).key;
  const service = new GatewayService(new ProviderRegistry(), new InMemoryConnectionStore(), new InMemoryConnectionStore(), keys, {
    tokenSaver: { enabled: true, targetRatio: 0.5, protectRecent: 2, compressUsers: true, compressCode: true, reversible: true, ccrLimit: 100 },
  });
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const text = `${'A long tool result line with repeated context. '.repeat(400)}`;
  const response = await fetch(`${base}/v1/token-saver/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ text }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.beforeBytes > 0);
  assert.ok(body.afterBytes <= body.beforeBytes);
  assert.ok(Array.isArray(body.savers));
  assert.equal(JSON.stringify(body).includes('A long tool result'), false, 'the analysed text came back in the response');
});
