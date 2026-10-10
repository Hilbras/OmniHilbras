import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_CODE,
  ClaudeCodeAdapter,
  ProviderError,
  claudeCodeAuthorizeUrl,
  claudeCodeCredentialExpired,
  claudeCodeProviderId,
  exchangeClaudeCodeCode,
  splitCallbackFragment,
} from '../dist/index.js';

/**
 * The Claude Code adapter.
 *
 * Claude Code is Anthropic's **subscription** reached by OAuth, not an Anthropic API key, so the tests
 * are mostly about the parts where the two are easy to confuse:
 *
 * - an OAuth grant goes in `Authorization: Bearer`; an `x-api-key` credential goes in `x-api-key`, and
 *   the branch that picks between them is pinned because getting it wrong is a 401 whose body names
 *   the header rather than a type error;
 * - the authorize URL carries a PKCE challenge and a `code=true` that asks Claude for a readable
 *   redirect, not a CLI handoff;
 * - `code#state` is one value from Anthropic's callback, and splitting it is required for the exchange
 *   while a *crossed* state must be refused rather than spent;
 * - an expiry the adapter cannot read resolves to "ask the provider", never to "expired".
 */

function createTransport(overrides = {}) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      if (overrides.request) return overrides.request(request);
      return { status: 200, headers: new Headers(), data: { id: 'c1', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' } };
    },
    async *stream(request) {
      calls.push(request);
      yield* (overrides.stream ? overrides.stream(request) : [
        'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 's1', model: 'claude-sonnet-4-5' } }) + '\n\n',
        'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }) + '\n\n',
        'event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + '\n\n',
      ]);
    },
  };
}

const OAUTH = { type: 'oauth', value: 'access-token', oauthClientId: CLAUDE_CODE.clientId };

test('an OAuth grant goes in Authorization: Bearer, not x-api-key', async () => {
  const transport = createTransport();
  const adapter = new ClaudeCodeAdapter({ transport });
  await adapter.chat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH });

  const headers = transport.calls[0].headers;
  assert.equal(headers.Authorization, 'Bearer access-token');
  assert.equal(headers['x-api-key'], undefined, 'an OAuth grant must not also be sent as an API key');
  const body = JSON.parse(transport.calls[0].body);
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].content, 'hi');
});

test('an API-key credential goes in x-api-key, and the two modes are not confused', async () => {
  const transport = createTransport();
  const adapter = new ClaudeCodeAdapter({ transport });
  await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'api-key', value: 'sk-key' } });

  const headers = transport.calls[0].headers;
  assert.equal(headers['x-api-key'], 'sk-key');
  assert.equal(headers.Authorization, undefined);
});

test('no credential at all is refused before a request is sent', async () => {
  const transport = createTransport();
  const adapter = new ClaudeCodeAdapter({ transport });
  await assert.rejects(
    () => adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
  assert.equal(transport.calls.length, 0, 'a request with nothing to authenticate it was sent anyway');
});

test('the CLI client headers and the api version are sent, because /v1/messages is served to that client', async () => {
  const transport = createTransport();
  const adapter = new ClaudeCodeAdapter({ transport });
  await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH });

  const call = transport.calls[0];
  assert.equal(call.url, `${CLAUDE_CODE.server}${CLAUDE_CODE.messagesPath}`);
  assert.equal(call.headers['anthropic-version'], CLAUDE_CODE.apiVersion);
  assert.equal(call.headers['x-app'], 'cli');
  assert.match(call.headers['user-agent'], /^claude-cli\//);
});

test('Anthropic stop reasons are translated, because max_tokens is length here and tool_use is tool_calls', async () => {
  // Passing Anthropic's own strings through would put values in the field that a caller cannot compare
  // against anything, which is how a client's "did it finish?" check quietly stops working.
  for (const [reason, expected] of [['max_tokens', 'length'], ['tool_use', 'tool_calls'], ['end_turn', 'stop'], ['stop_sequence', 'stop']]) {
    const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { id: 'c1', model: 'm', content: [{ type: 'text', text: 'x' }], stop_reason: reason } }) });
    const adapter = new ClaudeCodeAdapter({ transport });
    const response = await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH });
    assert.equal(response.finishReason, expected, `${reason} should normalize to ${expected}`);
  }
});

