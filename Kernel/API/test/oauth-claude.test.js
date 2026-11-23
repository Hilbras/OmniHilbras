import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';
import { scriptedTransport } from '../../SDK/tests/harness/scripted-transport.js';

/**
 * The `claude` authorization-code + PKCE S256 flow, driven end to end through a scripted token
 * endpoint. No browser, vendor, key or billable request is involved: the transport stands in for
 * `api.anthropic.com/v1/oauth/token`, and the assertions are about what the gateway sent.
 *
 * The two refusals are the point. A redirect that differs from the one minted at start, and a
 * verifier that differs from the session's, are both refused **before** a code is spent — the token
 * endpoint must see no request at all for either.
 */

async function harness(options = {}) {
  const transport = scriptedTransport({ wireFormat: 'openai', catalog: ['contract-model'], ...options });
  const apiKeys = new InMemoryApiKeyStore();
  const { key } = await apiKeys.create('test');
  const service = new GatewayService(
    new ProviderRegistry(),
    new InMemorySecretStore({}),
    new InMemoryConnectionStore(),
    apiKeys,
    { transport },
  );
  const server = createGatewayServer(service, {
    corsOrigin: 'http://localhost:5173',
    publicBaseUrl: 'http://127.0.0.1:20138',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    key, service, transport, server,
  };
}

async function close(state) {
  await new Promise((resolve) => state.server.close(resolve));
}

async function start(base, key) {
  const response = await fetch(`${base}/v1/oauth/claude/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function exchange(base, key, body) {
  const response = await fetch(`${base}/v1/oauth/claude/exchange`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('start mints a PKCE S256 challenge and the session stays a separate connection', async () => {
  const state = await harness();
  try {
    const started = await start(state.base, state.key);
    assert.match(started.sessionId, /^[A-Za-z0-9_-]{16,128}$/);
    assert.match(started.redirectUri, /^http:\/\/127\.0\.0\.1:20138\/v1\/oauth\/claude\/callback\//);
    const authorize = new URL(started.verificationUrl);
    assert.equal(authorize.hostname, 'claude.ai');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.ok((authorize.searchParams.get('code_challenge') ?? '').length >= 43, 'the challenge is not S256-shaped');
    assert.equal(authorize.searchParams.get('redirect_uri'), started.redirectUri);
    assert.ok(authorize.searchParams.get('state'));
    assert.doesNotMatch(started.verificationUrl, /code_verifier/, 'the verifier leaked into the browser URL');

    const pending = await (await fetch(`${state.base}/v1/oauth/claude/session/${started.sessionId}`, { headers: { authorization: `Bearer ${state.key}` } })).json();
    assert.equal(pending.status, 'pending');
    assert.doesNotMatch(JSON.stringify(pending), /code_verifier/, 'the verifier leaked into poll status');
  } finally {
    await close(state);
  }
});

test('a redirect that differs from the minted one is refused before any token request', async () => {
  const state = await harness();
  try {
    const started = await start(state.base, state.key);
    const outcome = await exchange(state.base, state.key, {
      sessionId: started.sessionId,
      code: 'granted-code',
      redirectUri: `${started.redirectUri}?extra=1`,
    });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error, /redirect does not belong to this sign-in/);
    assert.equal(state.transport.tokenSeen.length, 0, 'the code was spent on a mismatched redirect');
  } finally {
    await close(state);
  }
});

test('a wrong PKCE verifier is refused before any token request', async () => {
  const state = await harness();
  try {
    const started = await start(state.base, state.key);
    const outcome = await exchange(state.base, state.key, {
      sessionId: started.sessionId,
      code: 'granted-code',
      redirectUri: started.redirectUri,
      codeVerifier: 'not-the-session-verifier',
    });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error, /verifier does not match/);
    assert.equal(state.transport.tokenSeen.length, 0, 'the code was spent with a wrong verifier');
  } finally {
    await close(state);
  }
});

test('start → authorize → exchange saves its own connection and sends the session verifier', async () => {
  const state = await harness();
  try {
    const started = await start(state.base, state.key);
    const authorize = new URL(started.verificationUrl);
    const outcome = await exchange(state.base, state.key, {
      sessionId: started.sessionId,
      code: 'granted-code',
      redirectUri: started.redirectUri,
    });
    assert.equal(outcome.status, 'connected', outcome.error);
    assert.equal(state.transport.tokenSeen.length, 1);

    const sent = state.transport.tokenSeen[0];
    assert.equal(new URL(sent.url).hostname, 'api.anthropic.com');
    assert.equal(sent.body.grant_type, 'authorization_code');
    assert.equal(sent.body.redirect_uri, started.redirectUri);
    assert.equal(sent.body.state, authorize.searchParams.get('state'));
    const { createHash } = await import('node:crypto');
    const challenge = createHash('sha256').update(sent.body.code_verifier).digest('base64url');
    assert.equal(challenge, authorize.searchParams.get('code_challenge'), 'the wire verifier did not match the S256 challenge');

    const connections = await state.service.listConnections();
    const saved = connections.find((connection) => connection.providerId === 'claude');
    assert.ok(saved, 'the sign-in saved no claude connection');
    assert.equal(saved.id, 'claude');
    const polled = await (await fetch(`${state.base}/v1/oauth/claude/session/${started.sessionId}`, { headers: { authorization: `Bearer ${state.key}` } })).json();
    assert.equal(polled.status, 'connected');
  } finally {
    await close(state);
  }
});

test('the browser callback completes the same flow and renders only an outcome page', async () => {
  const state = await harness();
  try {
    const started = await start(state.base, state.key);
    const authorize = new URL(started.verificationUrl);
    const response = await fetch(
      `${state.base}/v1/oauth/claude/callback/${started.sessionId}?code=granted-code#${authorize.searchParams.get('state')}`,
    );
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /Connected to Claude/);
    assert.doesNotMatch(page, /scripted-token|scripted-refresh/, 'a credential appeared in the callback page');
    assert.equal(state.transport.tokenSeen.length, 1);
  } finally {
    await close(state);
  }
});
