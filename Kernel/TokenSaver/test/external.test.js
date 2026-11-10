import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { headroomCompress, pxpipeCompress } from '../dist/index.js';

/** Every external saver fails open. This is asserted, not promised. */

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const messages = [
  { role: 'system', content: 'stay' },
  { role: 'user', content: 'x'.repeat(2_000) },
  { role: 'assistant', content: 'ok' },
];

const compressed = [
  { role: 'system', content: 'stay' },
  { role: 'user', content: 'x'.repeat(100) },
  { role: 'assistant', content: 'ok' },
];

test('headroom applies messages that preserve the turns and actually shrink', async () => {
  await withServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      assert.equal(request.url, '/v1/compress');
      assert.equal(JSON.parse(body).model, 'm');
      json(response, 200, { messages: compressed, tokens_saved: 400 });
    });
  }, async (url) => {
    const result = await headroomCompress(messages, 'm', { url });
    assert.equal(result.applied, true);
    assert.deepEqual(result.messages, compressed);
    assert.ok(result.bytesAfter < result.bytesBefore);
  });
});

test('a proxy that reports savings while the messages barely shrink is rejected as phantom', async () => {
  await withServer((_request, response) => {
    json(response, 200, { messages, tokens_saved: 10_000 });
  }, async (url) => {
    const result = await headroomCompress(messages, 'm', { url });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'phantom-savings');
    assert.deepEqual(result.messages, messages, 'the unshrunk result must not be applied');
  });
});

test('a reordered response is refused rather than scrambling the conversation', async () => {
  await withServer((_request, response) => {
    json(response, 200, { messages: [compressed[1], compressed[0], compressed[2]] });
  }, async (url) => {
    const result = await headroomCompress(messages, 'm', { url });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'invalid-response');
    assert.deepEqual(result.messages, messages);
  });
});

test('an unavailable proxy leaves the conversation untouched', async () => {
  await withServer((_request, response) => json(response, 503, { error: 'down' }), async (url) => {
    const result = await headroomCompress(messages, 'm', { url, timeoutMs: 500 });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'unavailable');
    assert.deepEqual(result.messages, messages);
  });
});

test('a slow proxy times out and falls through', async () => {
  await withServer((_request, response) => {
    setTimeout(() => json(response, 200, { messages: compressed }), 300);
  }, async (url) => {
    const started = Date.now();
    const result = await headroomCompress(messages, 'm', { url, timeoutMs: 50 });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'unavailable');
    assert.deepEqual(result.messages, messages);
    assert.ok(Date.now() - started < 250, 'the timeout was not enforced');
  });
});

test('pxpipe skips below its threshold without calling the service', async () => {
  let calls = 0;
  await withServer((_request, response) => { calls += 1; json(response, 200, { messages: compressed }); }, async (url) => {
    const result = await pxpipeCompress(messages, 'm', { url, minChars: 1_000_000 });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'below-threshold');
    assert.equal(calls, 0, 'the service was called despite the threshold');
  });
});

test('pxpipe applies an image transform above the threshold and fails open on error', async () => {
  await withServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      assert.equal(request.url, '/v1/transform');
      assert.equal(JSON.parse(body).options.minCompressChars, 1_000);
      if (JSON.parse(body).model === 'broken') return json(response, 500, { error: 'down' });
      json(response, 200, { applied: true, messages: compressed, imageCount: 2, imageTokens: 9522 });
    });
  }, async (url) => {
    const result = await pxpipeCompress(messages, 'm', { url, minChars: 1_000 });
    assert.equal(result.applied, true);
    assert.match(result.detail ?? '', /2 image/);

    const failed = await pxpipeCompress(messages, 'broken', { url, minChars: 1_000 });
    assert.equal(failed.applied, false);
    assert.deepEqual(failed.messages, messages);
  });
});
