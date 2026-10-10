import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  KIRO,
  KIRO_MODELS,
  KiroAdapter,
  refreshKiroCredential,
  decodeKiroStream,
  kiroCredentialExpired,
  toKiroBody,
  toKiroEvent,
} from '../dist/index.js';

/**
 * Kiro is CodeWhisperer's streaming service, not an OpenAI-compatible endpoint, so the
 * envelope and the binary framing are the whole integration.
 *
 * The framing tests run against `fixtures/kiro-stream.bin`, which is a **real captured
 * response** — a 7-frame AWS eventstream read off the live service. An earlier version of
 * this file built its own fixture for a text framing the service never sends, every test
 * passed, and not one request worked. The encoder below exists only to build extra cases;
 * the format itself is pinned by the bytes the provider actually returned.
 */

const realStream = new Uint8Array(readFileSync(fileURLToPath(new URL('./fixtures/kiro-stream.bin', import.meta.url))));

/** Builds one frame in the same layout, for cases the capture does not contain. */
function frame(eventType, payload, { omitEventType = false } = {}) {
  const header = (name, value) => {
    const nameBytes = Buffer.from(name, 'utf8');
    const valueBytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(valueBytes.length);
    return Buffer.concat([Buffer.from([nameBytes.length]), nameBytes, Buffer.from([7]), length, valueBytes]);
  };
  const headers = omitEventType
    ? Buffer.concat([header(':content-type', 'application/json')])
    : Buffer.concat([header(':event-type', eventType), header(':content-type', 'application/json')]);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(16 + headers.length + body.length, 0);
  prelude.writeUInt32BE(headers.length, 4);
  // The CRCs are not verified by the decoder, so a fixed value is enough here.
  return Buffer.concat([prelude, headers, body, Buffer.alloc(4)]);
}

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

const request = (model = 'claude-haiku-4.5', messages = [{ role: 'user', content: 'hi' }]) => ({
  model,
  messages,
  maxOutputTokens: 256,
});
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

test('the real captured stream decodes to the answer Kiro actually gave', () => {
  const events = decodeKiroStream(realStream);
  // 7 frames, consumed exactly — a decoder that stops early would still "pass" a
  // truthiness check on the text, so the count is asserted too.
  assert.equal(events.length, 7);
  const text = events.map((event) => event.text ?? '').join('');
  assert.equal(text, 'Hey. What are you working on?');
});

test('the captured frames are the event names Kiro really sends', () => {
  // No `messageStopEvent` and no `usageEvent` exist in a real response. An adapter that
  // waits for them waits forever, and one that reports them is inventing them.
  const types = decodeKiroStream(realStream).map((event) => event.type);
  assert.deepEqual(new Set(types), new Set(['assistantResponseEvent', 'contextUsageEvent', 'meteringEvent']));
  assert.equal(types.includes('messageStopEvent'), false);
  assert.equal(types.includes('usageEvent'), false);
});

test('credits and context usage are read rather than dropped', () => {
  // Kiro meters credits and publishes no token counts, so this is the only cost signal.
  const events = decodeKiroStream(realStream);
  const metered = events.find((event) => event.type === 'meteringEvent');
  assert.ok(typeof metered.creditsUsed === 'number' && metered.creditsUsed > 0);
  const context = events.find((event) => event.type === 'contextUsageEvent');
  assert.ok(typeof context.contextUsagePercent === 'number');
});

test('Kiro advertises streaming, and its stream carries the same answer as a chat request', async () => {
  // The gateway refuses a streamed request to any adapter whose `streaming` flag is not true, with a 501
  // "does not support streaming". Kiro's stream is assembled from the eventstream and yielded whole, so the
  // capability is honest, and the flag was the only thing refusing it.
  const adapter = new KiroAdapter({ transport: transport({ [KIRO.inferenceUrl]: { data: realStream } }) });
  assert.equal(adapter.capabilities.streaming, true);
  const chunks = [];
  for await (const chunk of adapter.streamChat(request(), { credential: session })) chunks.push(chunk);
  assert.ok(chunks.length >= 1, 'the stream yields at least one chunk');
  const text = chunks.map((chunk) => chunk.delta?.content ?? '').join('');
  assert.equal(text, 'Hey. What are you working on?');
});

test('a live request returns the text, the finish reason, and the credit cost', async () => {
  const t = transport({ [KIRO.inferenceUrl]: { data: realStream } });
  const adapter = new KiroAdapter({ transport: t });
  const response = await adapter.chat(request(), { credential: session });
  assert.equal(response.message.content, 'Hey. What are you working on?');
  // The stream simply ends; there is no stop event to read a reason from.
  assert.equal(response.finishReason, 'stop');
  assert.equal(response.meters?.unit, 'credit');
  assert.ok(response.meters.amount > 0);
  // Kiro publishes no token counts, so none are invented.
  assert.equal(response.usage, undefined);
});

