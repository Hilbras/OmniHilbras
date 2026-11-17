import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodeGoAdapter } from '../opencode-go/dist/adapter/index.js';
import { ZenAdapter } from '../opencode-zen/dist/adapter/index.js';

/**
 * OpenCode Go, as its own provider.
 *
 * The defect this pins: Go used to be `new ZenAdapter({ base: 'https://opencode.ai/zen/go' })`, and the class only
 * applied the CLI identity on its free-tier path. A paid Go model therefore went out with no `x-opencode-session`
 * and was answered with *"Request is missing x-opencode-session and cannot be routed efficiently"* — a message about
 * routing, not about the key, which is why it read as a broken provider rather than a missing header.
 */

function transport() {
  const requests = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      return {
        status: 200,
        headers: new Headers(),
        data: { id: 'r', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
      };
    },
    async *stream(request) {
      requests.push(request);
      yield `data: ${JSON.stringify({ id: 'r', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`;
      yield 'data: [DONE]\n\n';
    },
  };
}

const credential = { type: 'api-key', value: 'go-key' };
const conversation = [{ role: 'user', content: 'hi' }];

test('Go is its own provider with its own base, not Zen with a flag', () => {
  const go = new OpenCodeGoAdapter({ transport: transport() });
  assert.equal(go.id, 'opencode-go');
  assert.equal(go.name, 'OpenCode Go');
  const zen = new ZenAdapter({ transport: transport() });
  assert.equal(zen.id, 'opencode', 'Zen keeps its own id');
  assert.equal(zen.name, 'OpenCode Zen');
});

test('a paid Go model is sent with the session the lane routes by', async () => {
  const t = transport();
  const go = new OpenCodeGoAdapter({ transport: t });
  // Not `-free`: this is the chat lane, which is the path that used to omit the identity.
  await go.chat({ model: 'glm-5.3', messages: conversation }, { credential });

  const sent = t.requests.at(-1);
  assert.equal(sent.url, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.match(sent.headers['x-opencode-session'], /^ses_/, 'the session header is missing');
  assert.equal(sent.headers['x-opencode-client'], 'desktop');
  assert.equal(sent.headers['x-opencode-project'], 'global');
  assert.match(sent.headers['user-agent'], /^opencode\//);
  assert.equal(sent.headers.Authorization, 'Bearer go-key', 'the key still travels');
});

test('one conversation keeps one session, and another conversation gets another', async () => {
  const t = transport();
  const go = new OpenCodeGoAdapter({ transport: t });
  await go.chat({ model: 'glm-5.3', messages: conversation }, { credential });
  const first = t.requests.at(-1).headers['x-opencode-session'];
  await go.chat({ model: 'glm-5.3', messages: [...conversation, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and?' }] }, { credential });
  const continued = t.requests.at(-1).headers['x-opencode-session'];
  await go.chat({ model: 'glm-5.3', messages: [{ role: 'user', content: 'a different task' }] }, { credential });
  const other = t.requests.at(-1).headers['x-opencode-session'];

  assert.equal(first, continued, 'a continued conversation changed its session id');
  assert.notEqual(first, other, 'a different conversation reused the session id');
});

test('streaming carries the session too', async () => {
  const t = transport();
  const go = new OpenCodeGoAdapter({ transport: t });
  for await (const _chunk of go.streamChat({ model: 'glm-5.3', messages: conversation }, { credential })) {
    // Draining the stream is the assertion; the headers are read below.
  }
  assert.match(t.requests.at(-1).headers['x-opencode-session'], /^ses_/);
});

test('the messages lane carries the session as well as the key header', async () => {
  const t = transport();
  const go = new OpenCodeGoAdapter({ transport: t });
  await go.chat({ model: 'claude-sonnet-5', messages: conversation }, { credential });
  const sent = t.requests.at(-1);
  assert.match(sent.headers['x-opencode-session'], /^ses_/);
  assert.equal(sent.headers['x-api-key'], 'go-key');
});

test('the header is on the wire, not only in the request object', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'r', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const go = new OpenCodeGoAdapter({ base });
    await go.chat({ model: 'glm-5.3', messages: conversation }, { credential });
    assert.equal(seen.length, 1, 'the adapter did not make one request');
    assert.equal(seen[0].url, '/v1/chat/completions');
    assert.match(String(seen[0].headers['x-opencode-session']), /^ses_[a-f0-9]{12}[0-9A-Za-z]{14}$/, 'the session header did not reach the socket');
    assert.equal(seen[0].headers.authorization, 'Bearer go-key');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
