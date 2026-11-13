import assert from 'node:assert/strict';
import test from 'node:test';
import { OPENCODE_CONSOLE, OpencodeConsoleAdapter, opencodeConsoleCredentialExpired, opencodeConsoleProviderId, refreshOpencodeConsoleCredential } from '../opencode-console/dist/adapter/index.js';
import { ProviderError } from '../opencode-console/dist/lib/errors.js';

/** Serves a script keyed by URL and records what was sent. */
function transport(script) {
  const requests = [];
  return {
    requests,
    urls: () => requests.map((r) => r.url),
    async request(request) {
      requests.push(request);
      const entry = script[request.url];
      if (!entry) throw new Error(`unexpected request to ${request.url}`);
      if (entry.status && entry.status >= 400) {
        throw new ProviderError('PROVIDER_REQUEST_FAILED', entry.message ?? 'boom', {
          providerId: opencodeConsoleProviderId,
          statusCode: entry.status,
        });
      }
      return { status: entry.status ?? 200, headers: new Headers(), data: entry.data };
    },
    stream() {
      throw new Error('not used');
    },
  };
}

const CONFIG_URL = `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.configPath}`;
const USER_URL = `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.userPath}`;
const TOKEN_URL = `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.deviceTokenPath}`;
const OPENAI_LANE = 'https://opencode.ai/inference/openai/v1';
const ANTHROPIC_LANE = 'https://opencode.ai/inference/anthropic/v1';
/** The adapter appends `v1/messages`, so the lane's own trailing `/v1` is dropped. */
const ANTHROPIC_MESSAGES = `${ANTHROPIC_LANE.replace(/\/v1$/, '')}/v1/messages`;
const GOOGLE_LANE = 'https://opencode.ai/inference/google/v1beta';

/** The signed-in config, shaped as the Console returns it. */
const config = (orgId) => ({
  data: {
    config: {
      provider: {
        opencode: {
          api: OPENAI_LANE,
          options: { headers: { 'x-opencode-org-id': orgId } },
          models: {
            'mimo-v2.6-flash-free': {},
            'space-bunny-free': {},
            'gpt-paid': {},
            'claude-sonnet-5': { provider: { api: ANTHROPIC_LANE } },
            'gemini-3.5-flash': { provider: { api: GOOGLE_LANE } },
          },
        },
      },
    },
  },
});

const signedIn = (orgId = 'org_abc') => ({ type: 'oauth', value: 'access-token', orgId });

test('the Console endpoints and client id match what the server expects', () => {
  assert.equal(OPENCODE_CONSOLE.server, 'https://console.opencode.ai');
  assert.equal(OPENCODE_CONSOLE.clientId, 'opencode-cli');
  assert.equal(OPENCODE_CONSOLE.grantType, 'urn:ietf:params:oauth:grant-type:device_code');
});

test('a signed-in session lists the models the server routes, not a hardcoded set', async () => {
  const t = transport({ [CONFIG_URL]: config('org_abc') });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  const models = await adapter.listModels({ credential: signedIn() });
  assert.deepEqual(
    models.map((m) => m.id).sort(),
    ['claude-sonnet-5', 'gemini-3.5-flash', 'gpt-paid', 'mimo-v2.6-flash-free', 'space-bunny-free'],
  );
  assert.equal(t.requests[0].headers.Authorization, 'Bearer access-token');
  assert.equal(t.requests[0].headers['x-opencode-org-id'], 'org_abc');
});

test('a free model is sent through the free-tier contract, not the plain lane', async () => {
  // OpenCode answers a plain request for a free model with 403 FreeTierError. The adapter must send the
  // gated request instead: a streaming body, a declared tool and the opencode client identity.
  const streamed = [];
  const t = {
    ...transport({ [CONFIG_URL]: config('org_abc') }),
    stream(request) {
      streamed.push(request);
      return (async function* () {
        yield 'data: {"id":"c1","choices":[{"delta":{"content":"OK"}}]}\n\n';
        yield 'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
        yield 'data: [DONE]\n\n';
      })();
    },
  };
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  const response = await adapter.chat(
    { model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 64 },
    { credential: signedIn() },
  );
  assert.equal(response.message.content, 'OK');
  assert.equal(streamed.length, 1, 'one gated streaming request');
  const body = JSON.parse(streamed[0].body);
  assert.equal(body.stream, true, 'the request streams');
  assert.ok(Array.isArray(body.tools) && body.tools.length > 0, 'a tool is declared');
  assert.equal(body.model, 'mimo-v2.6-flash-free');
  assert.ok(String(streamed[0].headers['user-agent']).startsWith('opencode/'), 'the opencode client identity is sent');
  assert.ok(streamed[0].headers['x-opencode-session'], 'a session header is sent');
  assert.ok(!t.urls().includes(`${OPENAI_LANE}/chat/completions`), 'the plain lane is not used for a free model');
});

