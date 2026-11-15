import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleAdapter } from '../openai/dist/lib/openai-compatible.js';
import { forgetResponsesLanes } from '../openai/dist/lib/responses-lane.js';
import { FetchHttpTransport } from '../openai/dist/lib/transport.js';

/**
 * The Responses lane, and the refusal that selects it.
 *
 * AgentRouter serves some models only through `/v1/responses`. A real turn on 2026-11-16, with a credential
 * the relay had already accepted:
 *
 * ```
 * HTTP 502 provider=agentrouter
 * {"error":{"message":"模型 gpt-6-astra 不支持 /v1/chat/completions 接口,请改用 /v1/responses(OpenAI
 *  Responses API). Model gpt-6-astra does not support /v1/chat/completions, please use /v1/responses
 *  instead. (request id: ...)"}}
 * ```
 *
 * The other models on that connection (`glm`, `deepseek`) answer `/v1/chat/completions`, so the decision is
 * per model and is learned from the refusal rather than matched by name — see
 * `lib/responses-lane.ts`. The refusal's **sentence** is the discriminator; the status only excludes the four
 * cases where a second request is wrong whatever the body says (401, 403, 408, 429), so an envelope nobody has
 * seen yet is retried rather than ignored. These tests are behavioural: a real `FetchHttpTransport` with a
 * scripted `fetch`, so the refusal is classified by the code that classifies refusals in production — a
 * hand-built `ProviderError` would prove that the predicate reads the field the test wrote, and nothing
 * about whether the transport puts the provider's sentence there.
 *
 * The memo lives for the life of the process, so every test clears it first. `forgetResponsesLanes` exists
 * for that and is the only reason it is exported.
 */

const CREDENTIAL = { type: 'api-key', value: 'sk-bogus-not-a-key' };

/** The relay's own wording, verbatim, including the byte range a Chinese-locale provider sends. */
const LANE_REFUSAL = '模型 gpt-6-astra 不支持 /v1/chat/completions 接口,请改用 /v1/responses(OpenAI Responses API). Model gpt-6-astra does not support /v1/chat/completions, please use /v1/responses instead. (request id: 8b1d7f61-0000)';

const laneRefusal = () => ({ status: 400, body: { error: { message: LANE_REFUSAL } } });

/** A `fetch` double that answers by path, so the lane a request took is visible in the URLs asked for. */
function scriptedFetch({ refusesChat = () => undefined, refusesResponses = () => undefined } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const href = String(url);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url: href, path: new URL(href).pathname, body });
    const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (href.endsWith('/chat/completions')) {
      const refusal = refusesChat(body);
      if (refusal) return json(refusal.status, refusal.body);
      return json(200, {
        id: 'chat-1',
        model: body.model,
        created: 1,
        choices: [{ message: { role: 'assistant', content: 'hello from chat' }, finish_reason: 'stop' }],
      });
    }
    if (href.endsWith('/responses')) {
      const refusal = refusesResponses(body);
      if (refusal) return json(refusal.status, refusal.body);
      return json(200, {
        id: 'resp-1',
        model: body.model,
        created_at: 1,
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello from responses' }] }],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      });
    }
    throw new Error(`the fixture does not serve ${href}`);
  };
  return { calls, impl };
}

function adapterFor(fetchImpl, config = {}) {
  return new OpenAICompatibleAdapter({
    id: 'agentrouter',
    name: 'AgentRouter',
    baseUrl: 'https://agentrouter.org/v1',
    auth: { header: 'Authorization', prefix: 'Bearer' },
    responsesPath: '/responses',
    ...config,
  }, { transport: new FetchHttpTransport({ fetch: fetchImpl }) });
}

const turn = (model) => ({ model, messages: [{ role: 'user', content: 'hi' }] });

test('a model the relay refuses on the chat path is answered on the Responses path', async () => {
  forgetResponsesLanes();
  const script = scriptedFetch({ refusesChat: (body) => (body.model === 'gpt-6-astra' ? laneRefusal() : undefined) });
  const adapter = adapterFor(script.impl);

  const response = await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL });

  // The chat path was tried first and the Responses path answered: that order is the whole mechanism.
  assert.deepEqual(script.calls.map((call) => call.path), ['/v1/chat/completions', '/v1/responses']);
  assert.equal(response.message.content, 'hello from responses');
  // The retry is a **Responses** request, not the chat body sent to another path.
  assert.equal(script.calls[1].body.stream, false);
  assert.deepEqual(script.calls[1].body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  assert.equal(script.calls[1].body.messages, undefined);
  assert.equal(response.usage.inputTokens, 3);
});

