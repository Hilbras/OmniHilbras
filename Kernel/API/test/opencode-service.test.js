import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverOpencodeService, flattenMessagesForService, opencodeServicePermissions, opencodeServiceTurnError, parseModelRef, runOpencodeServiceTurn, streamOpencodeServiceTurn } from '../dist/src/core/opencode-service.js';

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

/** A scripted SSE body, the shape the service really publishes. */
function sse(events) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

const assistantMessage = (text, reasoning) => new Response(JSON.stringify({ data: [
  { type: 'user', text: 'hi' },
  { type: 'assistant', model: { id: 'deepseek-v4.1-flash-free', providerID: 'opencode' }, finish: 'stop', content: [{ type: 'reasoning', text: reasoning }, { type: 'text', text }] },
] }), { status: 200, headers: { 'content-type': 'application/json' } });

test('a turn drives a session: create, subscribe, prompt, read, delete', async (t) => {
  const calls = [];
  const scripted = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init?.method, body: init?.body, auth: init?.headers?.authorization });
    if (path === '/api/session' && init?.method === 'POST') return new Response(JSON.stringify({ data: { id: 'ses_1' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/event') {
      return sse([
        { type: 'server.connected', data: {} },
        { type: 'session.text.delta', data: { sessionID: 'ses_1', assistantMessageID: 'msg_1', ordinal: 0, delta: 'OK' } },
        { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } },
      ]);
    }
    if (path === '/api/session/ses_1/prompt') return new Response(JSON.stringify({ data: { id: 'msg_1' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/session/ses_1/message') return assistantMessage('OK', 'thinking');
    if (path === '/api/session/ses_1' && init?.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`unexpected ${init?.method} ${path}`);
  };

  const result = await runOpencodeServiceTurn(
    { url: 'http://127.0.0.1:49374', password: 'pw' },
    { model: 'opencode/deepseek-v4.1-flash-free', text: 'User: hi' },
    { fetch: scripted },
  );

  // The subscription comes **before** the prompt: a delta published between "prompt accepted" and
  // "stream attached" would otherwise be lost, and that is what made the first answer arrive empty.
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    'POST /api/session',
    'GET /api/event',
    'POST /api/session/ses_1/prompt',
    'GET /api/session/ses_1/message',
    'DELETE /api/session/ses_1',
  ]);
  assert.equal(calls[0].auth, `Basic ${Buffer.from('opencode:pw').toString('base64')}`, 'the service wants Basic opencode:<password>');
  assert.equal(calls[1].auth, `Basic ${Buffer.from('opencode:pw').toString('base64')}`, 'the event stream is behind the same auth');
  assert.equal(JSON.parse(calls[0].body).model.id, 'deepseek-v4.1-flash-free');
  // A session created here is an agent, and the agent's own ruleset is `*: allow` — measured: a prompt
  // asking for a directory listing ran the tool and returned /home/gin's contents.
  const ruleset = JSON.parse(calls[0].body).permissions;
  assert.deepEqual(ruleset[0], { action: '*', resource: '*', effect: 'deny' }, 'everything is denied first');
  assert.deepEqual(ruleset.slice(1).map((rule) => rule.action), ['read', 'grep', 'glob', 'external_directory'], 'the read-only tools come back');
  assert.equal(JSON.parse(calls[2].body).text, 'User: hi');
  assert.equal(result.text, 'OK');
  assert.equal(result.reasoning, 'thinking');
  assert.equal(result.finish, 'stop');
});

test('deltas are reported while the turn runs, text and reasoning apart', async () => {
  const deltas = [];
  const scripted = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/api/session') return new Response(JSON.stringify({ data: { id: 'ses_9' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/event') {
      return sse([
        { type: 'server.connected', data: {} },
        // Another turn on the same service must not appear in this one's answer.
        { type: 'session.text.delta', data: { sessionID: 'ses_other', delta: 'WRONG' } },
        { type: 'session.reasoning.delta', data: { sessionID: 'ses_9', assistantMessageID: 'msg_9', ordinal: 0, delta: 'because' } },
        { type: 'session.text.delta', data: { sessionID: 'ses_9', assistantMessageID: 'msg_9', ordinal: 0, delta: 'O' } },
        { type: 'session.text.delta', data: { sessionID: 'ses_9', assistantMessageID: 'msg_9', ordinal: 0, delta: 'K' } },
        { type: 'session.execution.succeeded', data: { sessionID: 'ses_9' } },
      ]);
    }
    if (path.endsWith('/prompt')) return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/message')) return assistantMessage('OK', 'because');
    return new Response(null, { status: 204 });
  };

  const result = await streamOpencodeServiceTurn(
    { url: 'http://127.0.0.1:49374', password: 'pw' },
    { model: 'opencode/deepseek-v4.1-flash-free', text: 'User: hi' },
    { fetch: scripted, onDelta: (delta) => deltas.push(delta) },
  );

  assert.deepEqual(deltas, [{ reasoning: 'because' }, { text: 'O' }, { text: 'K' }]);
  assert.equal(result.text, 'OK');
  assert.equal(result.reasoning, 'because');
});

