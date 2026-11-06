import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX, CodexAdapter, codexAuthorizeUrl, codexCredentialFromTokenResponse, exchangeCodexCode, refreshCodexCredential } from '../codex/dist/adapter/index.js';

function transportFor(events = []) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      return { status: 200, headers: new Headers(), data: { access_token: 'access', refresh_token: 'refresh', expires_in: 60 } };
    },
    async *stream(request) { calls.push(request); yield* events; },
  };
}

test('the client version gating the catalog is overridable, because too low hides models silently', async () => {
  const transport = { calls: [], async request(input) { this.calls.push(input); return { status: 200, headers: new Headers(), data: { data: [{ id: 'gpt-5.4' }] } }; }, async *stream() {} };
  await new CodexAdapter({ transport, clientVersion: '0.170.0' }).listModels({ credential: { type: 'oauth', value: 'access' } });
  assert.match(transport.calls[0].url, /client_version=0\.170\.0/, 'the override reaches the wire, not just the config');
  // And it is the same version the inference request presents, so the two cannot disagree.
  const frames = [`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`, `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`];
  const streaming = { calls: [], async request(input) { this.calls.push(input); return { status: 200, headers: new Headers(), data: {} }; }, async *stream(input) { this.calls.push(input); yield* frames; } };
  const adapter = new CodexAdapter({ transport: streaming, clientVersion: '0.170.0' });
  for await (const _c of adapter.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'oauth', value: 'access' } })) { }
  assert.equal(streaming.calls.at(-1).headers['User-Agent'], 'codex_cli_rs/0.170.0');
});

test('the model catalog is discovered from the account, not invented locally', async () => {
  const catalog = transportFor();
  catalog.request = async (input) => {
    catalog.calls.push(input);
    return { status: 200, headers: new Headers(), data: { data: [
      { id: 'gpt-5.6-sol', display_name: 'GPT 5.6 Sol', context_window: 272000 },
      { id: 'gpt-5.4', name: 'GPT 5.4', context_window: 372000 },
    ] } };
  };
  const adapter = new CodexAdapter({ transport: catalog });
  const models = await adapter.listModels({ credential: { type: 'oauth', value: 'access', email: 'me@example.com' } });
  assert.equal(models.length, 2, 'a connected account is not one model');
  assert.deepEqual(models.map((m) => m.id), ['gpt-5.6-sol', 'gpt-5.4']);
  assert.equal(models[0].displayName, 'GPT 5.6 Sol');
  assert.equal(models[0].contextWindow, 272000);
  assert.equal(models[0].ownedBy, 'me@example.com');
  assert.equal(catalog.calls[0].url, CODEX.modelsUrl);
  assert.match(catalog.calls[0].url, /client_version=\d+\.\d+\.\d+/, 'the client version gates which entries come back');
  assert.equal(catalog.calls[0].headers.authorization, 'Bearer access');
  assert.equal(catalog.calls[0].headers.originator, 'codex_cli_rs');
});

test('the catalog parser accepts every shape the endpoint has used', async () => {
  const entry = { id: 'gpt-5.4' };
  for (const payload of [[entry], { data: [entry] }, { models: [entry] }, { results: [entry] }]) {
    const transport = { calls: [], async request(input) { this.calls.push(input); return { status: 200, headers: new Headers(), data: payload }; }, async *stream() {} };
    const models = await new CodexAdapter({ transport }).listModels({ credential: { type: 'oauth', value: 'access' } });
    assert.deepEqual(models.map((m) => m.id), ['gpt-5.4'], JSON.stringify(payload));
  }
});

test('an empty catalog is reported, not answered with a placeholder or an empty list', async () => {
  // The endpoint filters entries by client version and answers 200 with the missing ones silently
  // dropped, so an empty answer most often means our version is behind — worth saying, not hiding.
  for (const payload of [{ data: [] }, {}, undefined]) {
    const transport = { async request() { return { status: 200, headers: new Headers(), data: payload }; }, async *stream() {} };
    await assert.rejects(
      () => new CodexAdapter({ transport }).listModels({ credential: { type: 'oauth', value: 'access' } }),
      /returned no models/,
    );
  }
});

test('a refusal from the catalog is not reported as a catalog', async () => {
  const transport = { async request() { throw new Error('unreachable'); }, async *stream() {} };
  await assert.rejects(
    () => new CodexAdapter({ transport }).listModels({ credential: { type: 'oauth', value: 'access' } }),
    /unreachable/,
  );
});