test('a Claude model is served from the anthropic lane, with the org header', async () => {
  const t = transport({
    [CONFIG_URL]: config('org_abc'),
    [ANTHROPIC_MESSAGES]: {
      data: { id: 'm1', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 1 } },
    },
  });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  const response = await adapter.chat(
    { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 64 },
    { credential: signedIn() },
  );
  const sent = t.requests.at(-1);
  // The lane from the config already ends in `/v1`, and the Anthropic adapter appends
  // `v1/messages`. Passing the lane as-is asks for `/v1/v1/messages`, which is a 404.
  assert.equal(sent.url, ANTHROPIC_MESSAGES);
  assert.ok(!sent.url.includes('/v1/v1/'), 'the path must not double');
  assert.equal(sent.headers['x-opencode-org-id'], 'org_abc');
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');
  assert.equal(response.message.content, 'OK');
});

test('a Gemini model is refused by name rather than sent to the wrong lane', async () => {
  const t = transport({ [CONFIG_URL]: config('org_abc') });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  await assert.rejects(
    () => adapter.chat({ model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }] }, { credential: signedIn() }),
    (error) => error.code === 'NOT_SUPPORTED' && /Google GenAI/.test(error.publicMessage ?? ''),
  );
});

test('an unknown model falls back to the default lane rather than failing', async () => {
  const t = transport({
    [CONFIG_URL]: config('org_abc'),
    [`${OPENAI_LANE}/chat/completions`]: { data: { id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] } },
  });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  const response = await adapter.chat({ model: 'brand-new-model', messages: [{ role: 'user', content: 'hi' }] }, { credential: signedIn() });
  assert.equal(response.message.content, 'OK');
  assert.ok(t.urls().includes(`${OPENAI_LANE}/chat/completions`));
});

test('a model the server does not list at all is refused, not guessed at', async () => {
  const t = transport({
    [CONFIG_URL]: { data: { config: { provider: { opencode: { models: {} } } } } },
  });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  await assert.rejects(
    () => adapter.chat({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }, { credential: signedIn() }),
    (error) => error.code === 'NOT_SUPPORTED',
  );
});

test('validating a session reads the free user endpoint and bills nothing', async () => {
  const t = transport({ [USER_URL]: { data: { id: 'usr_1', email: 'dev@example.com' } } });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  const result = await adapter.validateCredential(signedIn());
  assert.equal(result.status, 'valid');
  assert.equal(t.requests.length, 1);
  assert.equal(t.requests[0].url, USER_URL);
  await assert.rejects(
    () => adapter.validateCredential({ type: 'none' }),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
});

test('an expired session is renewed before the request is sent', async () => {
  const t = transport({
    [TOKEN_URL]: { data: { access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 } },
    [CONFIG_URL]: config('org_new'),
    [`${OPENAI_LANE}/chat/completions`]: { data: { id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] } },
  });
  const saved = [];
  const adapter = new OpencodeConsoleAdapter({ transport: t, onTokensRefreshed: (c) => saved.push(c) });
  const stale = { type: 'oauth', value: 'stale', refreshToken: 'r1', orgId: 'org_abc', expiresAt: new Date(Date.now() - 1000).toISOString() };
  await adapter.chat({ model: 'gpt-paid', messages: [{ role: 'user', content: 'hi' }] }, { credential: stale });

  const refresh = t.requests[0];
  assert.equal(refresh.url, TOKEN_URL);
  assert.deepEqual(JSON.parse(refresh.body), { grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'opencode-cli' });
  assert.equal(saved.length, 1, 'the renewed credential is persisted');
  assert.equal(saved[0].value, 'fresh');
  assert.equal(saved[0].refreshToken, 'rotated');
  assert.equal(saved[0].orgId, 'org_abc', 'the org survives renewal, so the header is not lost');
  assert.equal(t.requests.at(-1).headers.Authorization, 'Bearer fresh');
});

test('expiry is judged with a minute of slack and never for a key', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  assert.equal(opencodeConsoleCredentialExpired({ type: 'oauth', value: 'a', expiresAt: new Date(now + 30_000).toISOString() }, now), true);
  assert.equal(opencodeConsoleCredentialExpired({ type: 'oauth', value: 'a', expiresAt: new Date(now + 600_000).toISOString() }, now), false);
  assert.equal(opencodeConsoleCredentialExpired({ type: 'oauth', value: 'a' }, now), false);
  assert.equal(opencodeConsoleCredentialExpired({ type: 'api-key', value: 'a' }, now), false);
});

test('a session with no refresh token says to sign in again', async () => {
  await assert.rejects(
    () => refreshOpencodeConsoleCredential({ type: 'oauth', value: 'a', expiresAt: new Date(0).toISOString() }, transport({})),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /Sign in again/.test(error.publicMessage ?? ''),
  );
});

