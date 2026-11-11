import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DuckDuckGoWebAdapter,
  buildDuckDuckGoWebPrompt,
  normalizeDuckDuckGoDsml,
  parseDuckDuckGoDsml,
} from '../duckduckgo-web/dist/adapter/index.js';

/**
 * Duck.ai's prompt-level tool loop.
 *
 * The service has built-in search tools, but no native OpenAI function-calling field. The adapter
 * therefore uses the same DSML contract as DeepSeek Web: prompt the model, parse the block back,
 * and replay assistant/tool turns into the next prompt. These tests keep the loop honest without
 * spending the per-address quota.
 */

const CATALOG = { models: [{ id: 'gpt-5.4-mini', modelName: 'GPT', accessTier: ['free'] }] };
const ANSWER = [
  'Checking the file.',
  '<||DSML|| calls>',
  '<||DSML|| invoke name="read_file">',
  '<||DSML|| parameter name="path" string="true">src/app.ts</||DSML|| parameter>',
  '</||DSML|| invoke>',
  '</||DSML|| calls>',
].join('\n');

function driver(text = ANSWER) {
  const calls = [];
  return {
    calls,
    async available() { return { ok: true }; },
    async catalog() { return CATALOG; },
    async status() { return { challengeServed: true, solvedMs: 1 }; },
    async ask(input) { calls.push(input); return { text, model: input.model }; },
  };
}

const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

test('DSML normalisation accepts fullwidth bars', () => {
  assert.equal(normalizeDuckDuckGoDsml('< ｜ DSML ｜ invoke name="x">'), '<||DSML|| invoke name="x">');
});

test('the parser returns text before the block and a typed call', () => {
  const parsed = parseDuckDuckGoDsml(`before\n${ANSWER}`);
  assert.ok(parsed);
  assert.equal(parsed.content, 'before\nChecking the file.');
  assert.equal(parsed.toolCalls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { path: 'src/app.ts' });
});

test('the prompt carries tools, replayed calls and tool results', () => {
  const prompt = buildDuckDuckGoWebPrompt(
    [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } }] },
      { role: 'tool', name: 'read_file', toolCallId: 'call_1', content: 'const x = 1;' },
      { role: 'user', content: 'explain' },
    ],
    tools,
  );
  assert.match(prompt, /TOOLS AVAILABLE/);
  assert.match(prompt, /DSML\|\| invoke name="read_file">/);
  assert.match(prompt, /\[TOOL RESULT for read_file\]:/);
  assert.match(prompt, /USER: explain/);
});

test('a chat with tools returns tool_calls, not a prose-only stop', async () => {
  const fake = driver();
  const adapter = new DuckDuckGoWebAdapter({ driver: fake });
  const response = await adapter.chat({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'read it' }], tools });
  assert.equal(response.finishReason, 'tool_calls');
  assert.equal(response.message.toolCalls?.length, 1);
  assert.equal(response.message.content, 'Checking the file.');
  assert.match(fake.calls[0].messages[0].content, /TOOLS AVAILABLE/);
});

test('streamChat carries the tool call and declares streaming', async () => {
  const fake = driver();
  const adapter = new DuckDuckGoWebAdapter({ driver: fake });
  const chunks = [];
  for await (const chunk of adapter.streamChat({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'read it' }], tools })) chunks.push(chunk);
  assert.equal(adapter.capabilities.streaming, true);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].finishReason, 'tool_calls');
  assert.equal(chunks[0].delta.toolCalls?.[0]?.function?.name, 'read_file');
});

test('tool_choice none removes the tool instruction and the parser', async () => {
  const fake = driver();
  const adapter = new DuckDuckGoWebAdapter({ driver: fake });
  const response = await adapter.chat({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], tools, toolChoice: 'none' });
  assert.equal(response.finishReason, 'stop');
  assert.equal(fake.calls[0].messages[0].content.includes('TOOLS AVAILABLE'), false);
});
