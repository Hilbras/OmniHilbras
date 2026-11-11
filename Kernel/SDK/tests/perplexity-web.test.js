import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PERPLEXITY_WEB_MODELS,
  PerplexityWebAdapter,
  buildPerplexityBody,
  buildPerplexityQuery,
  cleanPerplexityResponse,
  extractPerplexityContent,
  normalizePerplexityCookie,
  parsePerplexityMessages,
  perplexitySessionKey,
  readPerplexitySse,
} from '../perplexity-web/dist/adapter/index.js';

/**
 * Perplexity Web, the parts that do not need a session.
 *
 * The request shape and the SSE block vocabulary are the old project's measured ones.
 * They are replayed here as recorded bytes, so a parser change that drops a delta, a
 * thinking step or a citation is a test failure rather than a live-account checkout.
 */

const THREAD = { backend_uuid: 'backend-1' };

const SSE = [
  // A plan block is reasoning, not the answer.
  `data: ${JSON.stringify({ ...THREAD, blocks: [{ intended_usage: 'plan', plan_block: { goals: [{ description: 'Plan the search' }] } }] })}\n\n`,
  // Two incremental markdown blocks, then the final DONE block replaces the answer.
  `data: ${JSON.stringify({ blocks: [{ intended_usage: 'markdown', markdown_block: { chunks: ['Hello '], progress: 'IN_PROGRESS' } }] })}\n\n`,
  `data: ${JSON.stringify({ blocks: [{ intended_usage: 'markdown', markdown_block: { chunks: ['world [1].'], progress: 'IN_PROGRESS' } }] })}\n\n`,
  `data: ${JSON.stringify({ blocks: [{ intended_usage: 'markdown', markdown_block: { chunks: ['Hello world.'], progress: 'DONE' } }], final: true })}\n\n`,
].join('');

const request = { model: 'pplx-auto', messages: [{ role: 'user', content: 'Say hello' }] };

/** A fetch that answers with one fresh SSE body per call, and records what was sent. */
function sseFetch({ status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(SSE, { status, headers: { 'content-type': 'text/event-stream' } });
  };
  return { calls, impl };
}

test('a session cookie is accepted raw, as name=value, or as a whole header', () => {
  assert.equal(normalizePerplexityCookie('abc'), '__Secure-next-auth.session-token=abc');
  assert.equal(normalizePerplexityCookie('__Secure-next-auth.session-token=abc'), '__Secure-next-auth.session-token=abc');
  assert.equal(normalizePerplexityCookie('Cookie: a=1; b=2'), 'a=1; b=2');
  assert.throws(() => normalizePerplexityCookie('   '), { code: 'INVALID_REQUEST' });
});

test('the old message shape is preserved: system, history and the last user turn', () => {
  const parsed = parsePerplexityMessages([
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second' },
  ]);
  assert.equal(parsed.system, 'Be terse.\n');
  assert.deepEqual(parsed.history, [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'first answer' }]);
  assert.equal(parsed.current, 'second');
});

test('a follow-up query continues the thread; a first query carries instructions and history', () => {
  const parsed = parsePerplexityMessages([{ role: 'user', content: 'second' }]);
  assert.equal(buildPerplexityQuery(parsed, 'backend-1', undefined), 'second');
  const first = JSON.parse(buildPerplexityQuery({ ...parsed, history: [{ role: 'assistant', content: 'first' }] }, null, undefined));
  assert.equal(first.query, 'second');
  assert.deepEqual(first.history, [{ role: 'assistant', content: 'first' }]);
  assert.match(JSON.stringify(first.instructions), /built-in web search/);
});

test('the parser sees thinking, cumulative deltas and the final answer', async () => {
  const response = new Response(SSE, { status: 200 });
  assert.ok(response.body);
  const events = [];
  for await (const event of extractPerplexityContent(response.body)) events.push(event);
  assert.equal(events[0]?.kind, 'thinking');
  assert.equal(events[0]?.text, 'Plan the search');
  assert.equal(events.some((event) => event.kind === 'delta' && event.text === 'Hello '), true);
  assert.equal(events.some((event) => event.kind === 'delta' && event.text === 'world [1].'), true);
  assert.deepEqual(events.at(-1), { kind: 'done', answer: 'Hello world.', backendUuid: 'backend-1' });
});

