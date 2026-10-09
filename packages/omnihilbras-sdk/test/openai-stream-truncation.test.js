import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIAdapter, ProviderError } from '../dist/index.js';

/**
 * A stream that ends before `[DONE]` is a truncated answer, and must be refused rather than shown as complete.
 * The check is in the shared OpenAI-compatible reader, which OpenAI uses; these drive it through OpenAI itself.
 */

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const meaningful = frame({ id: 'c1', model: 'gpt-4.1-mini', choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] });
const finish = frame({ id: 'c1', model: 'gpt-4.1-mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
const done = 'data: [DONE]\n\n';

const streamOf = (text) => ({
  stream: async function* () { yield text; },
  request: async () => { throw new Error('not used'); },
});

async function drain(text) {
  const adapter = new OpenAIAdapter({ transport: streamOf(text) });
  const chunks = [];
  for await (const chunk of adapter.streamChat({ model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'Hi' }] }, { credential: { type: 'api-key', value: 'k' } })) {
    chunks.push(chunk);
  }
  return chunks;
}

test('a complete stream, ending in [DONE], is accepted', async () => {
  const chunks = await drain(meaningful + finish + done);
  assert.ok(chunks.length > 0, 'the answer is delivered');
});

test('a stream cut off before [DONE] is refused as an invalid response', async () => {
  await assert.rejects(
    () => drain(meaningful + finish),
    (error) => error instanceof ProviderError && error.code === 'INVALID_RESPONSE',
    'a missing [DONE] means the answer was truncated, and must not be shown as complete',
  );
});

test('a stream with no meaningful content, only an empty delta, is refused', async () => {
  await assert.rejects(
    () => drain(frame({ id: 'c1', model: 'gpt-4.1-mini', choices: [{ index: 0, delta: {}, finish_reason: null }] }) + done),
    (error) => error.code === 'INVALID_RESPONSE',
  );
});

test('a stream with no payload at all is refused', async () => {
  await assert.rejects(() => drain(done), (error) => error.code === 'INVALID_RESPONSE');
});
