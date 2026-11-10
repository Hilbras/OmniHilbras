import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAVEMAN_PROMPTS,
  PONYTAIL_PROMPTS,
  injectCaveman,
  injectPonytail,
  injectSystemPrompt,
} from '../dist/index.js';

/** Prompt injection is append-only, idempotent, and never changes a conversation that has no system turn. */

test('a prompt is appended to an existing system message as its own paragraph', () => {
  const messages = [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'hi' }];
  const output = injectSystemPrompt(messages, 'Be classical.');
  assert.equal(output[0].content, 'You are terse.\n\nBe classical.');
  assert.deepEqual(output[1], messages[1]);
  assert.equal(messages[0].content, 'You are terse.', 'the input is not mutated');
});

test('injection is idempotent for a retried request', () => {
  const once = injectSystemPrompt([{ role: 'system', content: 'base' }], 'prompt');
  const twice = injectSystemPrompt(once, 'prompt');
  assert.deepEqual(twice, once, 'the prompt was appended twice');
});

test('a missing system turn is created at the front', () => {
  const output = injectSystemPrompt([{ role: 'user', content: 'hi' }], 'prompt');
  assert.deepEqual(output[0], { role: 'system', content: 'prompt' });
  assert.equal(output[1].role, 'user');
});

test('array content gets a text block rather than a stringified array', () => {
  const messages = [{ role: 'system', content: [{ type: 'text', text: 'base' }] }];
  const output = injectSystemPrompt(messages, 'prompt');
  assert.deepEqual(output[0].content, [{ type: 'text', text: 'base' }, { type: 'text', text: 'prompt' }]);
});

test('caveman and ponytail select a level and a missing level is a no-op', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  assert.match(String(injectCaveman(messages, 'full')[0].content), /terse caveman/);
  assert.match(String(injectPonytail(messages, 'ultra')[0].content), /YAGNI extremist/);
  assert.deepEqual(injectCaveman(messages, undefined), messages);
  assert.equal(Object.keys(CAVEMAN_PROMPTS).length, 6);
  assert.equal(Object.keys(PONYTAIL_PROMPTS).length, 3);
});
