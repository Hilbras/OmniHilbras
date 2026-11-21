import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { toMessagesBody, toMessagesChatResponse } from '../Kernel/SDK/opencode-go/dist/adapter/index.js';
import { toMessagesBody as toZenMessagesBody, toMessagesChatResponse as toZenMessagesChatResponse } from '../Kernel/SDK/opencode-zen/dist/adapter/index.js';
import { toKiroBody } from '../Kernel/SDK/kiro/dist/adapter/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (path) => readFileSync(join(root, path), 'utf8');

const history = [
  { role: 'user', content: 'list the files' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*"}' } }] },
  { role: 'tool', content: 'a.ts', toolCallId: 'c1' },
];

test('the OpenCode Messages lane replays calls and results as tool_use / tool_result blocks', () => {
  for (const build of [toMessagesBody, toZenMessagesBody]) {
    const body = build({ model: 'claude-x', messages: history, maxOutputTokens: 64 });
    assert.deepEqual(body.messages[1], {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'glob', input: { pattern: '*' } }],
    });
    assert.deepEqual(body.messages[2], {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'a.ts' }],
    });
  }
});

test('the OpenCode Messages lane sends tool definitions upstream', () => {
  const request = {
    model: 'claude-x',
    messages: [{ role: 'user', content: 'hi' }],
    toolChoice: 'required',
    tools: [{ name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  };
  for (const build of [toMessagesBody, toZenMessagesBody]) {
    const body = build(request);
    assert.deepEqual(body.tools, [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]);
    assert.deepEqual(body.tool_choice, { type: 'any' }, 'a forced call is mapped to Anthropic any');
  }
});

test('the OpenCode Messages lane returns a tool_use block as a real tool call', () => {
  const payload = {
    id: 'msg1',
    content: [
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'c2', name: 'glob', input: { pattern: '*.ts' } },
    ],
    stop_reason: 'tool_use',
  };
  for (const parse of [toMessagesChatResponse, toZenMessagesChatResponse]) {
    const response = parse(payload, 'claude-x', 'opencode-go');
    assert.equal(response.finishReason, 'tool_calls');
    assert.equal(response.message.toolCalls.length, 1);
    assert.deepEqual(response.message.toolCalls[0], {
      id: 'c2', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*.ts"}' },
    });
  }
});

test('Kiro history keeps assistant toolUses and the toolResults they answer', () => {
  const body = toKiroBody({ model: 'kiro-model', messages: [...history, { role: 'user', content: 'thanks' }] }, 'conv-1');
  const state = body.conversationState;
  assert.deepEqual(state.history[1].assistantResponseMessage.toolUses, [
    { toolUseId: 'c1', name: 'glob', input: { pattern: '*' } },
  ]);
  assert.deepEqual(state.history[2].userInputMessage.userInputMessageContext.toolResults, [
    { toolUseId: 'c1', content: [{ text: 'a.ts' }] },
  ]);
});

test('a tool result as the final Kiro message still names the call it answers', () => {
  const body = toKiroBody({ model: 'kiro-model', messages: history }, 'conv-2');
  assert.deepEqual(body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults, [
    { toolUseId: 'c1', content: [{ text: 'a.ts' }] },
  ]);
});

test('CodeBuddy and Qoder non-streaming chat aggregate tool calls from the stream', () => {
  for (const file of [
    'Kernel/SDK/codebuddy/adapter/index.ts',
    'Kernel/SDK/qoder/adapter/index.ts',
  ]) {
    const text = source(file);
    assert.match(text, /const calls = new Map<number, ToolCall>/, `${file} does not accumulate streamed tool calls`);
    assert.match(text, /toolCalls\.length && finishReason === 'stop'/, `${file} does not report a tool turn`);
  }
});

test('Qoder replays tool calls and tool call ids instead of flattening them', () => {
  const text = source('Kernel/SDK/qoder/adapter/index.ts');
  assert.match(text, /tool_calls: message\.toolCalls\.map/, 'assistant calls are dropped from replayed history');
  assert.match(text, /tool_call_id: message\.toolCallId/, 'tool results are orphaned on replay');
});