test('a refreshed token is used for the catalog, because it is what gates it', async () => {
  const transport = {
    calls: [],
    async request(input) {
      this.calls.push(input);
      // The token endpoint answers with tokens; the catalog endpoint answers with models. A stub
      // that answers both with the same body would pass a broken adapter, so they are kept apart.
      return input.url === CODEX.tokenUrl
        ? { status: 200, headers: new Headers(), data: { access_token: 'renewed', refresh_token: 'next-refresh', expires_in: 3600 } }
        : { status: 200, headers: new Headers(), data: { data: [{ id: 'gpt-5.4' }] } };
    },
    async *stream() {},
  };
  const adapter = new CodexAdapter({ transport, now: () => 10_000 });
  const models = await adapter.listModels({ credential: { type: 'oauth', value: 'expired', refreshToken: 'refresh', expiresAt: new Date(0).toISOString() } });
  assert.deepEqual(models.map((m) => m.id), ['gpt-5.4']);
  const catalogCall = transport.calls.at(-1);
  assert.equal(catalogCall.url, CODEX.modelsUrl);
  assert.equal(catalogCall.headers.authorization, 'Bearer renewed', 'the renewed token, not the expired one');
});

test('Codex authorization URL uses configured client and exact callback with S256 scopes', () => {
  const url = new URL(codexAuthorizeUrl({ clientId: 'approved-client', redirectUri: 'http://localhost:8787/custom/callback', state: 'state', codeChallenge: 'challenge' }));
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.searchParams.get('client_id'), 'approved-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8787/custom/callback');
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});

test("a refusal is reported in the provider's own words, not a generic sentence", async () => {
  // OpenAI answers a bad code with a *nested* object, not the flat `error`/`error_description`
  // strings the OAuth spec suggests. Typing `error` as a string made every refusal read as the
  // same sentence, which is why a refused code was indistinguishable from a dropped session.
  const refusing = {
    calls: [],
    async request(input) {
      this.calls.push(input);
      return { status: 401, headers: new Headers(), data: { error: { message: 'Could not validate your token. Please try signing in again.', type: 'invalid_request_error', code: 'token_expired' } } };
    },
    async *stream() {},
  };
  await assert.rejects(
    () => exchangeCodexCode({ code: 'used-code', codeVerifier: 'verifier', clientId: 'approved-client', redirectUri: 'http://localhost:1455/auth/callback', transport: refusing }),
    /Could not validate your token.*token_expired/s,
  );

  // And the flat shape a spec-following server would send is still understood.
  const flat = {
    async request() { return { status: 400, headers: new Headers(), data: { error: 'invalid_grant', error_description: 'The authorization code is expired.' } }; },
    async *stream() {},
  };
  await assert.rejects(
    () => exchangeCodexCode({ code: 'used-code', codeVerifier: 'verifier', clientId: 'approved-client', redirectUri: 'http://localhost:1455/auth/callback', transport: flat }),
    /The authorization code is expired/,
  );
});

test('the authorize request identifies itself the way the Codex CLI does', () => {
  const url = new URL(codexAuthorizeUrl({ clientId: 'approved-client', redirectUri: 'http://localhost:1455/auth/callback', state: 'state', codeChallenge: 'challenge' }));
  assert.equal(url.searchParams.get('originator'), 'codex_cli_rs');
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
});

test('the public Codex client and its registered redirect ship as defaults', () => {
  assert.equal(CODEX.publicClientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(CODEX.publicRedirectUri, 'http://localhost:1455/auth/callback');
  assert.equal(CODEX.publicRedirectPort, 1455);
  assert.equal(CODEX.publicRedirectPath, '/auth/callback');
});

test('a refresh carries the scope, so the renewed token keeps the same grant', async () => {
  const transport = transportFor();
  const renewed = await refreshCodexCredential({ credential: { type: 'oauth', value: 'access', refreshToken: 'refresh' }, clientId: 'approved-client', transport });
  const body = new URLSearchParams(transport.calls[0].body);
  assert.equal(transport.calls[0].url, CODEX.tokenUrl);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('client_id'), 'approved-client');
  assert.equal(body.get('scope'), CODEX.scopes.join(' '));
  assert.equal(renewed.value, 'access');
});

test('the adapter builds without a configured client, using the public one', async () => {
  const frames = [`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`, `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`];
  const transport = transportFor(frames);
  const adapter = new CodexAdapter({ transport });
  for await (const _chunk of adapter.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'oauth', value: 'access' } })) { }
  assert.equal(transport.calls[0].headers['User-Agent'], `${CODEX.originator}/${CODEX.cliVersion}`);
});

