import assert from 'node:assert/strict';
import test from 'node:test';
import { KimiCodeAdapter, KIMI_CODE, ProviderError, kimiCodeCredentialExpired, kimiCodeProviderId } from '../dist/index.js';

/**
 * The Kimi Code adapter.
 *
 * The tests are mostly about what must be **refused rather than assumed**, because the failure modes
 * of a new adapter all look like a working integration:
 *
 * - a credential sent in the wrong header produces a 401 whose body names the header it wanted, and
 *   the fix is a two-line branch — so that branch is pinned rather than left to review;
 * - `dimensions` measured, never assumed;
 * - a pending poll is not a denial, and `slow_down` is not a refusal;
 * - an expiry the adapter cannot read resolves to "ask the provider", never to "expired".
 */

function createTransport(overrides = {}) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      if (overrides.request) return overrides.request(request);
      return { status: 200, headers: new Headers(), data: { id: 'c1', model: 'kimi-latest', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] } };
    },
    async *stream(request) {
      calls.push(request);
      yield* (overrides.stream ? overrides.stream(request) : ['data: {"id":"s1","model":"kimi-latest","choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\ndata: [DONE]\n\n']);
    },
  };
}

const OAUTH = { type: 'oauth', value: 'access-token', oauthClientId: KIMI_CODE.clientId };

test('an OAuth credential goes in Authorization: Bearer, not x-api-key', async () => {
  const transport = createTransport();
  const adapter = new KimiCodeAdapter({ transport });
  await adapter.chat({ model: 'kimi-latest', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH });

  const headers = transport.calls[0].headers;
  assert.equal(headers.Authorization, 'Bearer access-token');
  assert.equal(headers['x-api-key'], undefined, 'the coding endpoint distinguishes the two modes by header');
});

test('an API-key credential goes in x-api-key, and the two modes are not confused', async () => {
  const transport = createTransport();
  const adapter = new KimiCodeAdapter({ transport });
  await adapter.chat({ model: 'kimi-latest', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'api-key', value: 'sk-key' } });

  const headers = transport.calls[0].headers;
  assert.equal(headers['x-api-key'], 'sk-key');
  assert.equal(headers.Authorization, undefined);
});

test('no credential at all is refused before a request is sent', async () => {
  const transport = createTransport();
  const adapter = new KimiCodeAdapter({ transport });
  await assert.rejects(
    () => adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
  assert.equal(transport.calls.length, 0, 'a request with nothing to authenticate it was sent anyway');
});

test('chat posts to the coding endpoint with the CLI client headers', async () => {
  const transport = createTransport();
  const adapter = new KimiCodeAdapter({ transport });
  await adapter.chat({ model: 'kimi-latest', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 32, temperature: 0.3 }, { credential: OAUTH });

  const call = transport.calls[0];
  assert.equal(call.url, `${KIMI_CODE.server}/coding/v1/chat/completions`);
  assert.equal(call.headers['X-Msh-Version'], '1');
  assert.equal(call.headers['X-App'], 'cli');
  const body = JSON.parse(call.body);
  assert.equal(body.max_tokens, 32);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.stream, false);
});

test('an absent option is not sent as undefined', async () => {
  const transport = createTransport();
  const adapter = new KimiCodeAdapter({ transport });
  await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH });
  const body = JSON.parse(transport.calls[0].body);
  assert.equal('temperature' in body, false);
  assert.equal('max_tokens' in body, false);
  assert.equal('stop' in body, false);
  assert.equal('tools' in body, false);
});

test('empty content with tool calls is a real answer, not a missing one', async () => {
  const transport = createTransport({
    request: () => ({ status: 200, headers: new Headers(), data: { id: 'c1', model: 'm', choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":"a"}' } }] }, finish_reason: 'tool_calls' }] } }),
  });
  const adapter = new KimiCodeAdapter({ transport });
  const response = await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH });

  assert.equal(response.message.content, null, 'empty string would be indistinguishable from an empty answer');
  assert.equal(response.message.toolCalls.length, 1);
  assert.equal(response.message.toolCalls[0].function.name, 'read');
  assert.equal(response.finishReason, 'tool_calls');
});

test('a response with no message is INVALID_RESPONSE, not an empty chat', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { id: 'c1', model: 'm', choices: [] } }) });
  const adapter = new KimiCodeAdapter({ transport });
  await assert.rejects(() => adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH }), /no message/);
});