test('lanes are cached per session rather than refetched on every request', async () => {
  const t = transport({
    [CONFIG_URL]: config('org_abc'),
    [`${OPENAI_LANE}/chat/completions`]: { data: { id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] } },
  });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  for (let i = 0; i < 3; i++) {
    await adapter.chat({ model: 'gpt-paid', messages: [{ role: 'user', content: 'hi' }] }, { credential: signedIn() });
  }
  assert.equal(t.urls().filter((u) => u === CONFIG_URL).length, 1, 'the config is read once');
});

test('a renewed session does not reuse the previous session lanes', async () => {
  const t = transport({
    [TOKEN_URL]: { data: { access_token: 'fresh', expires_in: 3600 } },
    [CONFIG_URL]: config('org_abc'),
    [`${OPENAI_LANE}/chat/completions`]: { data: { id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] } },
  });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  const stale = { type: 'oauth', value: 'stale', refreshToken: 'r1', orgId: 'org_abc', expiresAt: new Date(0).toISOString() };
  await adapter.chat({ model: 'gpt-paid', messages: [{ role: 'user', content: 'hi' }] }, { credential: stale });
  await adapter.chat({ model: 'gpt-paid', messages: [{ role: 'user', content: 'hi' }] }, { credential: signedIn('org_abc') });
  assert.equal(t.urls().filter((u) => u === CONFIG_URL).length, 2, 'a different session reads its own config');
});

test('the org id is taken from the config when the credential has none', async () => {
  const t = transport({
    // No org on the credential, so the config call needs one looked up from the
    // account first: `/api/config` answers `400 org_required` without it.
    [`${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.orgsPath}`]: { data: [{ id: 'org_looked_up', name: 'Personal' }] },
    [CONFIG_URL]: config('org_from_server'),
    [`${OPENAI_LANE}/chat/completions`]: { data: { id: 'c1', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] } },
  });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  await adapter.chat(
    { model: 'gpt-paid', messages: [{ role: 'user', content: 'hi' }] },
    { credential: { type: 'oauth', value: 'access-token' } },
  );
  assert.equal(t.requests.at(-1).headers['x-opencode-org-id'], 'org_from_server');
});

test('a vendor-prefixed model id resolves to the same lane as the bare id', async () => {
  const t = transport({
    [CONFIG_URL]: config('org_abc'),
    [ANTHROPIC_MESSAGES]: {
      data: { id: 'm1', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' },
    },
  });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  const response = await adapter.chat(
    { model: 'anthropic/claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
    { credential: signedIn() },
  );
  assert.equal(response.message.content, 'OK');
  assert.ok(t.urls().includes(ANTHROPIC_MESSAGES), 'a prefix does not change the lane');
});

test('a streamed tool call on a free model reaches the caller, with its arguments joined', async () => {
  // The free-tier stream read only text and the finish reason, so a tool call the model made was dropped and the
  // finish reason was reported as stop. An agent cannot continue from that.
  const t = {
    ...transport({ [CONFIG_URL]: config('org_abc') }),
    stream() {
      return (async function* () {
        yield 'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":"}}]}}]}\n\n';
        yield 'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}\n\n';
        yield 'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n';
        yield 'data: [DONE]\n\n';
      })();
    },
  };
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  const pieces = [];
  let finish;
  for await (const chunk of adapter.streamChat({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'ls' }] }, { credential: signedIn() })) {
    pieces.push(...(chunk.delta.toolCalls ?? []));
    if (chunk.finishReason) finish = chunk.finishReason;
  }
  assert.equal(pieces[0]?.id, 'call_1', 'the call is delivered, not dropped');
  assert.equal(pieces.map((p) => p.function?.arguments ?? '').join(''), '{"command":"ls"}', 'the fragments join into the whole JSON');
  assert.equal(finish, 'tool_calls', 'a tool-call finish is reported as tool_calls, not stop');
});