test('authorization-code token exchange is form encoded and persists refresh token', async () => {
  const transport = transportFor();
  const credential = await exchangeCodexCode({ code: 'one-time-code', codeVerifier: 'verifier', clientId: 'approved-client', redirectUri: 'http://localhost:8787/cb', transport });
  assert.equal(transport.calls[0].url, 'https://auth.openai.com/oauth/token');
  assert.equal(transport.calls[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(transport.calls[0].body).get('code'), 'one-time-code');
  assert.equal(credential.refreshToken, 'refresh');
});

test('Codex requests force streamed, non-stored Responses with client headers and account metadata', async () => {
  const frames = [
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r1', model: 'codex-mini', status: 'completed', usage: { input_tokens: 2, output_tokens: 3 } } })}\n\n`,
  ];
  const transport = transportFor(frames);
  const adapter = new CodexAdapter({ clientId: 'approved-client', transport });
  const chunks = [];
  for await (const chunk of adapter.streamChat({ model: 'codex-mini', messages: [{ role: 'user', content: 'hello' }] }, { requestId: 'request-1', credential: { type: 'oauth', value: 'access-token', accountId: 'acct-1' } })) chunks.push(chunk);
  const request = transport.calls[0];
  const body = JSON.parse(request.body);
  assert.equal(request.url, CODEX.apiUrl);
  assert.equal(request.headers.authorization, 'Bearer access-token');
  assert.equal(request.headers.originator, 'codex_cli_rs');
  assert.equal(request.headers.session_id, 'request-1');
  assert.equal(request.headers['ChatGPT-Account-ID'], 'acct-1');
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(chunks[0].delta.content, 'hello');
  assert.equal(chunks.at(-1).usage.totalTokens, undefined);
  assert.equal(chunks.at(-1).usage.inputTokens, 2);
});

test('Codex maps supported roles and text content and rejects unsupported content and tools', async () => {
  const frames = [`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`, `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`];
  const transport = transportFor(frames);
  const adapter = new CodexAdapter({ clientId: 'approved-client', transport });
  for await (const _chunk of adapter.streamChat({ model: 'm', messages: [{ role: 'system', content: 'policy' }, { role: 'tool', content: 'result' }] }, { credential: { type: 'oauth', value: 'access' } })) { }
  assert.deepEqual(JSON.parse(transport.calls[0].body).input.map((entry) => entry.role), ['developer', 'tool']);
  const image = new CodexAdapter({ clientId: 'approved-client', transport: transportFor(frames) });
  await assert.rejects(async () => { for await (const _chunk of image.streamChat({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', imageUrl: { url: 'https://example.invalid/image.png' } }] }] }, { credential: { type: 'oauth', value: 'access' } })) { } }, /text content only/);
  await assert.rejects(async () => { for await (const _chunk of adapter.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'lookup', parameters: {} }] }, { credential: { type: 'oauth', value: 'access' } })) { } }, /tool definitions/);
  const empty = new CodexAdapter({ clientId: 'approved-client', transport: transportFor([]) });
  await assert.rejects(async () => { for await (const _chunk of empty.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'oauth', value: 'access' } })) { } }, /without response.completed/);
});

test('expired Codex credentials refresh over the injected transport and persist rotating refresh tokens', async () => {
  const transport = transportFor([`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`, `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`]);
  let persisted;
  const adapter = new CodexAdapter({ clientId: 'approved-client', transport, now: () => 10_000, onTokensRefreshed: (credential) => { persisted = credential; } });
  for await (const _chunk of adapter.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'oauth', value: 'old-access', refreshToken: 'old-refresh', expiresAt: new Date(0).toISOString() } })) { }
  assert.equal(transport.calls[0].url, CODEX.tokenUrl);
  assert.equal(new URLSearchParams(transport.calls[0].body).get('grant_type'), 'refresh_token');
  assert.equal(persisted.value, 'access');
  assert.equal(persisted.refreshToken, 'refresh');
  assert.equal(transport.calls[1].headers.authorization, 'Bearer access');
});

test('Codex rejects failed responses and preserves incomplete status as length', async () => {
  const credential = { type: 'oauth', value: 'access' };
  const failed = new CodexAdapter({ clientId: 'approved-client', transport: transportFor([`data: ${JSON.stringify({ type: 'response.failed', error: { message: 'failed' } })}\n\n`]) });
  await assert.rejects(async () => { for await (const _chunk of failed.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential })) { } }, /failed/);
  const incomplete = new CodexAdapter({ clientId: 'approved-client', transport: transportFor([`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' })}\n\n`, `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })}\n\n`]) });
  const chunks = [];
  for await (const chunk of incomplete.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential })) chunks.push(chunk);
  assert.equal(chunks.at(-1).finishReason, 'length');
});

