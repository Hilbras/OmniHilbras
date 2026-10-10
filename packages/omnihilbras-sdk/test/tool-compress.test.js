import assert from 'node:assert/strict';
import test from 'node:test';
import { compressToolResults } from '../dist/index.js';

// An agent loop resends every tool result on every turn. A long `grep` or log is most of that cost, and most of
// its lines are never read again. The compressor keeps the head and tail of a long result and says how many lines
// it dropped. It must never damage a result the model needs to see as a failure, and it must never make a
// conversation invalid, so any doubt returns the input unchanged.

const lines = (count) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

test('a long tool result keeps its head and tail and says how many lines were dropped', () => {
  const messages = [{ role: 'tool', toolCallId: 'c1', content: lines(2000) }];
  const [out] = compressToolResults(messages);
  assert.ok(out.content.length < messages[0].content.length, 'the result is smaller');
  const kept = out.content.split('\n');
  assert.equal(kept[0], 'line 1', 'the first line survives');
  assert.equal(kept.at(-1), 'line 2000', 'the last line survives');
  assert.match(out.content, /1820 lines omitted/, 'the omitted count is stated: 2000 - 120 - 60');
  assert.equal(out.toolCallId, 'c1', 'the call id is untouched');
});

test('a result marked as an error is byte-identical, however long', () => {
  const failure = { role: 'tool', toolCallId: 'c2', content: lines(2000), isError: true };
  const [out] = compressToolResults([failure]);
  assert.equal(out.content, failure.content, 'a failure trace is never shortened');
});

test('a short result is returned unchanged, because shortening it saves nothing worth the risk', () => {
  const messages = [{ role: 'tool', toolCallId: 'c3', content: lines(100) }];
  assert.deepEqual(compressToolResults(messages), messages);
});

test('a result whose content is not text is returned unchanged', () => {
  const parts = [{ type: 'text', text: lines(2000) }];
  const messages = [{ role: 'tool', toolCallId: 'c4', content: parts }];
  const [out] = compressToolResults(messages);
  assert.equal(out.content, parts, 'only plain text is compressed');
});

test('a message that is not a tool result is never touched', () => {
  const user = { role: 'user', content: lines(2000) };
  const [out] = compressToolResults([user]);
  assert.equal(out.content, user.content);
});

test('an error inside the compressor returns the original messages, not a partial result', () => {
  const hostile = { role: 'tool', toolCallId: 'c5' };
  Object.defineProperty(hostile, 'content', { get() { throw new Error('boom'); } });
  const messages = [hostile];
  assert.equal(compressToolResults(messages), messages, 'fail-open returns the same input');
});

test('the input is not mutated', () => {
  const messages = [{ role: 'tool', toolCallId: 'c6', content: lines(2000) }];
  const before = messages[0].content;
  compressToolResults(messages);
  assert.equal(messages[0].content, before);
});
