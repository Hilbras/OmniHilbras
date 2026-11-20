import assert from 'node:assert/strict';
import test from 'node:test';
import { anthropicMessagesToChat, chatToMessagesBody, translatorFor, TRANSLATION_PAIRS } from '../dist/src/core/format-translation.js';

// Phase 7: direct Anthropic Messages translation. These test the pure translation seam (no live gateway),
// so a malformed block or wrong output shape fails here rather than in a client integration.

test('the registry declares a direct anthropic-messages -> openai-chat pair', () => {
  const pair = translatorFor('messages-api');
  assert.ok(pair, 'the pair is registered');
  assert.equal(pair.target, 'openai-chat');
  assert.equal(TRANSLATION_PAIRS.length, 1);
  assert.equal(translatorFor('unknown-format'), undefined);
});

test('system, text and image blocks translate to the chat request shape', () => {
  const chat = anthropicMessagesToChat({
    model: 'claude-sonnet-4',
    system: [{ type: 'text', text: 'Be brief.' }],
    max_tokens: 100,
    temperature: 0.2,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    ],
  });
  assert.equal(chat.model, 'claude-sonnet-4');
  assert.equal(chat.max_tokens, 100);
  assert.equal(chat.temperature, 0.2);
  assert.deepEqual(chat.messages[0], { role: 'system', content: 'Be brief.' });
  assert.deepEqual(chat.messages[1], { role: 'user', content: [{ type: 'text', text: 'Hello' }] });
  const imagePart = chat.messages[2].content[0];
  assert.equal(imagePart.type, 'image_url');
  assert.match(imagePart.image_url.url, /^data:image\/png;base64,/);
});

test('tool_use and tool_result translate to chat tool_calls and tool role', () => {
  const chat = anthropicMessagesToChat({
    model: 'm',
    tools: [{ name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
    ],
  });
  assert.deepEqual(chat.tools, [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } } }]);
  assert.equal(chat.messages[0].role, 'assistant');
  assert.equal(chat.messages[0].tool_calls[0].id, 't1');
  assert.equal(chat.messages[1].content[0].type, 'tool_result');
  assert.equal(chat.messages[1].content[0].tool_call_id, 't1');
});

test('malformed blocks and missing messages are refused, not forwarded', () => {
  assert.throws(() => anthropicMessagesToChat({ model: 'm' }), /messages must be a list/);
  assert.throws(() => anthropicMessagesToChat({ model: 'm', messages: [{ role: 'system', content: 'x' }] }), /role must be user or assistant/);
  assert.throws(() => anthropicMessagesToChat({ model: 'm', messages: [{ role: 'user', content: [{ type: 'bogus' }] }] }), /Unsupported Anthropic content block/);
  assert.throws(() => anthropicMessagesToChat({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', data: 'x' } }] }] }), /base64 source/);
});

test('chat completion reframes back to Anthropic content blocks', () => {
  const body = chatToMessagesBody({
    id: 'msg_1',
    model: 'claude-sonnet-4',
    createdAt: '2026-11-20T00:00:00.000Z',
    content: 'Hi there',
    usage: { inputTokens: 10, outputTokens: 4 },
  });
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.content, [{ type: 'text', text: 'Hi there' }]);
  assert.deepEqual(body.usage, { input_tokens: 10, output_tokens: 4 });

  const withTool = chatToMessagesBody({
    id: 'msg_2', model: 'm', createdAt: '2026-11-20T00:00:00.000Z', content: '',
    toolCalls: [{ id: 't1', function: { name: 'read', arguments: '{"path":"x"}' } }],
  });
  assert.equal(withTool.stop_reason, 'tool_use');
  assert.deepEqual(withTool.content, [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }]);
});
