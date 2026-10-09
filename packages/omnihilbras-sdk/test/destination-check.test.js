import assert from 'node:assert/strict';
import test from 'node:test';
import { FetchHttpTransport, ProviderError } from '../dist/index.js';

const okFetch = () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
};

test('a remote request is offered to the destination check by hostname before it is sent', async () => {
  const { fetch, calls } = okFetch();
  const checked = [];
  const transport = new FetchHttpTransport({ fetch, checkDestination: async (host) => { checked.push(host); } });
  await transport.request({ method: 'GET', url: 'https://api.example.com/v1/models', providerId: 'p' });
  assert.deepEqual(checked, ['api.example.com']);
  assert.equal(calls.length, 1, 'the request is sent once the check passes');
});

test('a refused destination stops the request before it is sent, with the provider error shape', async () => {
  const { fetch, calls } = okFetch();
  const transport = new FetchHttpTransport({
    fetch,
    checkDestination: async () => { throw new Error('resolves to a private address'); },
  });
  await assert.rejects(
    () => transport.request({ method: 'GET', url: 'https://evil.example.com/x', providerId: 'p' }),
    (error) => error instanceof ProviderError && error.code === 'CONFIGURATION_ERROR',
  );
  assert.equal(calls.length, 0, 'nothing reaches the network when the check refuses');
});

test('loopback hosts are the local-inference exemption and are not checked', async () => {
  const { fetch, calls } = okFetch();
  let asked = 0;
  const transport = new FetchHttpTransport({ fetch, checkDestination: async () => { asked += 1; throw new Error('no'); } });
  await transport.request({ method: 'GET', url: 'http://localhost:8000/v1/models', providerId: 'local' });
  assert.equal(asked, 0, 'localhost is never offered to the check');
  assert.equal(calls.length, 1, 'and it is sent');
});

test('the stream path is checked too, not only the request path', async () => {
  const { fetch, calls } = okFetch();
  const transport = new FetchHttpTransport({
    fetch,
    checkDestination: async () => { throw new Error('refused'); },
  });
  await assert.rejects(async () => {
    for await (const _ of transport.stream({ method: 'POST', url: 'https://evil.example.com/s', providerId: 'p', body: '{}' })) {
      // drain
    }
  });
  assert.equal(calls.length, 0);
});

test('without a check, a remote request is sent exactly as before', async () => {
  const { fetch, calls } = okFetch();
  const transport = new FetchHttpTransport({ fetch });
  await transport.request({ method: 'GET', url: 'https://api.example.com/v1/models', providerId: 'p' });
  assert.equal(calls.length, 1);
});
