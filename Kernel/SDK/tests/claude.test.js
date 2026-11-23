import assert from 'node:assert/strict';
import test from 'node:test';
import { CLAUDE, ClaudeAdapter, claudeProviderId, claudeCredentialExpired } from '../claude/dist/adapter/index.js';
import { scriptedTransport } from './harness/scripted-transport.js';

/**
 * The `claude` card's native Messages wire, driven through a scripted transport.
 *
 * `oauth-claude.test.js` proves the sign-in; this file proves the adapter that sign-in creates actually
 * speaks Anthropic's Messages shape — the same wire `claude-code` is contracted on, but a different
 * account and a separate SDK package. No key was used, no vendor was called and nothing was billed: the
 * transport only answers from a local script.
 */

const oauth = { type: 'oauth', value: 'access-token' };

test('listModels reads the account catalog from api.anthropic.com with Claude client headers', async () => {
  const transport = scriptedTransport({ wireFormat: 'anthropic', catalog: ['claude-sonnet-4'] });
  const adapter = new ClaudeAdapter({ transport });
  const models = await adapter.listModels({ credential: oauth });

  assert.deepEqual(models.map((model) => model.id), ['claude-sonnet-4']);
  assert.equal(models[0].providerId, claudeProviderId);
  const call = transport.seen[0];
  assert.equal(new URL(call.url).hostname, 'api.anthropic.com');
  assert.match(call.url, /\/v1\/models$/);
  assert.equal(call.headers.Authorization, 'Bearer access-token');
  assert.equal(call.headers['anthropic-version'], CLAUDE.apiVersion);
  assert.match(call.headers['anthropic-beta'], /oauth-2025-04-20/);
  assert.equal(call.headers['x-api-key'], undefined, 'an OAuth grant was sent as a metered API key');
});

test('chat sends a Messages-shaped body and reconstructs text from content blocks', async () => {
  const transport = scriptedTransport({ wireFormat: 'anthropic' });
  transport.set(['Hello', ' world']);
  const adapter = new ClaudeAdapter({ transport });
  const response = await adapter.chat({
    model: 'claude-sonnet-4',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
    ],
    tools: [{ name: 'lookup', description: 'Look it up', parameters: { type: 'object', properties: {} } }],
  }, { credential: oauth });

  assert.equal(response.message.content, 'Hello world');
  assert.equal(response.providerId, claudeProviderId);
  assert.equal(response.finishReason, 'stop');

  const call = transport.seen.at(-1);
  assert.equal(call.method, 'POST');
  assert.match(call.url, /\/v1\/messages$/);
  const body = JSON.parse(call.body);
  assert.equal(body.model, 'claude-sonnet-4');
  assert.equal(body.system, 'Be brief.', 'the system message stayed inside messages[]');
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(body.tools, [{
    name: 'lookup',
    description: 'Look it up',
    input_schema: { type: 'object', properties: {} },
  }]);
  assert.equal(call.headers.Authorization, 'Bearer access-token');
});

test('a tool_use block becomes a tool call with Anthropic stop_reason mapped to tool_calls', async () => {
  const transport = scriptedTransport({ wireFormat: 'anthropic' });
  transport.set([], { refuseWith: { status: 200, body: {
    id: 'msg-1',
    model: 'claude-sonnet-4',
    content: [{ type: 'tool_use', id: 'tu-1', name: 'lookup', input: { q: 'x' } }],
    stop_reason: 'tool_use',
  } } });
  const adapter = new ClaudeAdapter({ transport });
  const response = await adapter.chat({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }, { credential: oauth });

  assert.equal(response.message.content, null, 'an empty text block was invented beside the tool call');
  assert.deepEqual(response.message.toolCalls, [{
    id: 'tu-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' },
  }]);
  assert.equal(response.finishReason, 'tool_calls');
});

test('streamChat reassembles text deltas and keeps the message stream streaming', async () => {
  const transport = scriptedTransport({ wireFormat: 'anthropic' });
  transport.set(['Hel', 'lo']);
  const adapter = new ClaudeAdapter({ transport });
  const chunks = [];
  for await (const chunk of adapter.streamChat(
    { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] },
    { credential: oauth },
  )) chunks.push(chunk);

  const text = chunks.filter((chunk) => typeof chunk.delta?.content === 'string').map((chunk) => chunk.delta.content).join('');
  assert.equal(text, 'Hello', 'a streamed part was dropped or reordered');
  assert.ok(chunks.some((chunk) => chunk.delta?.role === 'assistant'), 'no message_start role was emitted');
  const call = transport.seen.at(-1);
  assert.equal(JSON.parse(call.body).stream, true);
  assert.equal(call.headers.Authorization, 'Bearer access-token');
});

test('an expired grant renews through oauth/token and the new access token goes on the wire', async () => {
  const refreshed = [];
  const transport = scriptedTransport({
    wireFormat: 'anthropic',
    token: [{ access_token: 'renewed-token', refresh_token: 'refresh-2', expires_in: 3600 }],
  });
  transport.set(['ok']);
  const adapter = new ClaudeAdapter({ transport, onTokensRefreshed: (credential) => refreshed.push(credential) });
  const expired = { type: 'oauth', value: 'old-token', refreshToken: 'refresh-1', expiresAt: '2000-01-01T00:00:00.000Z' };
  assert.equal(claudeCredentialExpired(expired, Date.now()), true);

  const response = await adapter.chat({ model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] }, { credential: expired });
  assert.equal(response.message.content, 'ok');

  assert.equal(transport.tokenSeen.length, 1, 'the expired grant was not renewed');
  const token = transport.tokenSeen[0];
  assert.equal(new URL(token.url).hostname, 'api.anthropic.com');
  assert.match(token.url, /\/v1\/oauth\/token$/);
  assert.equal(token.body.grant_type, CLAUDE.refreshGrantType);
  assert.equal(token.body.refresh_token, 'refresh-1');
  assert.equal(token.body.client_id, CLAUDE.clientId);
  const chatCall = transport.seen.filter((call) => /\/v1\/messages$/.test(call.url)).at(-1);
  assert.equal(chatCall.headers.Authorization, 'Bearer renewed-token', 'the chat still carried the expired token');
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].value, 'renewed-token', 'the rotated grant was not handed back to the vault');
});

test('an expired grant with no refresh token is refused before any request', async () => {
  const transport = scriptedTransport({ wireFormat: 'anthropic' });
  const adapter = new ClaudeAdapter({ transport });
  await assert.rejects(
    adapter.chat(
      { model: 'claude-sonnet-4', messages: [{ role: 'user', content: 'hi' }] },
      { credential: { type: 'oauth', value: 'old', expiresAt: '2000-01-01T00:00:00.000Z' } },
    ),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
  assert.equal(transport.seen.length, 0, 'a request was sent with a dead grant');
});