test('a text block and a tool_use block together become content and a tool call', async () => {
  const transport = createTransport({
    request: () => ({
      status: 200,
      headers: new Headers(),
      data: {
        id: 'c1',
        model: 'm',
        stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 'tu1', name: 'read', input: { path: 'a' } }],
      },
    }),
  });
  const adapter = new ClaudeCodeAdapter({ transport });
  const response = await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH });

  assert.equal(response.message.content, 'looking');
  assert.equal(response.message.toolCalls.length, 1);
  assert.equal(response.message.toolCalls[0].function.name, 'read');
  assert.deepEqual(JSON.parse(response.message.toolCalls[0].function.arguments), { path: 'a' });
  assert.equal(response.finishReason, 'tool_calls');
});

test('a 200 that carries an error object is a refusal, not an empty chat', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { error: { message: 'overloaded_error', type: 'overloaded_error' } } }) });
  const adapter = new ClaudeCodeAdapter({ transport });
  await assert.rejects(
    () => adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH }),
    /overloaded_error/,
  );
});

test('a response with no content array is INVALID_RESPONSE, not an empty chat', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { id: 'c1', model: 'm' } }) });
  const adapter = new ClaudeCodeAdapter({ transport });
  await assert.rejects(() => adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH }), /no content/);
});
test('streaming reads Anthropic SSE frames and requires a stop reason before calling it complete', async () => {
  const transport = createTransport();
  const adapter = new ClaudeCodeAdapter({ transport });
  const chunks = [];
  for await (const chunk of adapter.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH })) chunks.push(chunk);

  assert.equal(chunks.map((chunk) => chunk.delta.content ?? '').join(''), 'hi');
  assert.equal(JSON.parse(transport.calls[0].body).stream, true);
});

test('a stream that ends without a stop reason is refused rather than returned as complete', async () => {
  const transport = createTransport({ stream: () => [
    'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 's1', model: 'm' } }) + '\n\n',
    'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }) + '\n\n',
  ] });
  const adapter = new ClaudeCodeAdapter({ transport });
  await assert.rejects(async () => {
    for await (const _ of adapter.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH })) { /* drain */ }
  }, /ended before completion/);
});

test('an SSE error event names Anthropic\'s own message rather than reading the wrong field', async () => {
  const transport = createTransport({ stream: () => [
    'event: error\ndata: ' + JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) + '\n\n',
  ] });
  const adapter = new ClaudeCodeAdapter({ transport });
  await assert.rejects(async () => {
    for await (const _ of adapter.streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: OAUTH })) { /* drain */ }
  }, /Overloaded/);
});

test('the catalog is read from /v1/models, and an unreadable one is refused', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }, { display_name: 'no id' }] } }) });
  const adapter = new ClaudeCodeAdapter({ transport });
  const models = await adapter.listModels({ credential: OAUTH });

  assert.equal(transport.calls[0].url, `${CLAUDE_CODE.server}/v1/models`);
  assert.deepEqual(models.map((model) => model.id), ['claude-sonnet-4-5']);
  assert.equal(models[0].providerId, claudeCodeProviderId);
  assert.equal(models[0].displayName, 'Claude Sonnet 4.5');

  const broken = new ClaudeCodeAdapter({ transport: createTransport({ request: () => ({ status: 200, headers: new Headers(), data: {} }) }) });
  await assert.rejects(() => broken.listModels({ credential: OAUTH }), /missing data/);
});
// ── the OAuth flow ──────────────────────────────────────────────────────────

