import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

/**
 * The two connection routes the dashboard leans on to manage accounts.
 *
 * `PUT /v1/connections/:id` reports **which** account a credential belongs to, and
 * `PUT /v1/connections/:id/enabled` pauses one without re-saving it. Both are asserted over HTTP
 * rather than at the manager, because the defect worth guarding is a route that parses the body and
 * then drops the answer — the dashboard would read "saved" in either case.
 */

async function startServer(t) {
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({}), new InMemoryConnectionStore());
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173', publicBaseUrl: 'http://127.0.0.1:8787' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, 'object');
  return `http://127.0.0.1:${address.port}`;
}

/**
 * A provider the registry has never heard of, at a public IP literal.
 *
 * Unregistered means no validator and no discovered catalog, so the save is entirely local — which is
 * what makes this a route test rather than a network test. The literal is public, so the destination
 * check judges it without a DNS lookup.
 */
const saveBody = (id, apiKey) => JSON.stringify({
  id,
  apiKey,
  name: id,
  endpoint: 'https://93.184.216.34/v1',
  priority: 1,
  proxyPool: 'none',
});

test('the same API key saved twice is reported as the existing account, not a second one', async (t) => {
  const base = await startServer(t);
  const first = await fetch(`${base}/v1/connections/customthing`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: saveBody('customthing-a', 'sk-one-account'),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.duplicate, undefined, 'a first save is not a duplicate of anything');
  assert.equal('credentialFingerprint' in firstBody.connection, false, 'the credential fingerprint is not a management response field');

  const second = await fetch(`${base}/v1/connections/customthing`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: saveBody('customthing-b', 'sk-one-account'),
  });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.duplicate, 'identical');
  assert.equal(secondBody.connection.id, 'customthing-a', 'the response names the account that already holds the key');

  const list = await (await fetch(`${base}/v1/connections`)).json();
  assert.equal(list.data.length, 1, 'and nothing was written beside it');
});

test('a different key is a new account, and the route says nothing about duplicates', async (t) => {
  const base = await startServer(t);
  for (const [id, key] of [['customthing-a', 'sk-first'], ['customthing-b', 'sk-second']]) {
    const response = await fetch(`${base}/v1/connections/customthing`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: saveBody(id, key),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).duplicate, undefined);
  }
  const list = await (await fetch(`${base}/v1/connections`)).json();
  assert.equal(list.data.length, 2);
});

test('pausing an account over HTTP changes its state and touches nothing else', async (t) => {
  const base = await startServer(t);
  await fetch(`${base}/v1/connections/customthing`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: saveBody('customthing-a', 'sk-pause-me'),
  });

  const paused = await fetch(`${base}/v1/connections/customthing-a/enabled`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(paused.status, 200);
  const body = await paused.json();
  assert.equal(body.connection.enabled, false);
  assert.equal(body.connection.id, 'customthing-a');

  const listed = await (await fetch(`${base}/v1/connections`)).json();
  assert.equal(listed.data[0].enabled, false, 'the state is persisted, not only returned');
  assert.equal(listed.data[0].modelIds.length, 0, 'and no catalog was re-read');
});

test('a pause body that is not a boolean is refused by name', async (t) => {
  const base = await startServer(t);
  await fetch(`${base}/v1/connections/customthing`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: saveBody('customthing-a', 'sk-pause-me'),
  });
  const response = await fetch(`${base}/v1/connections/customthing-a/enabled`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: 'no' }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /enabled must be a boolean/);
});

test('pausing an account that does not exist is a 404, not a silent success', async (t) => {
  const base = await startServer(t);
  const response = await fetch(`${base}/v1/connections/missing-account/enabled`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(response.status, 404);
});