test('token response account metadata is retained without exposing ID-token contents', () => {
  const jwt = `x.${Buffer.from(JSON.stringify({ email: 'user@example.invalid', 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } })).toString('base64url')}.x`;
  const credential = codexCredentialFromTokenResponse({ access_token: 'access-token', id_token: jwt });
  assert.equal(credential.accountId, 'account-1');
  assert.equal(credential.email, 'user@example.invalid');
  assert.equal(JSON.stringify(credential).includes(jwt), false);
});

test('concurrent Codex refreshes coalesce and retain account metadata without a new ID token', async () => {
  const calls = [];
  let release;
  const transport = {
    calls,
    async request(request) { calls.push(request); await new Promise((resolve) => { release = resolve; }); return { status: 200, headers: new Headers(), data: { access_token: 'new-access', refresh_token: 'new-refresh' } }; },
    async *stream(request) { calls.push(request); yield `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`; yield `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`; },
  };
  let persisted;
  const adapter = new CodexAdapter({ clientId: 'approved-client', transport, now: () => 10_000, onTokensRefreshed: (value) => { persisted = value; } });
  const request = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
  const context = { credential: { type: 'oauth', value: 'old-access', refreshToken: 'old-refresh', expiresAt: new Date(0).toISOString(), accountId: 'account-1', email: 'user@example.invalid' } };
  const first = adapter.streamChat(request, context)[Symbol.asyncIterator]().next();
  const second = adapter.streamChat(request, context)[Symbol.asyncIterator]().next();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(calls.filter((call) => call.url === CODEX.tokenUrl).length, 1);
  assert.equal(persisted.accountId, 'account-1');
  assert.equal(persisted.email, 'user@example.invalid');
});


test('Codex requires OAuth credentials before sending a request', async () => {
  const transport = transportFor();
  const adapter = new CodexAdapter({ clientId: 'approved-client', transport });
  await assert.rejects(() => adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }), /OAuth connection/);
  assert.equal(transport.calls.length, 0);
});

test('Codex ships a public client, no secret, and keeps every default overridable', () => {
  assert.equal(CODEX.originator, 'codex_cli_rs');
  // The reason this is safe to commit: a public OAuth client identifier authenticates nobody.
  // It is the same value the open-source Codex CLI ships, and a client secret never appears here.
  for (const value of Object.values(CODEX)) {
    assert.doesNotMatch(String(value), /secret|password|private_key/i);
  }
  // The shipped client and redirect are defaults, not a fixed identity: an operator's own
  // registered pair must still be able to replace them, which is what the caller's arguments are for.
  const overridden = new URL(codexAuthorizeUrl({ clientId: 'operator-client', redirectUri: 'http://127.0.0.1:8787/v1/oauth/codex/callback', state: 's', codeChallenge: 'c' }));
  assert.equal(overridden.searchParams.get('client_id'), 'operator-client');
  assert.equal(overridden.searchParams.get('redirect_uri'), 'http://127.0.0.1:8787/v1/oauth/codex/callback');
});

// ——— quota: GET /backend-api/wham/usage ———

// The shape the live usage endpoint returns, dumped raw for a signed-in account (2026-11): windows
// stated as percentages beside their own duration in seconds, reset times as Unix seconds, a plan
// type, and further meters (review, spark, reset credits) the card deliberately does not render.
const LIVE_USAGE = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 42.6, reset_at: 1794386400, limit_window_seconds: 18000, limit_reached: false },
    secondary_window: { used_percent: '8', reset_at: '2026-11-09T00:00:00Z', limit_window_seconds: 604800 },
  },
  code_review_rate_limit: { primary_window: { used_percent: 90 } },
  rate_limit_reset_credits: { available_count: 2 },
};