test('the authorize URL carries a PKCE challenge and asks Claude for a readable redirect', () => {
  const url = new URL(claudeCodeAuthorizeUrl({ redirectUri: 'http://127.0.0.1:8787/v1/oauth/claude-code/callback/s1', state: 'st', codeChallenge: 'ch' }));

  assert.equal(url.origin + url.pathname, `${CLAUDE_CODE.authorizeOrigin}${CLAUDE_CODE.authorizePath}`);
  assert.equal(url.searchParams.get('client_id'), CLAUDE_CODE.clientId);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'ch');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  // Without `code=true` Claude runs its CLI handoff and the callback carries no code to read.
  assert.equal(url.searchParams.get('code'), 'true');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8787/v1/oauth/claude-code/callback/s1');
});

test('code#state is split, and a crossed state is refused rather than exchanged', () => {
  assert.deepEqual(splitCallbackFragment('the-code#the-state'), { code: 'the-code', state: 'the-state' });
  // No `#`: a bare code is still usable, and the state we sent is carried through.
  assert.deepEqual(splitCallbackFragment('the-code', 'sent-state'), { code: 'the-code', state: 'sent-state' });
  assert.throws(() => splitCallbackFragment('the-code#other-state', 'sent-state'), /different sign-in/);
});

test('the exchange sends the verifier and reads error_description out of a 400', async () => {
  const transport = createTransport({ request: () => ({ status: 400, headers: new Headers(), data: { error: 'invalid_grant', error_description: 'code_verifier does not match' } }) });
  await assert.rejects(
    () => exchangeClaudeCodeCode({ code: 'c#st', state: 'st', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:8787/v1/oauth/claude-code/callback/s1', transport }),
    (error) => error instanceof ProviderError && /code_verifier does not match/.test(error.message),
  );

  const body = JSON.parse(transport.calls[0].body);
  assert.equal(body.grant_type, 'authorization_code');
  assert.equal(body.code, 'c', 'the code is the half before the #, or the exchange fails on a correct code');
  assert.equal(body.state, 'st');
  assert.equal(body.code_verifier, 'v');
  assert.equal(body.client_id, CLAUDE_CODE.clientId);
  assert.equal(body.redirect_uri, 'http://127.0.0.1:8787/v1/oauth/claude-code/callback/s1');
});

test('a successful exchange returns an OAuth credential with the refresh token and an expiry', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 } }) });
  const credential = await exchangeClaudeCodeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:8787/v1/oauth/claude-code/callback/s1', transport });

  assert.equal(credential.type, 'oauth');
  assert.equal(credential.value, 'acc');
  assert.equal(credential.refreshToken, 'ref');
  assert.equal(credential.oauthClientId, CLAUDE_CODE.clientId);
  assert.ok(Date.parse(credential.expiresAt) > Date.now(), 'a token with no expiry is refreshed on every request');
});

test('a token with no access_token is refused with the description, not half-returned', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { error: 'invalid_client' } }) });
  await assert.rejects(
    () => exchangeClaudeCodeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:8787/v1/oauth/claude-code/callback/s1', transport }),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
});
test('an exchange whose body is empty or unreadable is refused as a sign-in failure, not a TypeError', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: undefined }) });
  await assert.rejects(
    () => exchangeClaudeCodeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:8787/v1/oauth/claude-code/callback/s1', transport }),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
});

