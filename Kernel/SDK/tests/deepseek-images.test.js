import assert from 'node:assert/strict';
import test from 'node:test';
import { deepSeekHashV1 } from '../deepseek-web/dist/lib/deepseek-pow.js';
import {
  DeepSeekWebAdapter,
  MAX_DEEPSEEK_IMAGE_BYTES,
  extractDeepSeekImageUrls,
  isDeepSeekImageUrlAllowed,
  parseDeepSeekDataImage,
} from '../deepseek-web/dist/adapter/index.js';

/**
 * Images for DeepSeek Web.
 *
 * The upload route was checked against the live host: `/file/upload_file` answers JSON
 * `INVALID_TOKEN`; `/file/upload` answers an HTML page. The tests below pin the request
 * shape, the safe-URL rule and the `ref_file_ids` value that actually reaches completion.
 */

const SALT = 'salt';
const EXPIRE_AT = 1700000000;
const CHALLENGE = deepSeekHashV1(`${SALT}_${EXPIRE_AT}_3`);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const DATA_URI = `data:image/png;base64,${PNG}`;
const SSE = [
  'data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"RESPONSE","content":"It is a pixel."}]}}}',
  'data: {"p":"response/status","v":"FINISHED"}',
].join('\n');

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function imageFetch(capture) {
  return async (url, init) => {
    const path = String(url);
    if (path.includes('users/current')) return json({ code: 0, data: { biz_data: { token: 'access' } } });
    if (path.includes('chat_session/create')) return json({ code: 0, data: { biz_data: { chat_session: { id: 'session-1' } } } });
    if (path.includes('create_pow_challenge')) {
      return json({ code: 0, data: { biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: CHALLENGE, salt: SALT, difficulty: 8, signature: 'sig', target_path: '/api/v0/chat/completion', expire_at: EXPIRE_AT } } } });
    }
    if (path.includes('/file/upload_file')) {
      capture.upload = { path, body: init?.body };
      return json({ code: 0, data: { biz_data: { id: 'file-1' } } });
    }
    if (path.includes('/file/fetch_files')) return json({ code: 0, data: { biz_data: { files: [{ id: 'file-1', status: 'READY' }] } } });
    if (path.includes('/chat/completion')) {
      capture.completion = JSON.parse(String(init?.body));
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
}

test('the data URI decoder accepts only real image types and enforces the byte cap', () => {
  const image = parseDeepSeekDataImage(DATA_URI);
  assert.ok(image);
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.filename, 'image.png');
  assert.ok(image.bytes.byteLength > 0);
  assert.equal(parseDeepSeekDataImage('data:text/plain;base64,aGVsbG8='), null);
  assert.throws(
    () => parseDeepSeekDataImage(`data:image/png;base64,${'A'.repeat(Math.ceil((MAX_DEEPSEEK_IMAGE_BYTES * 4) / 3) + 4)}`),
    /up to 8 MB/,
  );
});

test('remote image URLs are https-only and reject loopback, private and metadata ranges', () => {
  assert.equal(isDeepSeekImageUrlAllowed('https://example.com/a.png'), true);
  for (const url of [
    'http://example.com/a.png',
    'https://localhost/a.png',
    'https://127.0.0.1/a.png',
    'https://10.0.0.1/a.png',
    'https://192.168.1.2/a.png',
    'https://172.20.0.1/a.png',
    'https://169.254.169.254/latest/meta-data',
    'https://printer.local/a.png',
  ]) assert.equal(isDeepSeekImageUrlAllowed(url), false, url);
});

test('image content parts are collected from OpenAI-shaped messages', () => {
  assert.deepEqual(extractDeepSeekImageUrls([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', imageUrl: { url: DATA_URI } }] }]), [DATA_URI]);
  assert.deepEqual(extractDeepSeekImageUrls([{ role: 'user', content: 'text only' }]), []);
});

test('an image is uploaded once and its file id reaches the completion payload', async () => {
  const capture = {};
  const adapter = new DeepSeekWebAdapter({ fetch: imageFetch(capture), now: () => 1_700_000_000_000 });
  const response = await adapter.chat(
    { model: 'deepseek-chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', imageUrl: { url: DATA_URI } }] }] },
    { credential: { type: 'api-key', value: 'user-token' } },
  );
  assert.equal(response.message.content, 'It is a pixel.');
  assert.equal(capture.upload.path, 'https://chat.deepseek.com/api/v0/file/upload_file');
  assert.deepEqual(capture.completion.ref_file_ids, ['file-1']);
});

test('an insecure remote image is refused before it is fetched', async () => {
  let fetched = false;
  const adapter = new DeepSeekWebAdapter({
    fetch: async (url) => {
      if (String(url).includes('users/current')) return json({ code: 0, data: { biz_data: { token: 'access' } } });
      if (String(url).includes('chat_session/create')) return json({ code: 0, data: { biz_data: { chat_session: { id: 'session-1' } } } });
      fetched = true;
      return new Response('nope', { status: 200 });
    },
  });
  await assert.rejects(
    () => adapter.chat(
      { model: 'deepseek-chat', messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: { url: 'https://127.0.0.1/secret' } }] }] },
      { credential: { type: 'api-key', value: 'user-token' } },
    ),
    /https and must not point/,
  );
  assert.equal(fetched, false);
});