test('streaming yields chunks and requires a terminating [DONE]', async () => {
  const transport = createTransport();
  const adapter = new KimiCodeAdapter({ transport });
  const chunks = [];
  for await (const chunk of adapter.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH })) chunks.push(chunk);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].delta.content, 'hi');
  assert.equal(transport.calls[0].body.includes('"stream":true'), true);
});

test('a stream that ends without [DONE] is refused rather than returned as complete', async () => {
  const transport = createTransport({ stream: () => ['data: {"id":"s1","choices":[{"delta":{"content":"hi"}}]}\n\n'] });
  const adapter = new KimiCodeAdapter({ transport });
  await assert.rejects(async () => {
    for await (const _ of adapter.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH })) { /* drain */ }
  }, /ended before completion/);
});

// ── the device flow ─────────────────────────────────────────────────────────

test('beginSignIn posts FORM-encoded to the device_authorization endpoint', async () => {
  // Both facts measured against the live host: the path is `device_authorization` (not
  // `device/code`, which 404s), and a JSON body is refused with "client_id is required" while the
  // same parameters form-encoded return 200 with a real code.
  const transport = createTransport({
    request: () => ({ status: 200, headers: new Headers(), data: { device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: 'https://www.kimi.com/code/authorize_device', expires_in: 900 } }),
  });
  const adapter = new KimiCodeAdapter({ transport });
  const started = await adapter.beginSignIn();

  assert.equal(started.deviceCode, 'dev-1');
  assert.equal(started.userCode, 'ABCD-EFGH');
  assert.ok(started.deviceId, 'the device id the poll must present is minted here');
  assert.equal(started.verificationUrl, 'https://www.kimi.com/code/authorize_device', 'Kimi answers absolute; it is used as given');
  assert.equal(transport.calls[0].url, `${KIMI_CODE.authOrigin}/api/oauth/device_authorization`);
  assert.equal(transport.calls[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(transport.calls[0].body).get('client_id'), KIMI_CODE.clientId);
  assert.equal(transport.calls[0].headers['X-Msh-Device-Id'], started.deviceId);
});

test('a relative verification URI is still joined to the web origin, and an absolute one is not doubled', async () => {
  const relative = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { device_code: 'd', user_code: 'U', verification_uri: '/code' } }) });
  assert.equal((await new KimiCodeAdapter({ transport: relative }).beginSignIn()).verificationUrl, `${KIMI_CODE.webOrigin}/code`);

  const absolute = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { device_code: 'd', user_code: 'U', verification_uri: 'https://www.kimi.com/code/x' } }) });
  const url = (await new KimiCodeAdapter({ transport: absolute }).beginSignIn()).verificationUrl;
  assert.equal(url, 'https://www.kimi.com/code/x', 'joining an absolute URL to the origin would produce a nonsense link');
  assert.equal(url.includes('https://www.kimi.com/https'), false);
});

test('a device-code response missing its codes is refused, not half-returned', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { expires_in: 900 } }) });
  const adapter = new KimiCodeAdapter({ transport });
  await assert.rejects(() => adapter.beginSignIn(), /did not return a device code/);
});

test('authorization_pending and slow_down are both pending, neither is a denial', async () => {
  // `slow_down` is the provider asking for a slower poll, not refusing the grant. Treating it as a
  // denial would fail a sign-in the user completed correctly.
  for (const code of ['authorization_pending', 'slow_down']) {
    const transport = createTransport({ request: () => ({ status: 400, headers: new Headers(), data: { error: code } }) });
    const adapter = new KimiCodeAdapter({ transport });
    const outcome = await adapter.pollSignIn('dev-1', undefined, 'dev-id');
    assert.deepEqual(outcome, { status: 'pending' }, `${code} must read as pending`);
  }
});

test('a refused grant reports the provider wording, redacted', async () => {
  const transport = createTransport({ request: () => ({ status: 400, headers: new Headers(), data: { error: 'access_denied', error_description: 'The user denied the request' } }) });
  const adapter = new KimiCodeAdapter({ transport });
  const outcome = await adapter.pollSignIn('dev-1', undefined, 'dev-id');
  assert.equal(outcome.status, 'denied');
  assert.match(outcome.error, /denied the request/);
});

test('a token response with no access_token is a denial naming the next action', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { expires_in: 900 } }) });
  const adapter = new KimiCodeAdapter({ transport });
  const outcome = await adapter.pollSignIn('dev-1', undefined, 'dev-id');
  assert.equal(outcome.status, 'denied');
  assert.match(outcome.error, /Start the sign-in again/);
});