test('the second turn for the same model goes straight to the Responses path', async () => {
  forgetResponsesLanes();
  const script = scriptedFetch({ refusesChat: (body) => (body.model === 'gpt-6-astra' ? laneRefusal() : undefined) });
  const adapter = adapterFor(script.impl);

  await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL });
  const afterFirst = script.calls.length;
  await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL });
  await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL });

  // One refused attempt for the life of the process, not one per turn — the cost the memo exists to bound.
  assert.equal(script.calls.filter((call) => call.path === '/v1/chat/completions').length, 1);
  assert.deepEqual(script.calls.slice(afterFirst).map((call) => call.path), ['/v1/responses', '/v1/responses']);
});

test('a model the relay does not refuse keeps the chat path, and the memo does not travel between providers', async () => {
  forgetResponsesLanes();
  const script = scriptedFetch({ refusesChat: (body) => (body.model === 'gpt-6-astra' ? laneRefusal() : undefined) });
  const adapter = adapterFor(script.impl);

  // A model on the same connection that answers the chat path: nothing about the lane may touch it.
  const response = await adapter.chat(turn('glm-4.6'), { credential: CREDENTIAL });
  assert.deepEqual(script.calls.map((call) => call.path), ['/v1/chat/completions']);
  assert.equal(response.message.content, 'hello from chat');

  // The memo is keyed by provider and model, so the same model id on another endpoint starts where every
  // model starts: a lane is a fact about one relay, not about a name.
  await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL });
  const other = adapterFor(script.impl, { id: 'other-endpoint' });
  const beforeOther = script.calls.length;
  await other.chat(turn('gpt-6-astra'), { credential: CREDENTIAL });
  assert.deepEqual(script.calls.slice(beforeOther).map((call) => call.path), ['/v1/chat/completions', '/v1/responses']);
});

test('a provider with no Responses lane is not retried at all', async () => {
  forgetResponsesLanes();
  // The rule that protects every other provider: without `responsesPath` the refusal is thrown exactly as
  // it always was, so nothing in this change alters what a provider that has only a chat lane does.
  const script = scriptedFetch({ refusesChat: () => laneRefusal() });
  const adapter = adapterFor(script.impl, { id: 'other-endpoint', responsesPath: undefined });

  const error = await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL }).then(() => undefined, (thrown) => thrown);
  assert.equal(error.statusCode, 400);
  assert.deepEqual(script.calls.map((call) => call.path), ['/v1/chat/completions']);
});

test('a 422 carrying the refusal is retried, because the envelope is not the statement', async () => {
  forgetResponsesLanes();
  // The status the relay actually uses is unknown from here (a bogus key is judged before model routing), so
  // the decision is the sentence and the status only excludes. A 422 that says "not on this endpoint" is that
  // statement just as much as a 400 is, and keying on a list of accepted statuses is how the lane stops
  // working the day the relay changes envelope — which is the silent failure this test exists to prevent.
  const script = scriptedFetch({ refusesChat: () => ({ status: 422, body: { error: { message: LANE_REFUSAL } } }) });
  const adapter = adapterFor(script.impl);

  const response = await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL });

  assert.deepEqual(script.calls.map((call) => call.path), ['/v1/chat/completions', '/v1/responses']);
  assert.equal(response.message.content, 'hello from responses');
});

test('a 500 carrying the refusal is retried, for the same reason', async () => {
  forgetResponsesLanes();
  // An outage that answers with this sentence is still telling us where the model lives. Nothing is lost if
  // it is wrong: the second attempt spends one request and its own failure is the one reported, with this one
  // attached as the cause.
  const script = scriptedFetch({ refusesChat: () => ({ status: 500, body: { error: { message: LANE_REFUSAL } } }) });
  const adapter = adapterFor(script.impl);

  const response = await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL });

  assert.deepEqual(script.calls.map((call) => call.path), ['/v1/chat/completions', '/v1/responses']);
  assert.equal(response.message.content, 'hello from responses');
});

test('a 429 carrying the refusal is not retried: the status exclusion wins over the message', async () => {
  forgetResponsesLanes();
  // The provider is asking for patience, not another endpoint — and a throttle that happens to quote the
  // paths it applies to must keep its meaning for the retry policy rather than be spent on a second request.
  const script = scriptedFetch({ refusesChat: () => ({ status: 429, body: { error: { message: `rate limit reached: ${LANE_REFUSAL}` } } }) });
  const adapter = adapterFor(script.impl);

  const error = await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL }).then(() => undefined, (thrown) => thrown);

  assert.equal(error.code, 'RATE_LIMITED');
  assert.deepEqual(script.calls.map((call) => call.path), ['/v1/chat/completions']);
});

test('a 401 carrying the refusal is not retried: a rejected credential is not a lane', async () => {
  forgetResponsesLanes();
  const script = scriptedFetch({ refusesChat: () => ({ status: 401, body: { error: { message: LANE_REFUSAL } } }) });
  const adapter = adapterFor(script.impl);

  const error = await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL }).then(() => undefined, (thrown) => thrown);

  assert.equal(error.code, 'AUTHENTICATION_FAILED');
  assert.deepEqual(script.calls.map((call) => call.path), ['/v1/chat/completions']);
});

