import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError, ZenAdapter, zenLaneFor, ZEN_LANES } from '../dist/index.js';

/** Records requests and answers from a script keyed by URL. */
function transport(script) {
  const requests = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      const entry = script[request.url];
      if (!entry) throw new Error(`unexpected request to ${request.url}`);
      if (entry.status && entry.status >= 400) {
        throw new ProviderError('PROVIDER_REQUEST_FAILED', 'boom', { providerId: 'opencode', statusCode: entry.status });
      }
      return { status: entry.status ?? 200, headers: new Headers(), data: entry.data };
    },
    stream() {
      throw new Error('not used');
    },
  };
}

const request = (model) => ({ model, messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 32 });

test('each model family is routed to the lane Zen publishes for it', () => {
  // The table is the source: https://opencode.ai/docs/zen
  assert.equal(zenLaneFor('claude-sonnet-5').lane, 'messages');
  assert.equal(zenLaneFor('anthropic/claude-opus-5').lane, 'messages', 'a vendor prefix is stripped first');
  assert.equal(zenLaneFor('qwen3.7-plus').lane, 'messages');
  assert.equal(zenLaneFor('qwen3.8-max').lane, 'chat', 'qwen3.8-max is published on chat, unlike its siblings');
  assert.equal(zenLaneFor('gpt-5.6-sol').lane, 'responses');
  assert.equal(zenLaneFor('grok-4.5').lane, 'responses');
  assert.equal(zenLaneFor('muse-spark-1.3-contributor-free').lane, 'responses');
  assert.equal(zenLaneFor('deepseek-v4-pro').lane, 'chat');
  assert.equal(zenLaneFor('kimi-k3').lane, 'chat');
  assert.equal(zenLaneFor('space-bunny-free').lane, 'chat');
  assert.equal(zenLaneFor('glm-5.3-flash').lane, 'chat');
});

test('the lanes Zen uses but this adapter cannot speak are reported, not guessed at', () => {
  assert.deepEqual(zenLaneFor('jev-1.13'), { lane: 'chat', supported: false });
  assert.deepEqual(zenLaneFor('gemini-3.5-flash'), { lane: 'chat', supported: false });
});

test('an unimplementable model is refused with what it would have needed', async () => {
  const adapter = new ZenAdapter({ transport: transport({}) });
  for (const model of ['jev-1.13-free', 'gemini-3.8-flash']) {
    await assert.rejects(
      () => adapter.chat(request(model), { credential: { type: 'api-key', value: 'k' } }),
      (error) => error.code === 'NOT_SUPPORTED' && /does not implement/.test(error.publicMessage ?? ''),
    );
  }
});

test('a responses-lane request is built and read in the Responses shape', async () => {
  const t = transport({
    [ZEN_LANES.responses]: {
      data: {
        id: 'resp_1',
        model: 'gpt-5.6-sol',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    },
  });
  const adapter = new ZenAdapter({ transport: t });
  const response = await adapter.chat(
    { model: 'gpt-5.6-sol', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }], maxOutputTokens: 32 },
    { credential: { type: 'api-key', value: 'secret' } },
  );

  assert.equal(t.requests[0].url, 'https://opencode.ai/zen/v1/responses');
  const body = JSON.parse(t.requests[0].body);
  assert.equal(body.model, 'gpt-5.6-sol');
  assert.equal(body.max_output_tokens, 32, 'the Responses API names it max_output_tokens');
  assert.deepEqual(body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ], 'content is typed parts, not a bare string');
  assert.equal(body.system, undefined, 'system turns are not an input item in this lane');
  assert.equal(t.requests[0].headers.Authorization, 'Bearer secret');

  assert.equal(response.message.content, 'OK');
  assert.equal(response.finishReason, 'stop');
  assert.deepEqual(response.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
});

test('a responses request that only emitted reasoning still counts as an answer', async () => {
  const t = transport({
    [ZEN_LANES.responses]: {
      data: {
        id: 'resp_2',
        model: 'gpt-5.6-sol',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [],
      },
    },
  });
  const adapter = new ZenAdapter({ transport: t });
  const response = await adapter.chat(request('gpt-5.6-sol'), { credential: { type: 'api-key', value: 'k' } });
  assert.equal(response.finishReason, 'length', 'a truncated reply is reported as length, not a failure');
  assert.equal(response.message.content, '');
});