test('quota reads /backend-api/wham/usage and names each window from its own duration', async () => {
  const transport = transportFor();
  transport.request = async function (input) { this.calls.push(input); return { status: 200, headers: new Headers(), data: LIVE_USAGE }; };
  const adapter = new CodexAdapter({ transport });

  const quota = await adapter.quota({ credential: { type: 'oauth', value: 'access', accountId: 'acct_1' } });

  assert.equal(transport.calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(transport.calls[0].headers.authorization, 'Bearer access');
  assert.equal(transport.calls[0].headers['ChatGPT-Account-ID'], 'acct_1', 'a multi-seat plan reads the account\u2019s windows, not the key\u2019s');
  // A percentage against 100 — the panel's "N of M left" reads as the percentage the provider stated.
  // The names come from each window's stated duration: 18000s is the 5-hour session, 604800s the week.
  assert.deepEqual(quota.resources['5-hour window'], { used: 43, limit: 100, remaining: 57, resetsAt: '2026-11-11T08:40:00.000Z' });
  assert.deepEqual(quota.resources['Weekly window'], { used: 8, limit: 100, remaining: 92, resetsAt: '2026-11-09T00:00:00.000Z' });
  assert.equal(quota.plan, 'pro');
  // The review window and the reset credits are on the wire and deliberately not rendered.
  assert.deepEqual(Object.keys(quota.resources), ['5-hour window', 'Weekly window']);
});

test('the free plan\u2019s primary window is monthly, and the card says so', async () => {
  // Dumped raw for a signed-in free account: one window, 2592000 seconds — thirty days — and no
  // secondary. The reference client labeled the primary window "session" and the secondary "weekly",
  // which told this user their monthly cap was a 5-hour one.
  const free = transportFor();
  free.request = async function (input) { this.calls.push(input); return { status: 200, headers: new Headers(), data: { plan_type: 'free', rate_limit: { primary_window: { used_percent: 100, reset_at: 1795124679, limit_window_seconds: 2592000 }, secondary_window: null } } }; };

  const quota = await new CodexAdapter({ transport: free }).quota({ credential: { type: 'oauth', value: 'a' } });

  assert.deepEqual(Object.keys(quota.resources), ['Monthly window']);
  // Unix seconds, not milliseconds: 1795124679 read as ms lands in 1970.
  assert.equal(quota.resources['Monthly window'].resetsAt, new Date(1795124679 * 1000).toISOString());
  assert.deepEqual(quota.resources['Monthly window'], { used: 100, limit: 100, remaining: 0, resetsAt: new Date(1795124679 * 1000).toISOString() });
});

test('a quota ratio is clamped and an absent window is absent from the card', async () => {
  const clamped = transportFor();
  clamped.request = async function (input) { this.calls.push(input); return { status: 200, headers: new Headers(), data: { rate_limit: { primary_window: { used_percent: 140, limit_window_seconds: 18000 }, secondary_window: { used_percent: -5, limit_window_seconds: 604800 } } } }; };
  const quota = await new CodexAdapter({ transport: clamped }).quota({ credential: { type: 'oauth', value: 'a' } });
  assert.deepEqual(quota.resources['5-hour window'], { used: 100, limit: 100, remaining: 0 });
  assert.deepEqual(quota.resources['Weekly window'], { used: 0, limit: 100, remaining: 100 });

  const bare = transportFor();
  bare.request = async function (input) { this.calls.push(input); return { status: 200, headers: new Headers(), data: {} }; };
  const empty = await new CodexAdapter({ transport: bare }).quota({ credential: { type: 'oauth', value: 'a' } });
  assert.deepEqual(empty.resources, {}, 'no windows reported means no rows, never zeros');
  assert.equal(empty.plan, 'Codex', 'an unnamed plan falls back to the provider\u2019s name, not to "unknown"');
});

test('a health check is a real free read, and a failure keeps the reason', async () => {
  const healthy = transportFor();
  healthy.request = async function (input) { this.calls.push(input); return { status: 200, headers: new Headers(), data: { data: [{ id: 'gpt-5.4' }] } }; };
  const ok = await new CodexAdapter({ transport: healthy }).healthCheck({ credential: { type: 'oauth', value: 'access' } });
  assert.equal(ok.status, 'healthy');
  assert.equal(ok.verified, 'credential', 'a credential verdict from a request that was actually made');
  assert.match(healthy.calls[0].url, /\/models/, 'the check is the free catalog read, not a guess');

  const broken = transportFor();
  broken.request = async function (input) { this.calls.push(input); throw new (await import('../codex/dist/lib/errors.js')).ProviderError('AUTHENTICATION_FAILED', 'the session expired', { providerId: 'codex' }); };
  const bad = await new CodexAdapter({ transport: broken }).healthCheck({ credential: { type: 'oauth', value: 'access' } });
  assert.equal(bad.status, 'unavailable');
  assert.equal(bad.verified, 'credential');
  assert.match(bad.message, /session expired/, 'the reason a user can act on survives the check');
});
