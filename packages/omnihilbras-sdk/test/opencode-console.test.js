import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPENCODE_CONSOLE,
  OpencodeConsoleAdapter,
  opencodeConsoleCredentialExpired,
  opencodeConsoleProviderId,
  ProviderError,
  refreshOpencodeConsoleCredential,
} from '../dist/index.js';

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
    ['claude-sonnet-5', 'gemini-3.5-flash', 'mimo-v2.6-flash-free', 'space-bunny-free'],
  );
  assert.equal(t.requests[0].headers.Authorization, 'Bearer access-token');
  assert.equal(t.requests[0].headers['x-opencode-org-id'], 'org_abc');
});

test('a free model is served from the openai lane the config names', async () => {
  const t = transport({
    [CONFIG_URL]: config('org_abc'),
    [`${OPENAI_LANE}/chat/completions`]: {
      data: { id: 'c1', model: 'mimo-v2.6-flash-free', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] },
    },
  });
  const adapter = new OpencodeConsoleAdapter({ transport: t });
  const response = await adapter.chat(
    { model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 64 },
    { credential: signedIn() },
  );
  assert.ok(t.urls().includes(`${OPENAI_LANE}/chat/completions`), 'goes to the configured lane');
  const body = JSON.parse(t.requests.at(-1).body);
  assert.equal(body.model, 'mimo-v2.6-flash-free');
  assert.equal(body.max_tokens, 64);
  assert.equal(response.message.content, 'OK');
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
  await adapter.chat({ model: 'space-bunny-free', messages: [{ role: 'user', content: 'hi' }] }, { credential: stale });

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
    await adapter.chat({ model: 'space-bunny-free', messages: [{ role: 'user', content: 'hi' }] }, { credential: signedIn() });
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
  await adapter.chat({ model: 'space-bunny-free', messages: [{ role: 'user', content: 'hi' }] }, { credential: stale });
  await adapter.chat({ model: 'space-bunny-free', messages: [{ role: 'user', content: 'hi' }] }, { credential: signedIn('org_abc') });
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
    { model: 'space-bunny-free', messages: [{ role: 'user', content: 'hi' }] },
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
