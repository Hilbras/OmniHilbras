import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { ProviderHttpPool } from '../dist/src/core/provider-http.js';
import { assertPublicDestination, cachedDestinationAddresses, clearDestinationCache } from '../dist/src/core/destination-check.js';

/**
 * The provider connection pool.
 *
 * The defect this pins was measured on 2026-11-27: four requests spaced 5.5 s apart through Node's
 * global `fetch` opened four TLS connections, because undici's keep-alive window is four seconds. The
 * same four through `ProviderHttpPool` opened one. A provider turn, a tool call and the next turn are
 * exactly that shape, so the old behavior paid a handshake on nearly every turn.
 *
 * These tests use a real local listener rather than a stubbed fetch: connection reuse, streaming and
 * abort are properties of the socket, and a stub cannot demonstrate any of them.
 */

async function listen(t, handler) {
  const server = createHttpServer(handler);
  const connections = { count: 0 };
  server.on('connection', () => { connections.count += 1; });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return { port: server.address().port, connections };
}

function poolFor(t, options = {}) {
  const pool = new ProviderHttpPool({ keepAliveMs: 120_000, ...options });
  t.after(() => pool.close());
  return pool;
}

test('one connection serves requests spaced beyond the four-second fetch window', async (t) => {
  const { port, connections } = await listen(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const pool = poolFor(t, { addressesFor: () => ['127.0.0.1'] });
  const url = `http://127.0.0.1:${port}/v1/models`;

  const times = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 4_300));
    const started = performance.now();
    const response = await pool.fetch(url, { redirect: 'error' });
    assert.equal(await response.text(), '{"ok":true}');
    times.push(Math.round(performance.now() - started));
  }

  assert.equal(connections.count, 1, `expected one TCP connection, saw ${connections.count}: ${times.join('ms, ')}ms`);
  assert.equal(pool.stats.reused, 1);
  assert.equal(pool.stats.connections, 1);
});

test('gzip and brotli are decoded and their headers removed', async (t) => {
  const payload = JSON.stringify({ ok: true, text: 'a reply that was compressed on the wire' });
  const { port } = await listen(t, (request, response) => {
    if (request.url === '/gzip') {
      const body = gzipSync(payload);
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(body.length) });
      response.end(body);
      return;
    }
    const body = brotliCompressSync(payload);
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br', 'content-length': String(body.length) });
    response.end(body);
  });
  const pool = poolFor(t, { addressesFor: () => ['127.0.0.1'] });

  for (const path of ['/gzip', '/br']) {
    const response = await pool.fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'error' });
    assert.equal(await response.text(), payload, `${path} body was not decoded`);
    assert.equal(response.headers.get('content-encoding'), null, `${path} kept a content-encoding header over a decoded body`);
    assert.equal(response.headers.get('content-length'), null, `${path} kept the compressed length`);
  }
});

test('a streamed body arrives as it is written, not when the response ends', async (t) => {
  const { port } = await listen(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"i":1}\n\n');
    setTimeout(() => {
      response.write('data: {"i":2}\n\n');
      setTimeout(() => { response.write('data: {"i":3}\n\n'); response.end(); }, 120);
    }, 120);
    request.on('close', () => { /* the client may abort; the timer callbacks are harmless then */ });
  });
  const pool = poolFor(t, { addressesFor: () => ['127.0.0.1'] });

  const started = performance.now();
  const response = await pool.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { redirect: 'error' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const firstAt = performance.now() - started;
  const firstText = decoder.decode(first.value);
  assert.match(firstText, /"i":1/, 'the first event must be readable before the third is written');
  assert.ok(firstAt < 100, `the first chunk waited ${Math.round(firstAt)}ms, so the body was buffered`);

  let rest = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += decoder.decode(chunk.value);
  }
  assert.match(rest, /"i":2/);
  assert.match(rest, /"i":3/);
});

test('an aborted request rejects promptly with an AbortError', async (t) => {
  const { port } = await listen(t, () => {
    // Never answers: the point is that the client aborts, not that the server does.
  });
  const pool = poolFor(t, { addressesFor: () => ['127.0.0.1'] });
  const controller = new AbortController();
  const started = performance.now();
  setTimeout(() => controller.abort(), 60);

  await assert.rejects(
    () => pool.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { redirect: 'error', signal: controller.signal }),
    (error) => error instanceof Error && error.name === 'AbortError',
  );
  assert.ok(performance.now() - started < 1500, 'the abort did not take effect promptly');
});

test('a redirect is refused the way fetch refuses it with redirect:error', async (t) => {
  const { port } = await listen(t, (_request, response) => {
    response.writeHead(302, { location: 'https://elsewhere.example/' });
    response.end();
  });
  const pool = poolFor(t, { addressesFor: () => ['127.0.0.1'] });

  await assert.rejects(
    () => pool.fetch(`http://127.0.0.1:${port}/v1/models`, { redirect: 'error' }),
    (error) => error instanceof TypeError && /redirect/.test(error.message),
  );
});

test('the connector resolves a name once and reuses the answer', async (t) => {
  const { port, connections } = await listen(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  let resolutions = 0;
  const pool = poolFor(t, {
    // No destination-check answer: this is the connector's own cache under test.
    addressesFor: () => undefined,
    resolve: async () => { resolutions += 1; return [{ address: '127.0.0.1', family: 4 }]; },
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await pool.fetch(`http://provider.test:${port}/v1/models`, { redirect: 'error' });
    assert.equal(await response.text(), '{"ok":true}');
  }
  assert.equal(resolutions, 1, 'the connector resolved a cached name again');
  assert.equal(connections.count, 1);
});

test('the address the destination check judged is the address dialled', async (t) => {
  const { port } = await listen(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('checked');
  });
  const pool = poolFor(t, {
    // A public verdict for a name that would not resolve otherwise. If the pool resolved again, this
    // request would fail with ENOTFOUND instead of reaching the listener.
    addressesFor: () => ['127.0.0.1'],
    resolve: async () => { throw new Error('the connector resolved instead of using the checked address'); },
  });

  const response = await pool.fetch(`http://judged.invalid:${port}/`, { redirect: 'error' });
  assert.equal(await response.text(), 'checked');
});

test('the destination check keeps the addresses it judged, and clears them with the cache', async () => {
  clearDestinationCache();
  try {
    // A literal resolves without a network query on every platform this repo supports, so this stays
    // an offline test. It is public, so the check should carry its address forward.
    await assertPublicDestination('1.1.1.1');
    assert.deepEqual(cachedDestinationAddresses('1.1.1.1'), ['1.1.1.1']);
    clearDestinationCache();
    assert.equal(cachedDestinationAddresses('1.1.1.1'), undefined);
  } finally {
    clearDestinationCache();
  }
});
