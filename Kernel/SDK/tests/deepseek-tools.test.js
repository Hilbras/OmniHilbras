import assert from 'node:assert/strict';
import test from 'node:test';
import { deepSeekHashV1 } from '../deepseek-web/dist/lib/deepseek-pow.js';
import {
  buildDeepSeekPrompt,
  DeepSeekWebAdapter,
  normalizeDeepSeekDsml,
  parseDeepSeekDsml,
} from '../deepseek-web/dist/adapter/index.js';

/**
 * The prompt-level agent protocol.
 *
 * DeepSeek's web endpoint has no native `tools` field. The adapter asks for DSML, parses it
 * back, and replays the assistant/tool turns into the next flat prompt. These tests keep
 * that loop honest without a subscription or a live turn.
 */

const SALT = 'salt';
const EXPIRE_AT = 1700000000;
const CHALLENGE = deepSeekHashV1(`${SALT}_${EXPIRE_AT}_3`);

const ANSWER = [
  'I will read the file.',
  '<||DSML|| calls>',
  '<||DSML|| invoke name="read_file">',
  '<||DSML|| parameter name="path" string="true">src/app.ts</||DSML|| parameter>',
  '<||DSML|| parameter name="limit">20</||DSML|| parameter>',
  '</||DSML|| invoke>',
  '</||DSML|| calls>',
].join('\n');

const SSE = [
  `data: ${JSON.stringify({ v: { response: { thinking_enabled: false, fragments: [{ type: 'RESPONSE', content: ANSWER }] } } })}`,
  'data: {"p":"response/status","v":"FINISHED"}',
].join('\n');

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function agentFetch(completionBody) {
  const calls = [];
  const impl = async (url, init) => {
    const path = String(url);
    calls.push({ path, body: init?.body });
    if (path.includes('users/current')) return jsonResponse({ code: 0, data: { biz_data: { token: 'access' } } });
    if (path.includes('chat_session/create')) return jsonResponse({ code: 0, data: { biz_data: { chat_session: { id: 'session-1' } } } });
    if (path.includes('create_pow_challenge')) {
      return jsonResponse({
        code: 0,
        data: { biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: CHALLENGE, salt: SALT, difficulty: 8, signature: 'sig', target_path: '/api/v0/chat/completion', expire_at: EXPIRE_AT } } },
      });
    }
    if (path.includes('/chat/completion')) {
      if (completionBody) completionBody(init?.body);
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  return { calls, impl };
}

test('DSML is normalized across fullwidth bars and whitespace', () => {
  assert.equal(normalizeDeepSeekDsml('< ｜ DSML ｜ invoke name="x">'), '<||DSML|| invoke name="x">');
});

test('the parser returns the content before the block and typed parameters', () => {
  const parsed = parseDeepSeekDsml(`prefix\n${ANSWER}`);
  assert.ok(parsed);
  assert.equal(parsed.content, 'prefix\nI will read the file.');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { path: 'src/app.ts', limit: 20 });
  assert.match(parsed.toolCalls[0].id, /^call_[a-f0-9]{12}$/);
});

test('the prompt carries tool instructions, replayed calls and tool results', () => {
  const prompt = buildDeepSeekPrompt(
    [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } }] },
      { role: 'tool', name: 'read_file', toolCallId: 'call_1', content: 'const x = 1;' },
      { role: 'user', content: 'explain' },
    ],
    [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  );
  assert.match(prompt, /TOOLS AVAILABLE/);
  assert.match(prompt, /read_file/);
  assert.match(prompt, /DSML\|\| invoke name="read_file">/);
  assert.match(prompt, /\[TOOL RESULT for read_file\]:/);
  assert.match(prompt, /const x = 1;/);
  assert.match(prompt, /USER: explain/);
});

test('tool_choice required is stated in the prompt', () => {
  const prompt = buildDeepSeekPrompt([{ role: 'user', content: 'go' }], [{ name: 'x', parameters: { type: 'object' } }], 'required');
  assert.match(prompt, /must call at least one tool/i);
});

test('a chat with tools returns a tool call and an agent finish reason', async () => {
  let completion = '';
  const { calls, impl } = agentFetch((body) => { completion = String(body); });
  const adapter = new DeepSeekWebAdapter({ fetch: impl, now: () => 1_700_000_000_000 });
  const response = await adapter.chat(
    { model: 'deepseek-chat', messages: [{ role: 'user', content: 'read it' }], tools: [{ name: 'read_file', parameters: { type: 'object' } }] },
    { credential: { type: 'api-key', value: 'user-token' } },
  );
  assert.equal(response.finishReason, 'tool_calls');
  assert.equal(response.message.toolCalls?.length, 1);
  assert.equal(response.message.content, 'I will read the file.');
  assert.match(completion, /TOOLS AVAILABLE/);
  assert.equal(calls.filter((call) => call.path.includes('chat_session/create')).length, 1);
});

test('a streamed tool round carries tool_calls and the same finish reason', async () => {
  const { impl } = agentFetch();
  const adapter = new DeepSeekWebAdapter({ fetch: impl, now: () => 1_700_000_000_000 });
  const chunks = [];
  for await (const chunk of adapter.streamChat(
    { model: 'deepseek-chat', messages: [{ role: 'user', content: 'read it' }], tools: [{ name: 'read_file', parameters: { type: 'object' } }] },
    { credential: { type: 'api-key', value: 'user-token' } },
  )) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].finishReason, 'tool_calls');
  assert.equal(chunks[0].delta.toolCalls?.[0]?.function?.name, 'read_file');
  assert.equal(chunks[0].delta.content, 'I will read the file.');
});

test('two turns reuse one chat session, and a new credential gets its own', async () => {
  const { calls, impl } = agentFetch();
  const adapter = new DeepSeekWebAdapter({ fetch: impl, now: () => 1_700_000_000_000 });
  const request = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello' }] };
  await adapter.chat(request, { credential: { type: 'api-key', value: 'user-a' } });
  await adapter.chat(request, { credential: { type: 'api-key', value: 'user-a' } });
  await adapter.chat(request, { credential: { type: 'api-key', value: 'user-b' } });
  assert.equal(calls.filter((call) => call.path.includes('chat_session/create')).length, 2);
});

test('long histories are compacted, but the newest turn is untouched', () => {
  const messages = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `START${index}:${'x'.repeat(index === 15 ? 400 : 5000)}`,
  }));
  const prompt = buildDeepSeekPrompt(messages, []);
  assert.match(prompt, /truncated 200\d characters/);
  assert.match(prompt, /15:/);
  assert.match(prompt, /x{400}/);
  assert.equal(prompt.includes('START0:' + 'x'.repeat(3001)), false);
});
