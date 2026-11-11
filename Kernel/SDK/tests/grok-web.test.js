import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GROK_WEB_MODELS,
  GrokWebAdapter,
  buildGrokBody,
  buildGrokPrompt,
  extractGrokContent,
  normalizeGrokCookie,
} from '../grok-web/dist/adapter/index.js';

/**
 * Grok Web, without a subscription.
 *
 * The fixture is the old executor's NDJSON shape: token frames while the answer is
 * generated, then a `modelResponse` frame carrying the final message. No live request
 * is made here, and no model id is invented beyond the old registry's twelve.
 */

const NDJSON = [
  JSON.stringify({ result: { response: { token: 'Hel' } } }),
  JSON.stringify({ result: { response: { token: 'lo' } } }),
  JSON.stringify({ result: { response: { modelResponse: { message: 'Hello' }, llmInfo: { modelHash: 'fp-1' }, responseId: 'r-1' } } }),
].join('\n');

const request = { model: 'grok-4.1-fast', messages: [{ role: 'user', content: 'Say hello' }] };

function ndjsonFetch({ status = 200, body = NDJSON } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { 'content-type': 'application/x-ndjson' } });
  };
  return { calls, impl };
}

test('the sso cookie is accepted raw, prefixed, or as a whole header', () => {
  assert.equal(normalizeGrokCookie('abc'), 'sso=abc');
  assert.equal(normalizeGrokCookie('sso=abc'), 'sso=abc');
  assert.equal(normalizeGrokCookie('Cookie: sso=abc; other=1'), 'sso=abc; other=1');
  assert.throws(() => normalizeGrokCookie('   '), { code: 'INVALID_REQUEST' });
});

test('the prompt labels earlier turns and leaves the last user turn bare', () => {
  assert.equal(
    buildGrokPrompt([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ]),
    'system: Be terse.\n\nuser: first\n\nassistant: answer\n\nsecond',
  );
});

test('the model id maps to a wire model and a model mode, not just an id', () => {
  const body = buildGrokBody('grok-4.1-fast', 'hi');
  assert.equal(body.modelName, 'grok-4-1-thinking-1129');
  assert.equal(body.modelMode, 'MODEL_MODE_FAST');
  assert.equal(body.message, 'hi');
  assert.equal(body.temporary, true);
});

test('the parser reads token deltas, the final message and the fingerprint', async () => {
  const response = new Response(NDJSON);
  assert.ok(response.body);
  const events = [];
  for await (const event of extractGrokContent(response.body, false)) events.push(event);
  assert.deepEqual(events.filter((event) => event.kind === 'delta').map((event) => event.text), ['Hel', 'lo']);
  assert.equal(events.some((event) => event.kind === 'full' && event.text === 'Hello'), true);
  assert.deepEqual(events.at(-1), { kind: 'done', answer: 'Hello', fingerprint: 'fp-1' });
});

test('chat sends the browser fingerprint and returns the answer', async () => {
  const { calls, impl } = ndjsonFetch();
  const adapter = new GrokWebAdapter({ fetch: impl, now: () => 1_700_000_000_000 });
  const response = await adapter.chat(request, { credential: { type: 'api-key', value: 'sso=abc' } });
  assert.equal(response.message.content, 'Hello');
  assert.equal(response.providerId, 'grok-web');
  assert.equal(response.usage?.estimated, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://grok.com/rest/app-chat/conversations/new');
  assert.equal(calls[0].init.headers.Cookie, 'sso=abc');
  assert.match(calls[0].init.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
  assert.ok(calls[0].init.headers['x-statsig-id']);
  assert.ok(calls[0].init.headers['x-xai-request-id']);
  assert.equal(calls[0].init.headers.origin, 'https://grok.com');
});

test('streamChat returns real token deltas and a terminal chunk', async () => {
  const { impl } = ndjsonFetch();
  const adapter = new GrokWebAdapter({ fetch: impl, now: () => 1_700_000_000_000 });
  const chunks = [];
  for await (const chunk of adapter.streamChat(request, { credential: { type: 'api-key', value: 'sso=abc' } })) chunks.push(chunk);
  assert.equal(chunks[0]?.delta.role, 'assistant');
  assert.equal(chunks.filter((chunk) => chunk.delta.content).map((chunk) => chunk.delta.content).join(''), 'Hello');
  assert.equal(chunks.at(-1)?.finishReason, 'stop');
  assert.equal(adapter.capabilities.streaming, true);
});

test('credential checks map refusals and accept a 400 probe', async () => {
  for (const [status, code] of [[401, 'AUTHENTICATION_FAILED'], [403, 'AUTHENTICATION_FAILED'], [429, 'RATE_LIMITED'], [503, 'PROVIDER_UNAVAILABLE']]) {
    const adapter = new GrokWebAdapter({ fetch: async () => new Response('{}', { status }) });
    await assert.rejects(
      () => adapter.validateCredential({ type: 'api-key', value: 'sso=abc' }),
      (error) => error.code === code,
      `${status} must map to ${code}`,
    );
  }
  const adapter = new GrokWebAdapter({ fetch: async () => new Response('{}', { status: 400 }) });
  assert.equal((await adapter.validateCredential({ type: 'api-key', value: 'sso=abc' })).status, 'valid');
});

test('the catalog is the old registry\'s twelve models', async () => {
  const adapter = new GrokWebAdapter({ fetch: async () => new Response('{}') });
  const models = await adapter.listModels();
  assert.equal(models.length, 12);
  assert.deepEqual(models.map((model) => model.id), GROK_WEB_MODELS.map((model) => model.id));
  assert.equal(models[0]?.providerId, 'grok-web');
});