test('a messages-lane request is built and read in the Anthropic shape', async () => {
  const t = transport({
    [ZEN_LANES.messages]: {
      data: { id: 'msg_1', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 1 } },
    },
  });
  const adapter = new ZenAdapter({ transport: t });
  const response = await adapter.chat(
    { model: 'claude-sonnet-5', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }], maxOutputTokens: 64, stop: ['END'] },
    { credential: { type: 'api-key', value: 'secret' } },
  );

  assert.equal(t.requests[0].url, 'https://opencode.ai/zen/v1/messages');
  assert.equal(t.requests[0].headers['anthropic-version'], '2023-06-01');
  // The messages lane takes the raw key in `x-api-key`. A bearer token there is
  // answered with a 401 even when the key is valid.
  assert.equal(t.requests[0].headers['x-api-key'], 'secret');
  assert.equal(t.requests[0].headers.Authorization, undefined, 'no bearer token on this lane');
  const body = JSON.parse(t.requests[0].body);
  assert.equal(body.system, 'be brief', 'system turns are hoisted out of the message list');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(body.max_tokens, 64, 'this lane requires max_tokens');
  assert.deepEqual(body.stop, ['END']);

  assert.equal(response.message.content, 'OK');
  assert.equal(response.finishReason, 'stop');
  assert.deepEqual(response.usage, { inputTokens: 4, outputTokens: 1 });
});

test('an error envelope from either lane is raised with the reason', async () => {
  for (const [lane, url] of [['responses', ZEN_LANES.responses], ['messages', ZEN_LANES.messages]]) {
    const t = transport({ [url]: { status: 200, data: { error: { message: 'model is overloaded' } } } });
    const adapter = new ZenAdapter({ transport: t });
    const model = lane === 'responses' ? 'gpt-5.6-sol' : 'claude-sonnet-5';
    await assert.rejects(
      () => adapter.chat(request(model), { credential: { type: 'api-key', value: 'k' } }),
      (error) => /model is overloaded/.test(error.publicMessage ?? ''),
      `${lane} lane surfaces the reason`,
    );
  }
});

test('a chat-lane model still uses the OpenAI-compatible wire format', async () => {
  const t = transport({
    [ZEN_LANES.chat]: { data: { id: 'c1', model: 'kimi-k3', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] } },
  });
  const adapter = new ZenAdapter({ transport: t });
  const response = await adapter.chat(request('kimi-k3'), { credential: { type: 'api-key', value: 'k' } });
  assert.equal(t.requests[0].url, 'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(JSON.parse(t.requests[0].body).max_tokens, 32, 'this lane uses max_tokens');
  assert.equal(response.message.content, 'OK');
});

test('streaming is refused on a lane that has no stream, rather than faked', async () => {
  const adapter = new ZenAdapter({ transport: transport({}) });
  await assert.rejects(
    async () => { for await (const _ of adapter.streamChat(request('gpt-5.6-sol'), { credential: { type: 'api-key', value: 'k' } })) void _; },
    (error) => error.code === 'NOT_SUPPORTED' && /[Ss]treaming/.test(error.publicMessage ?? ''),
  );
});

test('validating a credential does not spend a request', async () => {
  // The Zen catalog is public, so a live probe would prove nothing and would
  // bill on every health poll.
  const t = transport({});
  const adapter = new ZenAdapter({ transport: t });
  const result = await adapter.validateCredential({ type: 'api-key', value: 'k' });
  assert.equal(result.status, 'valid');
  assert.equal(t.requests.length, 0, 'no request is made');
  await assert.rejects(
    () => adapter.validateCredential({ type: 'none' }),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
});

test('the model catalog is read from the Zen models endpoint', async () => {
  const t = transport({
    'https://opencode.ai/zen/v1/models': { data: { data: [{ id: 'kimi-k3' }, { id: 'claude-sonnet-5' }, { id: '  ' }, {}] } },
  });
  const adapter = new ZenAdapter({ transport: t });
  const models = await adapter.listModels({ credential: { type: 'api-key', value: 'k' } });
  assert.deepEqual(models.map((model) => model.id), ['kimi-k3', 'claude-sonnet-5'], 'blank and malformed entries are dropped');
  assert.equal(t.requests[0].headers.Authorization, 'Bearer k');
});