test('an expiry the adapter cannot read is "ask the provider", never "expired"', () => {
  // The value of the pre-check is entirely in what it refuses to claim: answering `false` for a
  // credential it cannot read would turn uncertainty into a confident "still valid".
  assert.equal(claudeCodeCredentialExpired(undefined, Date.now()), false);
  assert.equal(claudeCodeCredentialExpired({ type: 'api-key', value: 'k' }, Date.now()), false, 'an api key is not this adapter\'s to expire');
  assert.equal(claudeCodeCredentialExpired({ type: 'oauth', value: 'x' }, Date.now()), undefined, 'no expiry is not an expiry');
  assert.equal(claudeCodeCredentialExpired({ type: 'oauth', value: 'x', expiresAt: 'not-a-date' }, Date.now()), undefined);
  assert.equal(claudeCodeCredentialExpired({ type: 'oauth', value: 'x', expiresAt: new Date(Date.now() - 1000).toISOString() }, Date.now()), true);
  assert.equal(claudeCodeCredentialExpired({ type: 'oauth', value: 'x', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, Date.now()), false);
});

test('an expired OAuth credential is renewed with the refresh token before a request', async () => {
  const refreshed = [];
  const transport = createTransport({ request: (request) => {
    if (request.url.endsWith(CLAUDE_CODE.tokenPath)) return { status: 200, headers: new Headers(), data: { access_token: 'new', refresh_token: 'ref2', expires_in: 3600 } };
    return { status: 200, headers: new Headers(), data: { id: 'c1', model: 'm', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' } };
  } });
  const adapter = new ClaudeCodeAdapter({ transport, onTokensRefreshed: (credential) => refreshed.push(credential) });
  const expired = { type: 'oauth', value: 'old', refreshToken: 'ref1', expiresAt: new Date(Date.now() - 1000).toISOString() };
  await adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: expired });

  assert.equal(transport.calls[0].url, `${CLAUDE_CODE.server}${CLAUDE_CODE.tokenPath}`);
  assert.equal(JSON.parse(transport.calls[0].body).grant_type, 'refresh_token');
  assert.equal(transport.calls[1].headers.Authorization, 'Bearer new');
  assert.equal(refreshed.length, 1, 'the gateway needs the renewed credential written back to the connection');
  assert.equal(refreshed[0].value, 'new');
});

test('an expired credential with no refresh token asks the user to sign in again rather than failing obscurely', async () => {
  const transport = createTransport();
  const adapter = new ClaudeCodeAdapter({ transport });
  await assert.rejects(
    () => adapter.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'oauth', value: 'old', expiresAt: new Date(Date.now() - 1000).toISOString() } }),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /expired/.test(error.message),
  );
  assert.equal(transport.calls.length, 0);
});

test('healthCheck reads the catalog, which is free, and reports the credential as verified', async () => {
  const transport = createTransport({ request: () => ({ status: 200, headers: new Headers(), data: { data: [{ id: 'claude-sonnet-4-5' }] } }) });
  const adapter = new ClaudeCodeAdapter({ transport });
  const health = await adapter.healthCheck({ credential: OAUTH });

  assert.equal(health.status, 'healthy');
  assert.equal(health.verified, 'credential');
  assert.equal(transport.calls[0].url, `${CLAUDE_CODE.server}/v1/models`);
});

test('a refused health check is unavailable and carries the provider\'s own message', async () => {
  const transport = createTransport({ request: () => { throw new ProviderError('AUTHENTICATION_FAILED', 'The credential was refused.', { providerId: claudeCodeProviderId }); } });
  const adapter = new ClaudeCodeAdapter({ transport });
  const health = await adapter.healthCheck({ credential: OAUTH });

  assert.equal(health.status, 'unavailable');
  assert.match(health.message, /refused/);
});

test('a streamed tool call reaches the caller with its id, name and joined arguments', async () => {
  // Claude Code streamed tool calls were never emitted: the stop event carries no content_block, so the
  // branch that read it was never true. The id and name arrive on content_block_start, and the arguments
  // arrive as input_json_delta fragments that must join into the JSON the model wrote.
  const transport = createTransport({
    stream: async function* () {
      yield 'event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 's1', model: 'claude-sonnet-4-5' } }) + '\n\n';
      yield 'event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash' } }) + '\n\n';
      yield 'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":' } }) + '\n\n';
      yield 'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"ls"}' } }) + '\n\n';
      yield 'event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n';
      yield 'event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) + '\n\n';
    },
  });
  const adapter = new ClaudeCodeAdapter({ transport });
  const pieces = [];
  for await (const chunk of adapter.streamChat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'ls' }] }, { credential: OAUTH })) {
    pieces.push(...(chunk.delta.toolCalls ?? []));
  }
  assert.equal(pieces[0].id, 'toolu_1', 'the id arrives with the first fragment');
  assert.equal(pieces[0].function.name, 'Bash', 'the name arrives with the first fragment');
  assert.equal(pieces.map((p) => p.function?.arguments ?? '').join(''), '{"command":"ls"}', 'the fragments join into the whole JSON');
});
