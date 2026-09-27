import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KIRO,
  KIRO_MODELS,
  KiroAdapter,
  decodeKiroEvent,
  kiroCredentialExpired,
  parseKiroEventStream,
  toKiroBody,
} from '../dist/index.js';

/**
 * Kiro is CodeWhisperer's streaming service, not an OpenAI-compatible endpoint, so the
 * envelope and the eventstream framing are the integration. Both are pinned here, because
 * a framing bug produces a truncated or empty answer rather than an error.
 */

function transport(script) {
  const requests = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      const entry = script[request.url];
      if (!entry) throw new Error(`unexpected request to ${request.url}`);
      if (entry.status && entry.status >= 400) {
        const error = new Error(entry.message ?? 'boom');
        error.statusCode = entry.status;
        error.details = { providerMessage: entry.detail };
        throw error;
      }
      return { status: entry.status ?? 200, headers: new Headers(), data: entry.data };
    },
    stream() {
      throw new Error('not used');
    },
  };
}

const request = (model = 'claude-sonnet-4.5', messages = [{ role: 'user', content: 'hi' }]) => ({ model, messages, maxOutputTokens: 256 });
const session = { type: 'oauth', value: 'access-token', refreshToken: 'r1' };

test('the auth constants are the public AWS ones, with no embedded secret', () => {
  assert.equal(KIRO.oidc, 'https://oidc.us-east-1.amazonaws.com');
  assert.equal(KIRO.clientType, 'public');
  assert.equal(KIRO.inferenceUrl, 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse');
  assert.equal(KIRO.streamingTarget, 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse');
  assert.ok(KIRO.scopes.includes('codewhisperer:completions'));
  // Nothing here is a credential, so this file can be committed.
  assert.equal(JSON.stringify(KIRO).includes('secret'), false);
});

test('the envelope is a conversationState, and the model rides on the current message', () => {
  const body = toKiroBody(request('claude-sonnet-4.5'), 'conv-1');
  const state = body.conversationState;
  assert.equal(state.chatTriggerType, 'MANUAL');
  assert.equal(state.conversationId, 'conv-1');
  assert.equal(state.currentMessage.userInputMessage.modelId, 'claude-sonnet-4.5');
  assert.equal(state.currentMessage.userInputMessage.origin, 'AI_EDITOR');
  assert.equal(state.currentMessage.userInputMessage.content, 'hi');
  assert.deepEqual(state.history, []);
});

test('a system turn is folded into the user content, because the envelope has no system role', () => {
  const body = toKiroBody(
    { model: 'claude-sonnet-4.5', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] },
    'conv-1',
  );
  const content = body.conversationState.currentMessage.userInputMessage.content;
  assert.match(content, /be brief/);
  assert.match(content, /hi/);
});

test('earlier turns become history, with the assistant side named as Kiro names it', () => {
  const body = toKiroBody(
    {
      model: 'claude-sonnet-4.5',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ],
    },
    'conv-1',
  );
  const history = body.conversationState.history;
  assert.equal(history.length, 2);
  assert.equal(history[0].userInputMessage.content, 'first');
  assert.equal(history[1].assistantResponseMessage.content, 'answer');
  assert.equal(body.conversationState.currentMessage.userInputMessage.content, 'second');
});

test('message content given as parts is flattened rather than dropped', () => {
  const body = toKiroBody({ model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] }] }, 'conv-1');
  assert.match(body.conversationState.currentMessage.userInputMessage.content, /part one part two/);
});

test('the eventstream framing is read, not guessed', () => {
  // The real shape: `:event-type:` metadata lines and `data:` payloads.
  const body = [
    ':event-type: assistantResponseEvent',
    'data: {"content":"Hello"}',
    '',
    ':event-type: assistantResponseEvent',
    'data: {"content":" world"}',
    '',
    ':event-type: messageStopEvent',
    'data: {"stopReason":"end_turn"}',
  ].join('\n');
  const events = parseKiroEventStream(body);
  assert.deepEqual(events.map((event) => event.type), ['assistantResponseEvent', 'assistantResponseEvent', 'messageStopEvent']);
  assert.equal(events.map((event) => event.text).join(''), 'Hello world');
  assert.equal(events[2].stopReason, 'stop');
});

test('a bare JSON body with no framing still yields an answer', () => {
  // A framing change upstream must not read as an empty response.
  const events = parseKiroEventStream('{"assistantResponseEvent":{"content":"plain"}}');
  assert.equal(events.length, 1);
  assert.equal(events[0].text, 'plain');
});

