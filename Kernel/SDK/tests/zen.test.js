import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError } from '../zen/dist/lib/errors.js';
import { ZenAdapter, zenLaneFor, ZEN_LANES } from '../zen/dist/adapter/index.js';

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

test('an OAuth grant on the messages lane sends a bearer token and its org header', async () => {
  // The last three commits fixed exactly this path, and no test exercised it: every Zen test passed an
  // API key. An OAuth credential sent as `x-api-key` reached the lane with no credential at all.
  const t = transport({
    [ZEN_LANES.messages]: {
      data: { id: 'msg_2', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' },
    },
  });
  const adapter = new ZenAdapter({ transport: t });
  await adapter.chat(
    { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 16 },
    { credential: { type: 'oauth', value: 'grant-token', orgId: 'org-42' } },
  );
  assert.equal(t.requests[0].headers.Authorization, 'Bearer grant-token');
  assert.equal(t.requests[0].headers['x-api-key'], undefined, 'an OAuth grant is not a raw key');
  assert.equal(t.requests[0].headers['x-opencode-org-id'], 'org-42');
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

test('validating a credential reads the catalog with the key, and refuses a key Zen refuses', async () => {
  /**
   * This test used to assert the opposite — that no request was made — on the premise that the Zen
   * catalog is public, so a listing could not say anything about a key. Measured on 2026-11-08:
   *
   * ```
   * GET /zen/v1/models                                    -> 200 (no credential needed)
   * GET /zen/v1/models   Authorization: Bearer <bad>      -> 401 {"message":"Invalid credential"}
   * ```
   *
   * The endpoint judges the credential when one is sent, which is exactly what `listModels` sends. So the
   * check reads the listing **with** the key: it still spends no tokens, and it stops reporting "valid"
   * for a key the provider answers `401 This API key has expired` to — which is what the dashboard showed
   * for an expired Zen key while every chat through it failed.
   */
  const t = transport({ 'https://opencode.ai/zen/v1/models': { data: { data: [{ id: 'kimi-k3' }] } } });
  const adapter = new ZenAdapter({ transport: t });
  const result = await adapter.validateCredential({ type: 'api-key', value: 'k' });
  assert.equal(result.status, 'valid');
  assert.equal(t.requests.length, 1, 'the listing is what proves the key');
  assert.equal(t.requests[0].headers.Authorization, 'Bearer k', 'and it carries the credential, or it proves nothing');

  const refused = transport({ 'https://opencode.ai/zen/v1/models': { status: 401, data: {} } });
  await assert.rejects(
    () => new ZenAdapter({ transport: refused }).validateCredential({ type: 'api-key', value: 'expired' }),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /refused this key/.test(error.publicMessage ?? ''),
    'a refused key must not be reported as valid',
  );

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


// ── OpenCode Go: the same wire on the subscription lane ───────────────────────

test('the Go instance answers as itself and sends every lane to the /zen/go base', async () => {
  const t = transport({
    'https://opencode.ai/zen/go/v1/chat/completions': { data: { id: 'c', model: 'glm-5.3', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } },
    'https://opencode.ai/zen/go/v1/responses': { data: { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } },
    'https://opencode.ai/zen/go/v1/messages': { data: { id: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
    'https://opencode.ai/zen/go/v1/models': { data: { data: [{ id: 'glm-5.3' }, { id: 'kimi-k3' }] } },
  });
  const go = new ZenAdapter({ id: 'opencode-go', name: 'OpenCode Go', base: 'https://opencode.ai/zen/go', transport: t });

  assert.equal(go.id, 'opencode-go');
  assert.equal(go.name, 'OpenCode Go');
  assert.deepEqual((await go.listModels({ credential: { type: 'api-key', value: 'k' } })).map((m) => m.id), ['glm-5.3', 'kimi-k3']);

  // One model per lane, so the base is proved for all three rather than for the one a default picks.
  const answer = await go.chat({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'api-key', value: 'k' } });
  assert.equal(answer.providerId, 'opencode-go', 'a Go answer says Go, not Zen — the two are different accounts');
  await go.chat({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'api-key', value: 'k' } });
  await go.chat({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'api-key', value: 'k' } });
  assert.deepEqual(t.requests.map((r) => r.url).filter((u) => u.includes('/chat/') || u.includes('/responses') || u.includes('/messages')).sort(), [
    'https://opencode.ai/zen/go/v1/chat/completions',
    'https://opencode.ai/zen/go/v1/messages',
    'https://opencode.ai/zen/go/v1/responses',
  ]);
});

test('the Go dictionary of models is read, because the Zen one is a different product', () => {
  // The lane table is shared — it is the same gateway — but the model *families* on each lane are the
  // plan's, so a Go-only id has to land on the lane Go serves it from.
  assert.deepEqual(zenLaneFor('kimi-k3'), { lane: 'chat', supported: true });
  assert.deepEqual(zenLaneFor('claude-haiku-5-5'), { lane: 'messages', supported: true });
  assert.deepEqual(zenLaneFor('grok-4.7'), { lane: 'responses', supported: true });
});

test('usage reports three meters, and percent is the used side of 100', async () => {
  const t = transport({
    'https://opencode.ai/zen/go/v1/usage': { data: { usage: { rolling: { percent: 12.5, resetsAt: '2026-11-08T20:00:00.000Z' }, weekly: { percent: '40' }, monthly: {} } } },
  });
  const go = new ZenAdapter({ id: 'opencode-go', name: 'OpenCode Go', base: 'https://opencode.ai/zen/go', transport: t });
  const quota = await go.quota({ credential: { type: 'api-key', value: 'k' } });

  assert.equal(t.requests[0].headers.Authorization, 'Bearer k');
  // `percent` is what is *used*: reporting 100 − percent here would show an exhausted plan as empty.
  assert.deepEqual(quota.resources.Rolling, { used: 12.5, limit: 100, remaining: 87.5, resetsAt: '2026-11-08T20:00:00.000Z' });
  assert.deepEqual(quota.resources.Weekly, { used: 40, limit: 100, remaining: 60 }, 'a string percent is a percent');
  assert.equal('Monthly' in quota.resources, false, 'a meter the provider did not report is left out, not shown as zero');
});

test('usage with no meters at all reports none, rather than an empty balance', async () => {
  // A pay-as-you-go key answers a wallet, not these meters. An empty resource map is the honest answer:
  // the dashboard then says the provider did not report one instead of drawing an empty bar.
  const t = transport({ 'https://opencode.ai/zen/v1/usage': { data: { usage: {} } } });
  const quota = await new ZenAdapter({ transport: t }).quota({ credential: { type: 'api-key', value: 'k' } });
  assert.deepEqual(quota.resources, {});
  assert.equal(quota.plan, 'OpenCode Zen');
});

test('usage without a credential is refused by name, and no request is made', async () => {
  const t = transport({});
  await assert.rejects(
    () => new ZenAdapter({ transport: t }).quota({ credential: { type: 'none' } }),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
  assert.equal(t.requests.length, 0);
});
