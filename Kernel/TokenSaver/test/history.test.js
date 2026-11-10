import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryCcrStore, retrieve, trimHistory } from '../dist/index.js';

/**
 * Threshold history trimming.
 *
 * The product is the preserved set: system prompts, the first user ask, recent turns and error-bearing
 * tool results. A trim that drops the request or the failure line saves tokens by making the answer
 * wrong, which is not a saving.
 */

const long = (prefix) => `${prefix} ${'x'.repeat(400)}`;

function conversation() {
  return [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: long('first request') },
    { role: 'assistant', content: long('old answer one') },
    { role: 'tool', toolCallId: 'call-1', content: long('old tool output') },
    { role: 'tool', toolCallId: 'call-2', isError: true, content: long('FATAL: database is locked') },
    { role: 'assistant', content: long('middle answer') },
    { role: 'user', content: 'recent question' },
    { role: 'assistant', content: 'recent answer' },
  ];
}

test('below the threshold nothing is touched', () => {
  const messages = conversation();
  const result = trimHistory(messages, { maxInputTokens: 1_000_000, keepRecent: 2 });
  assert.equal(result.trimmed, 0);
  assert.equal(result.originalTokens, result.trimmedTokens);
  assert.deepEqual(result.messages, messages);
});

test('above the threshold old turns are stubbed, and the preserved set survives', () => {
  const messages = conversation();
  const result = trimHistory(messages, { maxInputTokens: 100, keepRecent: 2, ccr: new MemoryCcrStore(), reversible: true });
  assert.ok(result.trimmed > 0, 'nothing was trimmed above the threshold');
  assert.ok(result.trimmedTokens < result.originalTokens);

  assert.deepEqual(result.messages[0], messages[0], 'the system prompt is kept');
  assert.deepEqual(result.messages[1], messages[1], 'the first user ask is the request and is kept');
  assert.ok(String(result.messages[2].content).includes('token-saver:'), 'an old assistant turn is trimmed');
  assert.deepEqual(result.messages[6], messages[6], 'the last two messages are kept');
  assert.deepEqual(result.messages[7], messages[7], 'the last message is kept');

  const errorTool = result.messages.find((message) => message.isError === true);
  assert.deepEqual(errorTool, messages[4], 'an error-bearing tool result is kept verbatim');

  const stubbed = result.messages[3];
  assert.ok(String(stubbed.content).includes('token-saver:'), 'a trimmed message names its retrieval id');
  assert.equal(stubbed.role, messages[3].role, 'the role is preserved');
  assert.equal(stubbed.toolCallId, messages[3].toolCallId, 'the tool call id is preserved');
});

test('a trimmed turn is retrievable from the CCR store', () => {
  const messages = conversation();
  const store = new MemoryCcrStore();
  const result = trimHistory(messages, { maxInputTokens: 100, keepRecent: 2, ccr: store, reversible: true });
  const marker = /<<token-saver:([a-f0-9]+) /.exec(String(result.messages[3].content));
  assert.ok(marker, 'no retrieval marker was written');
  assert.equal(retrieve(store, marker[1]), messages[3].content, 'the original content is retrievable');
});

test('without a store the marker says what was elided rather than pretending it is recoverable', () => {
  const result = trimHistory(conversation(), { maxInputTokens: 100, keepRecent: 2 });
  const marker = String(result.messages[3].content);
  assert.ok(marker.includes('history trimmed'), 'no explicit elision marker');
  assert.equal(marker.includes('<<token-saver:'), false, 'a marker with no store must not offer retrieval');
});
