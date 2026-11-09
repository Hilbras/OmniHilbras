import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGeminiWebCookie } from '../gemini-web/dist/adapter/index.js';
import { parseTokenHarborCookieHeader } from '../tokenharbor-web/dist/adapter/index.js';
import { parseQwenCookieHeader } from '../qwen-web/dist/adapter/index.js';

/**
 * The guides say "copy the whole `Cookie:` header line", so the parsers must accept one.
 *
 * Two of them did not: the prefix became the first cookie's name, so Gemini handed Playwright an
 * invalid batch and Token Harbor answered "that header carries no sb-auth-auth-token cookie" — telling
 * a user who followed the instructions to sign in again.
 */

const b64url = (value) => Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tokenHarborSession = () => `base64-${b64url(JSON.stringify({ access_token: 'header.payload.signature', expires_at: 4102444800, refresh_token: 'r' }))}`;

test('the Gemini parser strips a pasted Cookie: prefix', () => {
  const normalized = normalizeGeminiWebCookie('Cookie: __Secure-1PSID=abc; NID=def');
  assert.equal(normalized.includes('Cookie:'), false);
  assert.match(normalized, /^(?:__Secure-1PSID=abc|NID=def)/);
});

test('the Token Harbor parser strips a pasted Cookie: prefix', () => {
  const parsed = parseTokenHarborCookieHeader(`Cookie: sb-auth-auth-token=${tokenHarborSession()}; other=1`);
  assert.match(parsed, /sb-auth-auth-token=base64-/);
  assert.equal(parsed.includes('Cookie:'), false);
});

test('the Qwen parser strips a pasted Cookie: prefix', () => {
  const parsed = parseQwenCookieHeader('Cookie: cna=abc; isg=def');
  assert.deepEqual(parsed, { cna: 'abc', isg: 'def' });
});
