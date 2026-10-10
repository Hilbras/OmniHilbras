import assert from 'node:assert/strict';
import test from 'node:test';
import { isOauthCallbackNavigation } from '../dist/http.js';

const req = (url, method = 'GET') => ({ method, url });

test('the real callback path is exempt from the key gate', () => {
  assert.equal(isOauthCallbackNavigation(req('/v1/oauth/cline/callback/abc123')), true);
});

test('a dot-segment path that resolves outside the callback is not exempt', () => {
  assert.equal(
    isOauthCallbackNavigation(req('/v1/oauth/cline/callback/x/../../../../connections')),
    false,
    'it routes to /v1/connections after normalisation, so it must be gated',
  );
});

test('a percent-encoded traversal is not exempt either', () => {
  assert.equal(isOauthCallbackNavigation(req('/v1/oauth/cline/callback/%2e%2e/%2e%2e/connections')), false);
});