test('a turn the service fails names the failure instead of reporting an empty answer', async () => {
  const scripted = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/api/session') return new Response(JSON.stringify({ data: { id: 'ses_7' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/api/event') return sse([{ type: 'session.execution.failed', data: { sessionID: 'ses_7', error: 'exceed quota limit' } }]);
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(
    () => runOpencodeServiceTurn({ url: 'http://127.0.0.1:49374', password: 'pw' }, { model: 'opencode/x', text: 'hi' }, { fetch: scripted }),
    (error) => {
      // A bare Error here made the gateway answer `502 Every provider route failed`, which names no
      // provider and no reason: a client retried ten times with nothing to act on.
      assert.equal(error.name, 'ProviderError');
      assert.equal(error.code, 'PROVIDER_REQUEST_FAILED');
      assert.match(error.publicMessage, /exceed quota limit/);
      assert.equal(error.details.providerMessage, 'exceed quota limit');
      return true;
    },
  );
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

test('a chat bridge denies every tool it has not heard of, and allows only the read-only ones back', () => {
  const rules = opencodeServicePermissions({});
  // A deny list goes stale the moment the client ships another tool — `question`, a to-do tool, a goal
  // tool, an MCP tool this code cannot name. Deny `*` first and the surface is closed by construction.
  assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
  assert.deepEqual(rules.slice(1).map((rule) => rule.action), ['read', 'grep', 'glob', 'external_directory']);
  // Reads reach outside the session root by default. The session root is the gateway's own working
  // directory, so denying this refused the model every file it was actually asked about — measured as
  // `{"type":"permission.rejected","message":"Permission denied: external_directory"}` inside an
  // otherwise successful turn, which is a provider that looks fine and does nothing.
  assert.equal(rules.at(-1).effect, 'allow', 'a coding agent must be able to read the project it is asked about');
  // Writing and executing stay denied in both modes.
  const denied = new Set(rules.filter((rule) => rule.effect === 'deny').map((rule) => rule.action));
  assert.ok(denied.has('*'), 'everything is denied first');
  assert.equal(opencodeServicePermissions({ OMNIHILBRAS_OPENCODE_SERVICE_TOOLS: 'all' }), undefined, 'the agent ruleset is opt-in');
  // `project` is the narrower thing, and it is named: reads stay inside the session root.
  const confined = opencodeServicePermissions({ OMNIHILBRAS_OPENCODE_SERVICE_TOOLS: 'project' });
  assert.equal(confined.at(-1).action, 'external_directory');
  assert.equal(confined.at(-1).effect, 'deny');
});


test('a free-tier refusal is reported as rate limiting, with the Console\'s own sentence', () => {
  const quota = opencodeServiceTurnError('Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go');
  assert.equal(quota.code, 'RATE_LIMITED', 'a quota refusal is a rate limit, not a transport failure');
  assert.equal(quota.retryable, false, 'retrying a spent daily quota is the loop a client should not be in');
  assert.match(quota.details.providerMessage, /subscribe to OpenCode Go/);

  const balance = opencodeServiceTurnError('Insufficient balance. Top up at https://opencode.ai/console/wrk_x/billing?credits=1.');
  assert.equal(balance.code, 'PROVIDER_REQUEST_FAILED');
  assert.equal(balance.retryable, false);
  assert.match(balance.publicMessage, /Top up at/);

  const other = opencodeServiceTurnError('The model returned nothing.');
  assert.equal(other.retryable, true, 'an unclassified failure may be worth another attempt');
});
