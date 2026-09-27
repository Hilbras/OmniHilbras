import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHATGPT_WEB,
  CHATGPT_WEB_MODELS,
  ChatGptWebAdapter,
  chatGptCookieHeader,
  chatGptWebCredential,
  chatGptWebSessionFromCredential,
  lastAssistantText,
  looksSignedOut,
  parseChatGptCookieHeader,
  parseChatGptStorageState,
} from '../dist/index.js';

/**
 * ChatGPT Web has no API, so what is testable here is the part around the browser: what a
 * valid export is, what gets carried across, and how a page that has failed is read.
 *
 * The credential is a whole-account session, so the "does not carry anything else out of
 * that export" cases are the ones that matter most. A pasted blob is user input that gets
 * forwarded to a third party, and it should not become a way to send someone else's
 * cookies to ChatGPT.
 */

const liveExpiry = () => Math.floor(Date.now() / 1000) + 3600;

const stateJson = (cookies) =>
  JSON.stringify({
    cookies,
    origins: [{ origin: 'https://chatgpt.com', localStorage: [] }],
  });

const openAiCookie = (overrides = {}) => ({
  name: '__Secure-next-auth.session-token',
  value: 'session-abc',
  domain: '.chatgpt.com',
  expires: liveExpiry(),
  ...overrides,
});

function driver(overrides = {}) {
  const asked = [];
  const base = {
    async available() {
      return { ok: true };
    },
    async ask(input) {
      asked.push(input);
      return { text: 'Hello from the page.' };
    },
  };
  return { driver: { ...base, ...overrides }, asked };
}

const request = (model = 'gpt-5.2', messages = [{ role: 'user', content: 'hi' }]) => ({ model, messages });

/* ------------------------------------------------------------------ *
 * The export
 * ------------------------------------------------------------------ */

test('a storage state is read, and non-OpenAI cookies are left behind', () => {
  const state = parseChatGptStorageState(
    stateJson([
      openAiCookie(),
      { name: 'oai-did', value: 'did-1', domain: '.chatgpt.com' },
      { name: 'shopper', value: 'someone-elses', domain: '.attacker.example' },
    ]),
  );
  assert.deepEqual(state.cookies.map((cookie) => cookie.name), ['__Secure-next-auth.session-token', 'oai-did']);
  // The third cookie is in the user's paste but is not ours to send to OpenAI.
  assert.equal(state.cookies.some((cookie) => cookie.name === 'shopper'), false);
});

test('cookies for an openai.com subdomain are accepted, and lookalike hosts are not', () => {
  const state = parseChatGptStorageState(
    stateJson([
      { name: 'a', value: '1', domain: '.auth.openai.com' },
      { name: 'b', value: '2', domain: 'notopenai.com' },
      { name: 'c', value: '3', domain: '.chatgpt.com.evil.example' },
    ]),
  );
  assert.deepEqual(state.cookies.map((cookie) => cookie.name), ['a']);
});

test('a blob with no cookies array is refused, rather than half-applied', () => {
  assert.throws(
    () => parseChatGptStorageState('{"origins":[]}'),
    (error) => error.code === 'INVALID_REQUEST' && /no `cookies` array/.test(error.publicMessage),
  );
});

test('a JSON array of cookies is accepted, since that is what extensions export', () => {
  const state = parseChatGptStorageState('[{"name":"__Secure-next-auth.session-token","value":"v","domain":".chatgpt.com"}]');
  assert.equal(state.cookies.length, 1);
  assert.equal(state.cookies[0].value, 'v');
});

test('non-JSON says what to paste instead, because a cookie header is what people have', () => {
  assert.throws(
    () => parseChatGptStorageState('__Secure-next-auth.session-token=abc; oai-did=def'),
    (error) => error.code === 'INVALID_REQUEST' && /cookie header/.test(error.publicMessage),
  );
});

test('an export whose cookies are all unusable is refused', () => {
  assert.throws(
    () => parseChatGptStorageState(stateJson([{ name: '', value: 'x', domain: '.chatgpt.com' }])),
    (error) => /no usable chatgpt.com cookies/.test(error.publicMessage),
  );
});

