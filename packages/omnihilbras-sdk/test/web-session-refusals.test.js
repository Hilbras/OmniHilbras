import assert from 'node:assert/strict';
import test from 'node:test';
import { DeepSeekWebAdapter, DEEPSEEK_WEB } from '../dist/providers/deepseek-web/index.js';
import { TokenHarborWebAdapter, tokenHarborWebCredential } from '../dist/providers/tokenharbor-web/index.js';
import { ProviderError } from '../dist/index.js';

/**
 * The browser-session adapters map their own status codes, so the shared transport's status tests do not
 * reach them. These drive the real branches with an injected fetch that returns the status.
 */

const b64url = (value) => Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sessionValue = (session = { access_token: 'header.payload.signature', expires_at: 4102444800, refresh_token: 'r' }) => `base64-${b64url(JSON.stringify(session))}`;
const liveCookie = () => `sb-auth-auth-token=${sessionValue()}`;

const statusFetch = (status, body = '') => async () => new Response(body, { status, headers: { 'content-type': 'application/json' } });

test('DeepSeek Web: a 429 is a retryable rate limit, not an authentication failure', async () => {
  const adapter = new DeepSeekWebAdapter({ fetch: statusFetch(429) });
  await assert.rejects(
    () => adapter.validateCredential({ type: 'api-key', value: 'tok' }),
    (error) => error instanceof ProviderError && error.code === 'RATE_LIMITED' && error.retryable === true,
  );
});

test('DeepSeek Web: a 401 is an authentication failure that tells the user to re-export the token', async () => {
  const adapter = new DeepSeekWebAdapter({ fetch: statusFetch(401) });
  await assert.rejects(
    () => adapter.validateCredential({ type: 'api-key', value: 'tok' }),
    (error) => error instanceof ProviderError && error.code === 'AUTHENTICATION_FAILED' && /userToken/.test(error.message),
  );
});

test('DeepSeek Web: a 403 is treated the same as a 401, not as a rate limit', async () => {
  const adapter = new DeepSeekWebAdapter({ fetch: statusFetch(403) });
  await assert.rejects(
    () => adapter.validateCredential({ type: 'api-key', value: 'tok' }),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
});

test('DeepSeek Web: an unrecognised status is an unavailable provider, with the status in the message', async () => {
  const adapter = new DeepSeekWebAdapter({ fetch: statusFetch(503) });
  await assert.rejects(
    () => adapter.validateCredential({ type: 'api-key', value: 'tok' }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && /503/.test(error.message),
  );
});

test('TokenHarbor Web: a 429 is a retryable rate limit', async () => {
  const adapter = new TokenHarborWebAdapter({ fetch: statusFetch(429) });
  await assert.rejects(
    () => adapter.validateCredential(tokenHarborWebCredential(liveCookie())),
    (error) => error.code === 'RATE_LIMITED' && error.retryable === true,
  );
});

test('TokenHarbor Web: a 402 names the missing balance and says the ":free" models do not bill', async () => {
  const adapter = new TokenHarborWebAdapter({ fetch: statusFetch(402) });
  await assert.rejects(
    () => adapter.validateCredential(tokenHarborWebCredential(liveCookie())),
    (error) => error.code === 'PROVIDER_REQUEST_FAILED' && /402/.test(error.message) && /free/.test(error.message),
  );
});

test('TokenHarbor Web: a 5xx is retryable, a 4xx other than the handled ones is not', async () => {
  const server = new TokenHarborWebAdapter({ fetch: statusFetch(502) });
  await assert.rejects(
    () => server.validateCredential(tokenHarborWebCredential(liveCookie())),
    (error) => error.retryable === true,
  );
  const client = new TokenHarborWebAdapter({ fetch: statusFetch(418) });
  await assert.rejects(
    () => client.validateCredential(tokenHarborWebCredential(liveCookie())),
    (error) => error.retryable === false,
  );
});

test('TokenHarbor Web: a 401 with an expired session says it expired, not to sign in again blindly', async () => {
  const expired = sessionValue({ access_token: 'h.p.s', expires_at: Math.floor(Date.now() / 1000) - 3600 });
  const adapter = new TokenHarborWebAdapter({ fetch: statusFetch(401) });
  await assert.rejects(
    () => adapter.validateCredential(tokenHarborWebCredential(`sb-auth-auth-token=${expired}`)),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /expired/.test(error.message),
  );
});

test('DeepSeek Web: the default fetch and the model list do not need a network to be constructed', () => {
  assert.equal(new DeepSeekWebAdapter().id, DEEPSEEK_WEB.id ?? 'deepseek-web');
});