test('a completed grant yields an oauth credential carrying the refresh token and expiry', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 } }) });
  const adapter = new KimiCodeAdapter({ transport });
  const outcome = await adapter.pollSignIn('dev-1', undefined, 'dev-id');

  assert.equal(outcome.status, 'connected');
  assert.equal(outcome.credential.type, 'oauth');
  assert.equal(outcome.credential.value, 'acc');
  assert.equal(outcome.credential.refreshToken, 'ref');
  assert.ok(outcome.credential.expiresAt, 'an expiry lets the gateway renew without asking again');
  assert.equal(outcome.credential.oauthClientId, KIMI_CODE.clientId, 'the client id the grant was issued to must travel with it');
});

// ── expiry, and the three answers ───────────────────────────────────────────

test('an expiry the adapter cannot read is undefined, so the gateway asks the provider', () => {
  // The load-bearing answer. `false` from an adapter that does not know is indistinguishable from
  // `false` from one that does, and the two ways of being wrong cost very differently.
  assert.equal(kimiCodeCredentialExpired({ type: 'oauth', value: 'a' }, Date.now()), undefined, 'no expiry');
  assert.equal(kimiCodeCredentialExpired({ type: 'oauth', value: 'a', expiresAt: 'not-a-date' }, Date.now()), undefined, 'unreadable');
  assert.equal(kimiCodeCredentialExpired(undefined, Date.now()), false, 'no credential is not an expired one');
  assert.equal(kimiCodeCredentialExpired({ type: 'api-key', value: 'k' }, Date.now()), false, 'an api key never expires here');
});

test('an expiry in the past is expired, and one in the future is not', () => {
  const now = Date.parse('2026-10-06T00:00:00.000Z');
  assert.equal(kimiCodeCredentialExpired({ type: 'oauth', value: 'a', expiresAt: '2026-10-05T23:59:00.000Z' }, now), true);
  assert.equal(kimiCodeCredentialExpired({ type: 'oauth', value: 'a', expiresAt: '2026-10-06T01:00:00.000Z' }, now), false);
});

test('a token about to expire is treated as expired, so it cannot die in flight', () => {
  const now = Date.parse('2026-10-06T00:00:00.000Z');
  assert.equal(kimiCodeCredentialExpired({ type: 'oauth', value: 'a', expiresAt: '2026-10-06T00:00:10.000Z' }, now), true, '10s left is not enough to send a request in');
});

test('an expired credential without a refresh token asks for a new sign-in rather than retrying', async () => {
  const transport = createTransport();
  const adapter = new KimiCodeAdapter({ transport });
  await assert.rejects(
    () => adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'oauth', value: 'a', expiresAt: '2020-01-01T00:00:00.000Z' } }),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /Sign in again/.test(error.message),
  );
  assert.equal(transport.calls.length, 0);
});

test('an expired credential with a refresh token is renewed once, and the caller is told', async () => {
  const refreshed = [];
  let renewals = 0;
  const transport = createTransport({
    request: (request) => {
      if (request.url === `${KIMI_CODE.authOrigin}${KIMI_CODE.deviceTokenPath}`) {
        renewals += 1;
        return { status: 200, headers: new Headers(), data: { access_token: 'fresh', refresh_token: 'ref-2', expires_in: 3600 } };
      }
      return { status: 200, headers: new Headers(), data: { id: 'c1', model: 'm', choices: [{ message: { role: 'assistant', content: 'hi' } }] } };
    },
  });
  const adapter = new KimiCodeAdapter({ transport, onTokensRefreshed: (c) => { refreshed.push(c); } });

  await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, {
    credential: { type: 'oauth', value: 'stale', refreshToken: 'ref', expiresAt: '2020-01-01T00:00:00.000Z' },
  });

  assert.equal(renewals, 1);
  assert.equal(refreshed.length, 1, 'a renewal the caller cannot persist is a renewal that is lost');
  assert.equal(refreshed[0].value, 'fresh');
  assert.equal(refreshed[0].refreshToken, 'ref-2');
  const chat = transport.calls.find((c) => c.url.endsWith('/chat/completions'));
  assert.equal(chat.headers.Authorization, 'Bearer fresh', 'the renewed token is what gets sent');
});