test('the request asks for bytes, because a text decode corrupts the stream', async () => {
  const t = transport({ [KIRO.inferenceUrl]: { data: realStream } });
  await new KiroAdapter({ transport: t }).chat(request(), { credential: session });
  assert.equal(t.requests[0].responseAs, 'bytes');
  assert.equal(t.requests[0].headers['X-Amz-Target'], KIRO.streamingTarget);
  assert.equal(t.requests[0].headers.accept, KIRO.eventStreamAccept);
  assert.equal(t.requests[0].headers.Authorization, 'Bearer access-token');
});

test('a request carries no profileArn when the session has no profile', async () => {
  // An empty `profileArn` is not the same as no profile: Kiro answers
  // `400 Improperly formed request` for it, which cost a debugging round trip.
  const body = toKiroBody(request(), 'conv-1', session);
  assert.equal('profileArn' in body, false);
  const t = transport({ [KIRO.inferenceUrl]: { data: realStream } });
  await new KiroAdapter({ transport: t }).chat(request(), { credential: session });
  assert.equal(JSON.parse(t.requests[0].body).profileArn, undefined);
});

test('a session scoped to a profile does send its profileArn', () => {
  const body = toKiroBody(request(), 'conv-1', { ...session, accountId: 'arn:aws:codewhisperer:us-east-1:1:profile/PROFILE' });
  assert.equal(body.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/PROFILE');
});

test('an empty-string profileArn is not sent, because it is a 400', () => {
  const body = toKiroBody(request(), 'conv-1', { ...session, accountId: '' });
  assert.equal('profileArn' in body, false);
});

test('a truncated stream yields the frames that arrived and stops', () => {
  // Cutting the body mid-frame must not read past the end or invent a final event.
  const events = decodeKiroStream(realStream.subarray(0, 500));
  assert.ok(events.length >= 1 && events.length < 7);
  assert.equal(decodeKiroStream(new Uint8Array()).length, 0);
});

test('a frame claiming an impossible length ends the walk instead of reading past it', () => {
  const corrupt = Buffer.from(realStream);
  corrupt.writeUInt32BE(0xfffffff0, 0);
  assert.deepEqual(decodeKiroStream(new Uint8Array(corrupt)), []);
});

test('a frame with no event-type header is still an event, not a dropped one', () => {
  const bytes = new Uint8Array(frame('assistantResponseEvent', { content: 'x' }, { omitEventType: true }));
  const events = decodeKiroStream(bytes);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, undefined, 'no type means no text is claimed');
});

test('several frames are joined into one answer', () => {
  const bytes = Buffer.concat([
    frame('assistantResponseEvent', { content: 'Hello' }),
    frame('assistantResponseEvent', { content: ' world' }),
  ]);
  assert.equal(
    decodeKiroStream(new Uint8Array(bytes))
      .map((event) => event.text ?? '')
      .join(''),
    'Hello world',
  );
});

test('an unparseable payload still counts as a frame', () => {
  const event = toKiroEvent('assistantResponseEvent', {});
  assert.equal(event.type, 'assistantResponseEvent');
  assert.equal(event.text, undefined);
});

test('an unknown event name is carried through rather than dropped', () => {
  const event = toKiroEvent('someNewEvent', { anything: true });
  assert.equal(event.type, 'someNewEvent');
});

test('a model the plan does not carry says so, rather than reading as a broken request', async () => {
  // Kiro answers a 400 that reads like a malformed request. Naming the entitlement is the
  // difference between "Kiro is broken" and "this account cannot use this model".
  const t = transport({
    [KIRO.inferenceUrl]: {
      status: 400,
      message: 'The provider request failed.',
      detail: 'Invalid model. Please select a different model to continue.',
    },
  });
  await assert.rejects(
    () => new KiroAdapter({ transport: t }).chat(request('claude-sonnet-5'), { credential: session }),
    (error) => error.code === 'NOT_SUPPORTED' && /plan does not offer claude-sonnet-5/.test(error.publicMessage ?? ''),
  );
});

test('any other provider failure is passed through unchanged', async () => {
  const t = transport({
    [KIRO.inferenceUrl]: { status: 500, message: 'The provider request failed.', detail: 'Internal server error' },
  });
  await assert.rejects(
    () => new KiroAdapter({ transport: t }).chat(request(), { credential: session }),
    (error) => error.code !== 'NOT_SUPPORTED',
  );
});

test('an empty answer is a failure, not a silent success', async () => {
  const t = transport({ [KIRO.inferenceUrl]: { data: new Uint8Array(frame('meteringEvent', { usage: 0.01 })) } });
  await assert.rejects(
    () => new KiroAdapter({ transport: t }).chat(request(), { credential: session }),
    (error) => error.code === 'INVALID_RESPONSE' && /no answer text/.test(error.publicMessage ?? ''),
  );
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
  const body = toKiroBody(
    { model: 'claude-sonnet-4.5', messages: [{ role: 'user', content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] }] },
    'conv-1',
  );
  assert.match(body.conversationState.currentMessage.userInputMessage.content, /part one part two/);
});

test('a model Kiro does not offer is refused before a request is spent', async () => {
  const t = transport({});
  await assert.rejects(
    () => new KiroAdapter({ transport: t }).chat(request('claude-opus-9-imaginary'), { credential: session }),
    (error) => error.code === 'NOT_SUPPORTED' && /does not offer/.test(error.publicMessage ?? ''),
  );
  assert.equal(t.requests.length, 0, 'no request is sent for a model that cannot exist');
});