test('an empty paste asks for the thing that is missing', () => {
  assert.throws(
    () => parseChatGptStorageState('   '),
    (error) => /storage-state JSON/.test(error.publicMessage),
  );
});

/* ------------------------------------------------------------------ *
 * The header
 * ------------------------------------------------------------------ */

test('expired cookies are dropped, because a stale session fails like a wrong password', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const header = chatGptCookieHeader(
    [
      { name: 'live', value: '1', expires: now / 1000 + 600 },
      { name: 'dead', value: '2', expires: now / 1000 - 600 },
      // -1 is a session cookie: no expiry, so it is always live.
      { name: 'session', value: '3', expires: -1 },
      { name: 'undated', value: '4' },
    ],
    now,
  );
  assert.deepEqual(header.split('; ').map((pair) => pair.split('=')[0]), ['live', 'session', 'undated']);
});

test('a bare cookie header is accepted, with a Cookie: prefix tolerated', () => {
  const cookies = parseChatGptCookieHeader('Cookie: a=1; b=2');
  assert.deepEqual(cookies.map((cookie) => cookie.name), ['a', 'b']);
  assert.equal(cookies[0].domain, '.chatgpt.com');
});

test('a malformed pair in a header is skipped rather than producing a broken header', () => {
  const cookies = parseChatGptCookieHeader('a=1; ; =2; b=2; c');
  assert.deepEqual(cookies.map((cookie) => cookie.name), ['a', 'b']);
});

/* ------------------------------------------------------------------ *
 * The credential round trip
 * ------------------------------------------------------------------ */

test('the credential round-trips the cookies it was given', () => {
  const state = parseChatGptStorageState(stateJson([openAiCookie()]));
  const credential = chatGptWebCredential(state);
  const back = chatGptWebSessionFromCredential(credential);
  assert.deepEqual(back.cookies.map((cookie) => cookie.name), ['__Secure-next-auth.session-token']);
});

test('no stored session, and an unreadable one, are each named', () => {
  assert.throws(
    () => chatGptWebSessionFromCredential(undefined),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /No ChatGPT Web session/.test(error.publicMessage),
  );
  assert.throws(
    () => chatGptWebSessionFromCredential({ type: 'api-key', value: 'not json' }),
    (error) => /unreadable/.test(error.publicMessage),
  );
});

test('an export that has fully expired is reported as expired, before any browser opens', async () => {
  const state = parseChatGptStorageState(
    stateJson([{ name: 'session', value: 'v', domain: '.chatgpt.com', expires: Math.floor(Date.now() / 1000) - 10 }]),
  );
  const { driver: d } = driver();
  const adapter = new ChatGptWebAdapter({ driver: d });
  await assert.rejects(
    () => adapter.validateCredential(chatGptWebCredential(state)),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /expired/.test(error.publicMessage),
  );
});

test('a missing browser is named as a setup problem, not a session problem', async () => {
  const state = parseChatGptStorageState(stateJson([openAiCookie()]));
  const { driver: d } = driver({
    async available() {
      return { ok: false, reason: 'ChatGPT Web needs a browser, and Playwright is not installed.' };
    },
  });
  const adapter = new ChatGptWebAdapter({ driver: d });
  await assert.rejects(
    () => adapter.validateCredential(chatGptWebCredential(state)),
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && /Playwright is not installed/.test(error.publicMessage),
  );
});

/* ------------------------------------------------------------------ *
 * Reading the page
 * ------------------------------------------------------------------ */

test('a signed-out page is recognised before it can look like an empty answer', () => {
  // A stale cookie still renders a page, and it renders it perfectly well. The composer
  // missing while a sign-in link is present is the only honest difference.
  assert.equal(looksSignedOut({ loginLinkCount: 1, composerCount: 0 }), true);
  assert.equal(looksSignedOut({ loginLinkCount: 0, composerCount: 1 }), false);
  assert.equal(looksSignedOut({ loginLinkCount: 1, composerCount: 1 }), false);
});

