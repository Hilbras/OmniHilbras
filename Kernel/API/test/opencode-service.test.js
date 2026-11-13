import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverOpencodeService, flattenMessagesForService, parseModelRef, runOpencodeServiceTurn } from '../dist/src/core/opencode-service.js';

/**
 * The local OpenCode service, which is the transport the desktop app uses.
 *
 * Every shape here is measured against a running service on this machine: Basic auth with username
 * `opencode`, `POST /api/session {model:{id,providerID}}`, `POST /api/session/:id/prompt {text}`,
 * `POST /api/experimental/session/:id/wait` → 204, `GET /api/session/:id/message` → `{data:[…]}` with
 * the assistant's `content[]`. The live flow answered `content:[{type:"text",text:"OK"}]`, cost 0, for
 * `opencode/deepseek-v4.1-flash-free`.
 */

test('the registration file is read, and only a loopback URL is accepted', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-service-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'service.json');
  await writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:49374', password: 'pw', version: '2.0.28', pid: 42 }));

  const found = await discoverOpencodeService({ file });
  assert.deepEqual(found, { url: 'http://127.0.0.1:49374', password: 'pw', version: '2.0.28', pid: 42 });

  await writeFile(file, JSON.stringify({ url: 'http://example.com:49374', password: 'pw' }));
  assert.equal(await discoverOpencodeService({ file }), undefined, 'a non-loopback service must not be used');

  assert.equal(await discoverOpencodeService({ file: join(dir, 'missing.json') }), undefined, 'a missing registration is not an error');
});

test('a turn drives a session: create, prompt, wait, read, delete', async (t) => {
  const calls = [];
  const scripted = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init?.method, body: init?.body, auth: init?.headers?.authorization });
    if (path === '/api/session' && init?.method === 'POST') return new Response(JSON.stringify({ data: { id: 'ses_1' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session/ses_1/prompt') return new Response(JSON.stringify({ data: { id: 'msg_1' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/experimental/session/ses_1/wait') return new Response(null, { status: 204 });
    if (path === '/api/session/ses_1/message') {
      return new Response(JSON.stringify({ data: [
        { type: 'user', text: 'hi' },
        { type: 'assistant', model: { id: 'deepseek-v4.1-flash-free', providerID: 'opencode' }, finish: 'stop', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'OK' }] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/api/session/ses_1' && init?.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`unexpected ${init?.method} ${path}`);
  };

  const result = await runOpencodeServiceTurn(
    { url: 'http://127.0.0.1:49374', password: 'pw' },
    { model: 'opencode/deepseek-v4.1-flash-free', text: 'User: hi' },
    { fetch: scripted },
  );

  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'POST /api/session',
    'POST /api/session/ses_1/prompt',
    'POST /api/experimental/session/ses_1/wait',
    'GET /api/session/ses_1/message',
    'DELETE /api/session/ses_1',
  ]);
  assert.equal(calls[0].auth, `Basic ${Buffer.from('opencode:pw').toString('base64')}`, 'the service wants Basic opencode:<password>');
  assert.equal(JSON.parse(calls[0].body).model.id, 'deepseek-v4.1-flash-free');
  assert.equal(JSON.parse(calls[1].body).text, 'User: hi');
  assert.equal(result.text, 'OK');
  assert.equal(result.reasoning, 'thinking');
  assert.equal(result.finish, 'stop');
});

test('a service error names what the service said', async () => {
  const scripted = async () => new Response(JSON.stringify({ _tag: 'InvalidRequestError', message: 'Missing key at ["text"]' }), { status: 400, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    () => runOpencodeServiceTurn({ url: 'http://127.0.0.1:49374', password: 'pw' }, { model: 'opencode/x', text: 'hi' }, { fetch: scripted }),
    /Missing key/,
  );
});

test('model references and message flattening match what the service takes', () => {
  assert.deepEqual(parseModelRef('opencode/deepseek-v4.1-flash-free'), { providerID: 'opencode', id: 'deepseek-v4.1-flash-free' });
  assert.deepEqual(parseModelRef('opencode/glm-5.3#low'), { providerID: 'opencode', id: 'glm-5.3', variant: 'low' });
  assert.equal(parseModelRef('no-slash'), undefined);
  assert.equal(
    flattenMessagesForService([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]),
    'System: be brief\n\nUser: hi\n\nAssistant: hello',
  );
});