test('the SSE reader stops at event: end_of_stream and ignores malformed frames', async () => {
  const body = [
    'data: {"blocks":[]}\n\n',
    'data: not-json\n\n',
    'event: end_of_stream\n\n',
    'data: {"blocks":[{"intended_usage":"markdown","markdown_block":{"chunks":["late"],"progress":"DONE"}}]}\n\n',
  ].join('');
  const response = new Response(body);
  assert.ok(response.body);
  const events = [];
  for await (const event of readPerplexitySse(response.body)) events.push(event);
  assert.equal(events.length, 1, 'only the valid frame before end_of_stream is read');
});

test('citations and UI markers are removed, not sent as part of the answer', () => {
  assert.equal(cleanPerplexityResponse('Hello [1] world. <grok:x>noise</grok:x>'), 'Hello world.');
  assert.equal(cleanPerplexityResponse('  a  b\n\n\n\nc  ', true), 'a b\n\nc');
});

test('the body carries the model preference and a stable thread pointer', () => {
  const body = buildPerplexityBody('hello', 'copilot', 'gpt54', 'backend-1');
  assert.equal(body.query_str, 'hello');
  assert.equal(body.params.model_preference, 'gpt54');
  assert.equal(body.params.last_backend_uuid, 'backend-1');
  assert.equal(body.params.mode, 'copilot');
  assert.equal(body.params.versions, undefined);
});

test('the adapter sends the cookie, returns the answer and reports estimated usage', async () => {
  const { calls, impl } = sseFetch();
  const adapter = new PerplexityWebAdapter({ fetch: impl, now: () => 1_700_000_000_000 });
  const response = await adapter.chat(request, { credential: { type: 'api-key', value: 'abc' } });
  assert.equal(response.providerId, 'perplexity-web');
  assert.equal(response.message.content, 'Hello world.');
  assert.equal(response.message.reasoning, 'Plan the search');
  assert.deepEqual(response.usage, { inputTokens: 3, outputTokens: 3, totalTokens: 6, estimated: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Cookie, '__Secure-next-auth.session-token=abc');
  assert.equal(calls[0].init.headers.origin, 'https://www.perplexity.ai');
});

test('streamChat yields role, real deltas and a terminal chunk', async () => {
  const { impl } = sseFetch();
  const adapter = new PerplexityWebAdapter({ fetch: impl, now: () => 1_700_000_000_000 });
  const chunks = [];
  for await (const chunk of adapter.streamChat(request, { credential: { type: 'api-key', value: '__Secure-next-auth.session-token=abc' } })) chunks.push(chunk);
  assert.equal(chunks[0]?.delta.role, 'assistant');
  assert.equal(chunks.filter((chunk) => chunk.delta.content).map((chunk) => chunk.delta.content).join(''), 'Hello world [1].');
  assert.equal(chunks.at(-1)?.finishReason, 'stop');
  assert.equal(adapter.capabilities.streaming, true);
});

test('credential checks distinguish a dead session from a rate limit and a malformed probe', async () => {
  for (const [status, code] of [[401, 'AUTHENTICATION_FAILED'], [403, 'AUTHENTICATION_FAILED'], [429, 'RATE_LIMITED'], [503, 'PROVIDER_UNAVAILABLE']]) {
    const adapter = new PerplexityWebAdapter({ fetch: async () => new Response('{}', { status }) });
    await assert.rejects(
      () => adapter.validateCredential({ type: 'api-key', value: 'cookie=1' }),
      (error) => error.code === code,
      `${status} must map to ${code}`,
    );
  }
  // A 400 means the cookie was accepted and the deliberately tiny probe body was refused.
  const adapter = new PerplexityWebAdapter({ fetch: async () => new Response('{}', { status: 400 }) });
  assert.equal((await adapter.validateCredential({ type: 'api-key', value: 'cookie=1' })).status, 'valid');
});

test('the catalog is the seven ids the old registry documented', async () => {
  const adapter = new PerplexityWebAdapter({ fetch: async () => new Response('{}') });
  assert.deepEqual((await adapter.listModels()).map((model) => model.id), PERPLEXITY_WEB_MODELS.map((model) => model.id));
  assert.equal(PERPLEXITY_WEB_MODELS.length, 7);
});

test('the session key is stable and bounded by its own history, not by the response', () => {
  assert.equal(perplexitySessionKey([{ role: 'user', content: 'a' }]), perplexitySessionKey([{ role: 'user', content: 'a' }]));
  assert.notEqual(perplexitySessionKey([{ role: 'user', content: 'a' }]), perplexitySessionKey([{ role: 'user', content: 'b' }]));
});