test('the last assistant turn is the answer, not the first', () => {
  // ChatGPT streams into the final node and leaves earlier turns on the page, so taking
  // the first element answers a message from several turns ago.
  assert.equal(lastAssistantText(['the answer to turn one', 'the answer to turn two']), 'the answer to turn two');
  assert.equal(lastAssistantText(['', '  ', 'only this one']), 'only this one');
  assert.equal(lastAssistantText([]), '');
});

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

test('a chat request drives the page and returns its text', async () => {
  const { driver: d, asked } = driver();
  const state = parseChatGptStorageState(stateJson([openAiCookie()]));
  const response = await new ChatGptWebAdapter({ driver: d }).chat(request(), {
    credential: chatGptWebCredential(state),
  });
  assert.equal(response.message.content, 'Hello from the page.');
  assert.equal(response.finishReason, 'stop');
  assert.equal(asked[0].model, 'gpt-5.2');
  assert.equal(asked[0].messages[0].text, 'hi');
  // The page gets a prompt, not a message list it has nowhere to put.
  assert.equal(asked[0].messages.length, 1);
});

test('a system turn is folded into the prompt, because a browser turn carries one message', async () => {
  const { driver: d, asked } = driver();
  const state = parseChatGptStorageState(stateJson([openAiCookie()]));
  await new ChatGptWebAdapter({ driver: d }).chat(
    { model: 'gpt-5.2', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] },
    { credential: chatGptWebCredential(state) },
  );
  const prompt = asked[0].messages[0].text;
  assert.match(prompt, /be brief/);
  assert.match(prompt, /hi/);
});

test('only the session cookies are handed to the driver', async () => {
  const { driver: d, asked } = driver();
  const state = parseChatGptStorageState(
    stateJson([openAiCookie(), { name: 'other', value: 'v', domain: '.attacker.example' }]),
  );
  await new ChatGptWebAdapter({ driver: d }).chat(request(), { credential: chatGptWebCredential(state) });
  assert.deepEqual(asked[0].cookies.map((cookie) => cookie.name), ['__Secure-next-auth.session-token']);
});

test('a model the page does not offer is refused before a browser is launched', async () => {
  let asked = 0;
  const { driver: d } = driver({
    async ask() {
      asked += 1;
      return { text: 'no' };
    },
  });
  const state = parseChatGptStorageState(stateJson([openAiCookie()]));
  await assert.rejects(
    () => new ChatGptWebAdapter({ driver: d }).chat(request('gpt-4-imaginary'), { credential: chatGptWebCredential(state) }),
    (error) => error.code === 'NOT_SUPPORTED',
  );
  assert.equal(asked, 0, 'no browser is launched for a model that cannot exist');
});

test('a page that rendered nothing says the export may be stale', async () => {
  const { driver: d } = driver({ async ask() { return { text: '   ' }; } });
  const state = parseChatGptStorageState(stateJson([openAiCookie()]));
  await assert.rejects(
    () => new ChatGptWebAdapter({ driver: d }).chat(request(), { credential: chatGptWebCredential(state) }),
    (error) => error.code === 'INVALID_RESPONSE' && /export is stale/.test(error.publicMessage),
  );
});

test('the catalog is the known set, and streaming is not claimed', async () => {
  const { driver: d } = driver();
  const adapter = new ChatGptWebAdapter({ driver: d });
  const models = await adapter.listModels();
  assert.deepEqual(models.map((model) => model.id), CHATGPT_WEB_MODELS.map((model) => model.id));
  assert.equal(adapter.capabilities.streaming, false);
});

test('the selectors are ChatGPT test hooks, and the origin is pinned', () => {
  assert.equal(CHATGPT_WEB.origin, 'https://chatgpt.com');
  assert.match(CHATGPT_WEB.composer, /^#/);
  assert.match(CHATGPT_WEB.assistantMessage, /^\[data-message-author-role="assistant"\]$/);
  assert.match(CHATGPT_WEB.signedOutMarker, /^a\[href="/);
  // A temporary chat, so a gateway's traffic does not accumulate a visible history.
  assert.match(CHATGPT_WEB.startUrl, /temporary-chat=true/);
});
