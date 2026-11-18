import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicToolId, fillMissingToolResponses, healToolIds } from '../dist/index.js';

test('invalid tool ids are healed deterministically, including tool result references', () => {
  const messages = [
    { role: 'assistant', content: '', toolCalls: [
      { id: 'bad id!', type: 'function', function: { name: 'read', arguments: '{}' } },
      { id: '', type: 'function', function: { name: 'grep', arguments: '{}' } },
    ] },
    { role: 'tool', content: 'one', toolCallId: 'bad id!' },
  ];
  const healed = healToolIds(messages);
  assert.deepEqual(healed[0].toolCalls.map((call) => call.id), ['badid', deterministicToolId(0, 1, 'grep')]);
  assert.equal(healed[1].toolCallId, 'badid');
  assert.equal(messages[0].toolCalls[0].id, 'bad id!', 'the input was not changed');
});

test('a duplicate id within one request is replaced rather than reused', () => {
  const healed = healToolIds([{ role: 'assistant', content: '', toolCalls: [
    { id: 'same', type: 'function', function: { name: 'read', arguments: '{}' } },
    { id: 'same', type: 'function', function: { name: 'grep', arguments: '{}' } },
  ] }]);
  assert.equal(new Set(healed[0].toolCalls.map((call) => call.id)).size, 2);
});

test('an unanswered tool call gets an empty result under the healed id', () => {
  const messages = [{ role: 'assistant', content: '', toolCalls: [
    { id: 'bad id', type: 'function', function: { name: 'read', arguments: '{}' } },
  ] }];
  const filled = fillMissingToolResponses(healToolIds(messages));
  assert.equal(filled.length, 2);
  assert.deepEqual(filled[1], { role: 'tool', content: '', toolCallId: 'badid' });

  const answered = fillMissingToolResponses([
    ...messages,
    { role: 'tool', content: 'ok', toolCallId: 'bad id' },
  ]);
  assert.equal(answered.length, 2, 'an existing answer was duplicated');
});
