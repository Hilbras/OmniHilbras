import assert from 'node:assert/strict';
import test from 'node:test';
import { completeToolRounds } from '../dist/index.js';

// A parallel tool round is answered one result at a time, and an agent swarm often interrupts a round, so a
// call can be left without its result. A provider that receives such a conversation refuses it with 400
// (DeepSeek does), which the client then sees as a provider failure rather than its own unanswered call.

test('a call with no result gets an empty result directly after its assistant turn', () => {
  const messages = [
    { role: 'user', content: 'what is 2+2' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_abc', type: 'function', function: { name: 'calc', arguments: '{"x":2}' } }] },
    { role: 'user', content: 'continue' },
  ];
  const repaired = completeToolRounds(messages);
  assert.equal(repaired.length, 4);
  assert.equal(repaired[2].role, 'tool');
  assert.equal(repaired[2].toolCallId, 'call_abc');
  assert.equal(repaired[3].content, 'continue');
});

test('a call that is answered is left alone', () => {
  const messages = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_abc', type: 'function', function: { name: 'calc', arguments: '{}' } }] },
    { role: 'tool', toolCallId: 'call_abc', content: '4' },
  ];
  assert.deepEqual(completeToolRounds(messages), messages);
});

test('every unanswered call in a parallel round is answered, and only the missing ones', () => {
  const messages = [
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call_a', type: 'function', function: { name: 'f', arguments: '{}' } },
        { id: 'call_b', type: 'function', function: { name: 'g', arguments: '{}' } },
      ],
    },
    { role: 'tool', toolCallId: 'call_a', content: 'a' },
    { role: 'user', content: 'next' },
  ];
  const repaired = completeToolRounds(messages);
  const toolIds = repaired.filter((message) => message.role === 'tool').map((message) => message.toolCallId);
  assert.deepEqual(toolIds.sort(), ['call_a', 'call_b']);
  assert.equal(repaired.find((message) => message.toolCallId === 'call_a').content, 'a', 'an existing result is not replaced');
});

test('the input is not mutated', () => {
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'call_x', type: 'function', function: { name: 'f', arguments: '{}' } }] }];
  completeToolRounds(messages);
  assert.equal(messages.length, 1);
});
