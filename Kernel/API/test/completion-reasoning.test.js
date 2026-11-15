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

test('a chat reply names the account that served, and never invents one', () => {
  /**
   * `provider` alone cannot say which member of a virtual model answered: its targets are *accounts*, and two
   * targets of one provider are indistinguishable by provider id. The value comes from the failover ledger, so
   * it is the account that actually served rather than the one that was planned — and with no ledger entry the
   * field is absent, not guessed.
   */
  const completion = {
    id: 'chatcmpl-test',
    providerId: 'opencode-console',
    model: 'beam-free',
    createdAt: '2026-11-15T00:00:00.000Z',
    message: { role: 'assistant', content: 'ok' },
    finishReason: 'stop',
  };
  const served = toOpenAICompletion(completion, 'opencode-console-2');
  assert.equal(served.provider, 'opencode-console');
  assert.equal(served.connection, 'opencode-console-2');

  const unrecorded = toOpenAICompletion(completion);
  assert.equal('connection' in unrecorded, false, 'absent rather than invented');
});