test('a renewal that Kimi refuses asks for a sign-in, and does not retry forever', async () => {
  const transport = createTransport({
    request: (request) => (request.url === `${KIMI_CODE.authOrigin}${KIMI_CODE.deviceTokenPath}`
      ? { status: 400, headers: new Headers(), data: { error: 'invalid_grant' } }
      : { status: 200, headers: new Headers(), data: { id: 'c1', model: 'm', choices: [{ message: { role: 'assistant', content: 'hi' } }] } }),
  });
  const adapter = new KimiCodeAdapter({ transport });
  await assert.rejects(
    () => adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, {
      credential: { type: 'oauth', value: 'stale', refreshToken: 'dead', expiresAt: '2020-01-01T00:00:00.000Z' },
    }),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
  assert.equal(transport.calls.filter((c) => c.url.endsWith('/chat/completions')).length, 0, 'a chat request was sent with a credential the provider had already refused');
});

// ── embeddings ──────────────────────────────────────────────────────────────

test('embed posts to the coding embeddings endpoint and measures dimensions per row', async () => {
  const transport = createTransport({
    request: () => ({ status: 200, headers: new Headers(), data: { id: 'e1', model: 'kimi-embed', data: [{ index: 0, embedding: [1, 2, 3] }, { index: 1, embedding: [4, 5] }], usage: { prompt_tokens: 6, total_tokens: 6 } } }),
  });
  const adapter = new KimiCodeAdapter({ transport });
  const response = await adapter.embed({ model: 'kimi-embed', input: ['a', 'b'] }, { credential: OAUTH });

  assert.equal(transport.calls[0].url, `${KIMI_CODE.server}/coding/v1/embeddings`);
  assert.deepEqual(response.data.map((row) => row.dimensions), [3, 2], 'per row, not one constant');
  assert.equal(response.usage.inputTokens, 6);
});

test('embed refuses a short result rather than returning fewer vectors than inputs', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { data: [{ index: 0, embedding: [1, 2, 3] }] } }) });
  const adapter = new KimiCodeAdapter({ transport });
  await assert.rejects(() => adapter.embed({ model: 'm', input: ['a', 'b'] }, { credential: OAUTH }), /1 embedding\(s\) for 2 input\(s\)/);
});

test('embed refuses an empty input before sending anything', async () => {
  const transport = createTransport();
  const adapter = new KimiCodeAdapter({ transport });
  for (const input of ['', [], ['ok', '']]) {
    await assert.rejects(() => adapter.embed({ model: 'm', input }, { credential: OAUTH }), /non-empty/);
  }
  assert.equal(transport.calls.length, 0);
});

// ── identity and health ─────────────────────────────────────────────────────

test('the adapter declares its own identity and capabilities', () => {
  const adapter = new KimiCodeAdapter({ transport: createTransport() });
  assert.equal(adapter.id, kimiCodeProviderId);
  assert.equal(adapter.id, 'kimi-code');
  assert.equal(adapter.name, 'Kimi Code');
  // Declared because the endpoint serves them; it is not an inference from the vendor's name.
  assert.equal(adapter.capabilities.embeddings, true);
});

test('health is decided by whether the free model list answers, and reports which', async () => {
  const healthy = new KimiCodeAdapter({ transport: createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { data: [{ id: 'kimi-latest' }] } }) }) });
  const ok = await healthy.healthCheck({ credential: OAUTH });
  assert.equal(ok.status, 'healthy');
  assert.equal(ok.verified, 'credential');

  const broken = new KimiCodeAdapter({ transport: createTransport({ request: () => { throw new ProviderError('AUTHENTICATION_FAILED', 'no session', { providerId: 'kimi-code' }); } }) });
  const bad = await broken.healthCheck({ credential: OAUTH });
  assert.equal(bad.status, 'unavailable');
  assert.equal(bad.verified, 'credential', 'a credential verdict, not a guess about the provider being down');
});

test('the model list is read from the coding endpoint', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { data: [{ id: 'kimi-latest' }, { id: 'kimi-k2.5' }, {}] } }) });
  const adapter = new KimiCodeAdapter({ transport });
  const models = await adapter.listModels({ credential: OAUTH });

  assert.equal(transport.calls[0].url, `${KIMI_CODE.server}/coding/v1/models`);
  assert.deepEqual(models.map((m) => m.id), ['kimi-latest', 'kimi-k2.5'], 'an entry with no id is dropped, not rendered as undefined');
});