test('the catalog is the known set, and every id is one Kiro really serves', async () => {
  const models = await new KiroAdapter({ transport: transport({}) }).listModels();
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

/* ------------------------------------------------------------------ *
 * The refresh grant
 * ------------------------------------------------------------------ */

/**
 * The auth half reads OAuth token endpoints with `fetch` directly, so these stub the
 * global rather than injecting a transport.
 */
async function withStubbedFetch(handler, run) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    seen.push({ url: String(url), body });
    return handler(String(url), body);
  };
  try {
    // A rejection is captured rather than thrown, so a test can assert on what was sent
    // as well as on the error.
    return { result: await run().then((value) => ({ value }), (error) => ({ error })), seen };
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (data, status = 200) => ({
  status,
  headers: new Headers(),
  text: async () => JSON.stringify(data),
});

test('the refresh grant sends the registered client, not the client name', async () => {
  // This is the bug: `clientId: KIRO.clientName, clientSecret: KIRO.clientName` answers
  // `401 invalid_client — Invalid client secret provided` from AWS, every single time.
  const session = {
    type: 'oauth',
    value: 'old-access',
    refreshToken: 'r1',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    oauthClientId: 'client-abc123',
    oauthClientSecret: 'secret-xyz789',
  };
  const { result, seen } = await withStubbedFetch(
    () => jsonResponse({ accessToken: 'new-access', refreshToken: 'r2', expiresIn: 3600 }),
    () => refreshKiroCredential(session),
  );
  const token = seen.find((call) => call.url.endsWith('/token'));
  assert.equal(token.body.clientId, 'client-abc123');
  assert.equal(token.body.clientSecret, 'secret-xyz789');
  assert.equal(token.body.grantType, 'refresh_token');
  assert.equal(result.value.value, 'new-access');
  assert.equal(result.value.refreshToken, 'r2');
});

test('a renewed credential keeps its client, or the next refresh has nothing to send', async () => {
  const session = {
    type: 'oauth',
    value: 'old',
    refreshToken: 'r1',
    oauthClientId: 'client-abc123',
    oauthClientSecret: 'secret-xyz789',
  };
  const { result } = await withStubbedFetch(
    () => jsonResponse({ accessToken: 'new', expiresIn: 3600 }),
    () => refreshKiroCredential(session),
  );
  assert.equal(result.value.oauthClientId, 'client-abc123');
  assert.equal(result.value.oauthClientSecret, 'secret-xyz789');
});

test('a credential with no client refuses to refresh rather than sending a placeholder', async () => {
  // Better to say "sign in again" than to send a guess AWS will reject with a 401 that
  // reads like a bad password.
  const { result, seen } = await withStubbedFetch(
    () => jsonResponse({ error: 'invalid_client' }),
    () => refreshKiroCredential({ type: 'oauth', value: 'old', refreshToken: 'r1' }),
  );
  assert.equal(seen.length, 0, 'nothing is sent without a client to send');
  assert.equal(result.error.code, 'AUTHENTICATION_FAILED');
});

test('an expired refresh token says so, rather than reporting a bad paste', async () => {
  // `invalid_grant` is what AWS says when a token is dead or belongs to another client —
  // both of which mean "sign in again", not "that was not a token".
  const { result } = await withStubbedFetch(
    () => jsonResponse({ error: 'invalid_grant', error_description: 'Invalid refresh token provided' }, 400),
    () =>
      refreshKiroCredential({
        type: 'oauth',
        value: 'old',
        refreshToken: 'r1',
        oauthClientId: 'c',
        oauthClientSecret: 's',
      }),
  );
  assert.match(result.error.publicMessage ?? '', /expired/);
});

test('Kiro reports whether its OAuth token has expired, and says so only when it can tell', () => {
  // Background renewal needs to know when a Kiro token expires without a network call. "Cannot say" must stay
  // distinct from "valid": an API key or an unreadable expiry is undefined, never a confident false.
  const adapter = new KiroAdapter({ transport: transport({}) });
  const now = Date.parse('2026-10-10T12:00:00Z');
  assert.equal(adapter.isCredentialExpired({ type: 'oauth', value: 'x', expiresAt: new Date(now - 1000).toISOString() }, now), true, 'an expired token is expired');
  assert.equal(adapter.isCredentialExpired({ type: 'oauth', value: 'x', expiresAt: new Date(now + 3_600_000).toISOString() }, now), false, 'a valid token is not');
  assert.equal(adapter.isCredentialExpired({ type: 'oauth', value: 'x' }, now), undefined, 'no expiry is cannot-say, not expired');
  assert.equal(adapter.isCredentialExpired({ type: 'oauth', value: 'x', expiresAt: 'not-a-date' }, now), undefined, 'an unreadable expiry is cannot-say');
  assert.equal(adapter.isCredentialExpired({ type: 'api-key', value: 'k' }, now), undefined, 'an API key has no expiry to read');
});