test('text that does not name both endpoints is not retried, whatever the status', async () => {
  forgetResponsesLanes();

  // A body that mentions the chat path but not the other one — the relay refused the request, and the
  // Responses lane would refuse it identically. Both endpoint names are required for exactly this reason, and
  // that requirement is what keeps the widened status rule from becoming "retry every failure".
  const otherBadRequest = scriptedFetch({ refusesChat: () => ({ status: 400, body: { error: { message: 'invalid request: max_tokens is not supported on /v1/chat/completions' } } }) });
  const bad = adapterFor(otherBadRequest.impl);
  const badError = await bad.chat(turn('gpt-6-astra'), { credential: CREDENTIAL }).then(() => undefined, (error) => error);
  assert.equal(badError.statusCode, 400);
  assert.deepEqual(otherBadRequest.calls.map((call) => call.path), ['/v1/chat/completions']);

  // A 500 that says nothing about either endpoint: an outage, which stays an outage. This is the case the
  // 500-in-the-previous-test could be mistaken for.
  const outage = scriptedFetch({ refusesChat: () => ({ status: 500, body: { error: { message: 'internal server error' } } }) });
  const down = adapterFor(outage.impl);
  const downError = await down.chat(turn('gpt-6-astra'), { credential: CREDENTIAL }).then(() => undefined, (error) => error);
  assert.equal(downError.code, 'PROVIDER_UNAVAILABLE');
  assert.deepEqual(outage.calls.map((call) => call.path), ['/v1/chat/completions']);

  // A 404 with no body at all: the transport falls back to naming the status, which names no endpoint.
  const emptyBody = scriptedFetch({ refusesChat: () => ({ status: 404, body: {} }) });
  const missing = adapterFor(emptyBody.impl);
  await missing.chat(turn('gpt-6-astra'), { credential: CREDENTIAL }).catch(() => undefined);
  assert.deepEqual(emptyBody.calls.map((call) => call.path), ['/v1/chat/completions']);

  // And no memo was written by any of them, so the next turn still starts on the chat path.
  const stillChat = scriptedFetch({ refusesChat: () => undefined });
  const recovered = adapterFor(stillChat.impl);
  await recovered.chat(turn('gpt-6-astra'), { credential: CREDENTIAL });
  assert.deepEqual(stillChat.calls.map((call) => call.path), ['/v1/chat/completions']);
});

test('when the Responses attempt fails too, that failure is the one reported and the refusal is its cause', async () => {
  forgetResponsesLanes();
  const script = scriptedFetch({
    refusesChat: (body) => (body.model === 'gpt-6-astra' ? laneRefusal() : undefined),
    refusesResponses: () => ({ status: 429, body: { error: { message: 'rate limit reached' } } }),
  });
  const adapter = adapterFor(script.impl);

  const error = await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL }).then(() => undefined, (thrown) => thrown);

  // What the caller acts on is the failure that ended the turn — its status is what a retry policy reads —
  // not a summary of the pair.
  assert.equal(error.code, 'RATE_LIMITED');
  assert.equal(error.statusCode, 429);
  // And the first refusal is still readable behind it, which is the point: the relay's sentence explaining
  // why the chat path was abandoned must not be replaced by the second failure.
  assert.ok(error.cause instanceof Error, `expected a cause, got ${JSON.stringify(error.cause)}`);
  assert.match(error.cause.details.providerMessage, /不支持 \/v1\/chat\/completions/);
  assert.deepEqual(script.calls.map((call) => call.path), ['/v1/chat/completions', '/v1/responses']);
});

test('a stream refused on the chat path is retried on the Responses lane and translated', async () => {
  forgetResponsesLanes();

  const frames = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hel","output_index":0}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo","output_index":0}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","model":"gpt-6-astra","status":"completed","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n',
  ].join('');
  const calls = [];
  const impl = async (url, init = {}) => {
    const href = String(url);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ path: new URL(href).pathname, body });
    if (href.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ error: { message: LANE_REFUSAL } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    // A real `Response` with a body, because the transport reads the stream rather than a parsed value.
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const adapter = adapterFor(impl);

  const chunks = [];
  for await (const chunk of adapter.streamChat(turn('gpt-6-astra'), { credential: CREDENTIAL })) chunks.push(chunk);

  assert.deepEqual(calls.map((call) => call.path), ['/v1/chat/completions', '/v1/responses']);
  assert.equal(calls[1].body.stream, true);
  assert.deepEqual(chunks.map((chunk) => chunk.delta.content).filter(Boolean), ['hel', 'lo']);
  assert.equal(chunks.at(-1).finishReason, 'stop');
  assert.equal(chunks.at(-1).usage.outputTokens, 1);

  // The lane was learned here too, so the next stream skips the refused attempt.
  const before = calls.length;
  for await (const chunk of adapter.streamChat(turn('gpt-6-astra'), { credential: CREDENTIAL })) void chunk;
  assert.deepEqual(calls.slice(before).map((call) => call.path), ['/v1/responses']);
});