test('the Console free-limit refusal reaches the client in its own words', async () => {
  // Measured: a free model answers 429 {"type":"error","error":{"type":"FreeUsageLimitError",
  // "message":"Free usage limit reached. Free models work in OpenCode (https://opencode.ai);
  // subscribe to OpenCode Go to keep going: https://opencode.ai/go"}}. The generic
  // "The provider rate limit was reached." removes the one sentence that tells the reader what to do.
  const { FetchHttpTransport } = await import('../opencode-console/dist/lib/transport.js');
  const body = JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go' } });
  const http = new FetchHttpTransport({ fetch: async () => new Response(body, { status: 429, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(
    () => http.request({ method: 'POST', providerId: opencodeConsoleProviderId, url: 'https://opencode.ai/inference/openai/v1/chat/completions', body: '{}' }),
    (error) => {
      assert.equal(error.code, 'RATE_LIMITED');
      assert.match(error.publicMessage ?? '', /subscribe to OpenCode Go/, 'the free-limit sentence was replaced by a generic one');
      return true;
    },
  );
});

test('an insufficient-balance refusal names the billing URL', async () => {
  const { FetchHttpTransport } = await import('../opencode-console/dist/lib/transport.js');
  const body = JSON.stringify({ error: { type: 'invalid_request_error', message: 'Insufficient balance. Top up at https://opencode.ai/console/wrk_01M2TE204SPTYM3114WCY1P8HA/billing?credits=1.' } });
  const http = new FetchHttpTransport({ fetch: async () => new Response(body, { status: 402, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(
    () => http.request({ method: 'POST', providerId: opencodeConsoleProviderId, url: 'https://opencode.ai/inference/openai/v1/chat/completions', body: '{}' }),
    (error) => {
      assert.match(error.publicMessage ?? '', /Top up at/, 'the billing URL was dropped from the refusal');
      return true;
    },
  );
});

const CONFIG_V2_URL = `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.configV2Path}`;

test('a model the Console disables for this account is not offered', async () => {
  // `/api/v2/config` is the entitlement view the installed client reads: it marks the models this
  // account cannot use with `disabled: true`, and every request to one answers
  // `402 Insufficient balance`. Offering it makes the catalog look healthy while turns fail.
  const t = transport({
    [CONFIG_URL]: config('org_abc'),
    [CONFIG_V2_URL]: { data: { providers: { opencode: { models: { 'gpt-paid': { disabled: true }, 'mimo-v2.6-flash-free': { disabled: false } } } } } },
  });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  const ids = (await adapter.listModels({ credential: signedIn() })).map((model) => model.id);
  assert.ok(!ids.includes('gpt-paid'), 'a model the Console disabled was still offered');
  assert.ok(ids.includes('mimo-v2.6-flash-free'), 'an enabled model was dropped');
});

test('a Console that does not serve the entitlement view still lists its catalog', async () => {
  // v2 is best effort: a Console that 404s it, or a credential that cannot read it, must not take the
  // whole catalog down. The v2 URL is deliberately not scripted, so the read fails.
  const t = transport({ [CONFIG_URL]: config('org_abc') });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  const ids = (await adapter.listModels({ credential: signedIn() })).map((model) => model.id);
  assert.ok(ids.includes('gpt-paid'), 'the catalog disappeared when the entitlement view was unavailable');
});

test('a turn goes through the OpenCode local service when it is running', async () => {
  // The Console's free tier refuses a direct request from this host — from Node and from Bun — while
  // the app serves the same model. The service is that transport, so when it answers the direct lane
  // must not be touched at all.
  const t = transport({});
  const seen = {};
  const adapter = new OpencodeConsoleAdapter({
    transport: t,
    localService: {
      async turn({ model, text }) {
        seen.model = model;
        seen.text = text;
        return { text: 'OK', model: 'deepseek-v4.1-flash-free', finish: 'stop' };
      },
    },
  });
  const response = await adapter.chat({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] }, { credential: signedIn() });
  assert.equal(response.message.content, 'OK');
  assert.equal(response.finishReason, 'stop');
  assert.equal(seen.model, 'opencode/deepseek-v4.1-flash-free', 'the gateway strips the prefix, so the service reference is rebuilt');
  assert.equal(seen.text, 'User: hi', 'the conversation is flattened for the session API');
  assert.equal(t.requests.length, 0, 'the direct lane was used even though the service answered');
});

test('a service that is not running falls back to the direct lane', async () => {
  const unavailable = Object.assign(new Error('OpenCode is not running'), { name: 'OpencodeServiceUnavailable' });
  const t = transport({ [CONFIG_URL]: config('org_abc') });
  const adapter = new OpencodeConsoleAdapter({ transport: t, localService: { turn: async () => { throw unavailable; } } });
  // The fallback reaches the free lane, which this scripted transport does not serve, so the call
  // fails — the point is that it did not return the service's answer and did not swallow the error.
  await assert.rejects(() => adapter.chat({ model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }] }, { credential: signedIn() }));
});

test('streaming through the service yields the answer as one delta plus a finish reason', async () => {
  const adapter = new OpencodeConsoleAdapter({
    transport: transport({}),
    localService: { turn: async () => ({ text: 'OK', reasoning: 'because', finish: 'stop' }) },
  });
  const chunks = [];
  for await (const chunk of adapter.streamChat({ model: 'opencode/deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] }, { credential: signedIn() })) chunks.push(chunk);
  assert.equal(chunks.map((c) => c.delta.content ?? '').join(''), 'OK');
  assert.equal(chunks.find((c) => c.delta.reasoning)?.delta.reasoning, 'because');
  assert.equal(chunks.at(-1)?.finishReason, 'stop');
});
