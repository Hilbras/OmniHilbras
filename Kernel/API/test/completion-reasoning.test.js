import assert from 'node:assert/strict';
import test from 'node:test';
import { toOpenAIChunk, toOpenAICompletion } from '../dist/src/routes/inference.js';

/**
 * The gateway's chat-completion serializer is the last place a provider's reasoning can
 * disappear. DeepSeek Web returns `message.reasoning`; clients expect OpenAI's
 * `reasoning_content`, and a provider is not fixed by setting a field nobody emits.
 */
test('a provider reasoning block reaches the OpenAI completion as reasoning_content', () => {
  const body = toOpenAICompletion({
    id: 'chatcmpl-test',
    providerId: 'deepseek-web',
    model: 'deepseek-v4-pro-think',
    createdAt: '2026-11-11T00:00:00.000Z',
    message: { role: 'assistant', content: 'The answer is 4.', reasoning: '2 + 2 is four.' },
    finishReason: 'stop',
    usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9, estimated: true },
  });
  assert.equal(body.choices[0].message.reasoning_content, '2 + 2 is four.');
  assert.equal(body.choices[0].message.content, 'The answer is 4.');
  assert.equal(body.usage.total_tokens, 9);
  assert.equal(body.provider, 'deepseek-web');
});

test('a chunk carries reasoning_content when the adapter supplies it', () => {
  const body = toOpenAIChunk({
    id: 'chatcmpl-test',
    providerId: 'deepseek-web',
    model: 'deepseek-v4-pro-think',
    delta: { role: 'assistant', content: '4', reasoning: '2 + 2 is four.' },
    finishReason: 'stop',
  });
  assert.equal(body.choices[0].delta.reasoning_content, '2 + 2 is four.');
  assert.equal(body.choices[0].delta.content, '4');
});

test('a completion without reasoning does not invent the field', () => {
  const body = toOpenAICompletion({
    id: 'chatcmpl-test',
    providerId: 'deepseek-web',
    model: 'deepseek-chat',
    createdAt: '2026-11-11T00:00:00.000Z',
    message: { role: 'assistant', content: 'plain' },
    finishReason: 'stop',
  });
  assert.equal('reasoning_content' in body.choices[0].message, false);
  assert.equal('usage' in body, false);
});