test('usage and reasoning events are read without becoming answer text', () => {
  const body = [
    ':event-type: reasoningContentEvent',
    'data: {"content":"thinking hard"}',
    ':event-type: assistantResponseEvent',
    'data: {"content":"answer"}',
    ':event-type: usageEvent',
    'data: {"inputTokens":10,"outputTokens":4}',
  ].join('\n');
  const events = parseKiroEventStream(body);
  assert.equal(events[0].type, 'reasoningContentEvent');
  assert.equal(events[0].reasoning, 'thinking hard');
  assert.equal(events[0].text, undefined, 'reasoning is not answer text');
  assert.deepEqual(events[2].usage, { inputTokens: 10, outputTokens: 4 });
});

test('a max-token stop is reported as length, not as a normal stop', () => {
  assert.equal(decodeKiroEvent('{"stopReason":"max_tokens"}', 'messageStopEvent').stopReason, 'length');
  assert.equal(decodeKiroEvent('{"stopReason":"end_turn"}', 'messageStopEvent').stopReason, 'stop');
});

test('an event with no usable body is kept as an event rather than dropped', () => {
  // Dropping it silently is indistinguishable from a truncated answer.
  const event = decodeKiroEvent('{"toolUseEvent":{"toolUseId":"t1"}}', 'toolUseEvent');
  assert.equal(event.type, 'toolUseEvent');
  assert.equal(event.text, undefined);
});

test('a model Kiro does not offer is refused before a request is spent', async () => {
  const t = transport({});
  const adapter = new KiroAdapter({ transport: t });
  await assert.rejects(
    () => adapter.chat(request('claude-opus-9-imaginary'), { credential: session }),
    (error) => error.code === 'NOT_SUPPORTED' && /does not offer/.test(error.publicMessage ?? ''),
  );
  assert.equal(t.requests.length, 0, 'no request is sent for a model that cannot exist');
});

test('a chat request is sent to the streaming service with the AWS framing headers', async () => {
  const t = transport({
    [KIRO.inferenceUrl]: {
      data: [':event-type: assistantResponseEvent', 'data: {"content":"OK"}', ':event-type: messageStopEvent', 'data: {"stopReason":"end_turn"}'].join('\n'),
    },
  });
  const adapter = new KiroAdapter({ transport: t });
  const response = await adapter.chat(request(), { credential: session });
  const sent = t.requests[0];
  assert.equal(sent.url, KIRO.inferenceUrl);
  assert.equal(sent.headers['X-Amz-Target'], KIRO.streamingTarget);
  assert.equal(sent.headers.accept, KIRO.eventStreamAccept);
  assert.equal(sent.headers.Authorization, 'Bearer access-token');
  assert.equal(response.message.content, 'OK');
  assert.equal(response.finishReason, 'stop');
});

test('an empty answer is a failure, not a silent success', async () => {
  const t = transport({ [KIRO.inferenceUrl]: { data: ':event-type: messageStopEvent\ndata: {"stopReason":"end_turn"}' } });
  const adapter = new KiroAdapter({ transport: t });
  await assert.rejects(
    () => adapter.chat(request(), { credential: session }),
    (error) => error.code === 'INVALID_RESPONSE' && /no answer text/.test(error.publicMessage ?? ''),
  );
});

test('the catalog is the known set, and every id is one Kiro really serves', async () => {
  const adapter = new KiroAdapter({ transport: transport({}) });
  const models = await adapter.listModels();
  assert.deepEqual(models.map((model) => model.id), KIRO_MODELS.map((model) => model.id));
  assert.ok(models.every((model) => model.displayName), 'each model carries a name for the dashboard');
  // There is no wildcard, and an unknown id is a 400 upstream, so nothing invented here.
  assert.equal(models.some((model) => model.id === 'auto'), false);
});

test('expiry is judged with a minute of slack', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(kiroCredentialExpired({ type: 'oauth', value: 'a', expiresAt: new Date(now + 30_000).toISOString() }, now), true);
  assert.equal(kiroCredentialExpired({ type: 'oauth', value: 'a', expiresAt: new Date(now + 600_000).toISOString() }, now), false);
  assert.equal(kiroCredentialExpired({ type: 'api-key', value: 'a' }, now), false);
});
