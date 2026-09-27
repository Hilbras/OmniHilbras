import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHATGPT_WEB,
  ChatGptWebAdapter,
  chatGptCookieHeader,
  chatGptWebCredential,
  chatGptWebModels,
  chatGptWebSessionFromCredential,
  isFreeChatGptPlan,
  lastAssistantText,
  looksBlocked,
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
  assert.ok(models.length > 0);
  assert.ok(models.every((model) => model.providerId === adapter.id));
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

/* ------------------------------------------------------------------ *
 * The CLI / Codex auth export
 * ------------------------------------------------------------------ */

/**
 * The shape people actually paste.
 *
 * This is the format of a real ChatGPT/Codex auth export: a `sessionToken` holding the
 * session cookie's value, a JWT `accessToken`, an `expires`, and an `account` block. It
 * has **no `cookies` key at all**, so a parser written only for the Playwright storage-state
 * shape rejects it — which is what happened when somebody pasted a genuine export.
 */
const authExport = (overrides = {}) =>
  JSON.stringify({
    accessToken: 'eyJhbGciOi.header.payload'.padEnd(200, 'x'),
    sessionToken: 'session-token-value',
    expires: '2026-12-26T17:00:52.429Z',
    authProvider: 'openai',
    account: { planType: 'free', structure: 'personal' },
    user: { email: 'someone@example.com' },
    ...overrides,
  });

test('the CLI auth export is read, which is the shape people actually have', () => {
  const state = parseChatGptStorageState(authExport());
  assert.equal(state.cookies.length, 1);
  assert.equal(state.cookies[0].name, '__Secure-next-auth.session-token');
  assert.equal(state.cookies[0].value, 'session-token-value');
  assert.equal(state.cookies[0].domain, '.chatgpt.com');
  assert.equal(state.cookies[0].path, '/');
});

test('the export says when it expires and what plan it is, and both survive the round trip', () => {
  // Both are worth more than the cookie: one says when this stops working, the other says
  // what the account may use. Losing them makes a dead session look like a broken one.
  const state = parseChatGptStorageState(authExport());
  assert.equal(state.planType, 'free');
  assert.equal(state.expiresAt, '2026-12-26T17:00:52.429Z');
  const back = chatGptWebSessionFromCredential(chatGptWebCredential(state));
  assert.equal(back.cookies[0].value, 'session-token-value');
  assert.equal(back.planType, 'free');
  assert.equal(back.expiresAt, '2026-12-26T17:00:52.429Z');
});

test('a session cookie is not treated as expired, because the export carries no expiry for it', () => {
  // `expires: -1` is a session cookie. Treating it as a past timestamp would drop the only
  // cookie the page checks, and the failure would look like a signed-out session.
  const state = parseChatGptStorageState(authExport());
  assert.equal(state.cookies[0].expires, -1);
  assert.match(chatGptCookieHeader(state.cookies), /__Secure-next-auth\.session-token=session-token-value/);
});

test('an export with no sessionToken says so rather than storing nothing', () => {
  assert.throws(
    () => parseChatGptStorageState(authExport({ sessionToken: '' })),
    (error) => error.code === 'INVALID_REQUEST' && /no sessionToken/.test(error.publicMessage),
  );
});

test('an unparseable expires is dropped, not trusted as a date', () => {
  const state = parseChatGptStorageState(authExport({ expires: 'never' }));
  assert.equal(state.expiresAt, undefined);
});

test('a session the export says has expired is reported without opening a browser', async () => {
  const { driver: d } = driver({
    async available() {
      throw new Error('a browser must not be launched to answer this');
    },
  });
  const state = parseChatGptStorageState(authExport({ expires: '2020-01-01T00:00:00.000Z' }));
  const adapter = new ChatGptWebAdapter({ driver: d, now: () => Date.parse('2026-01-01T00:00:00Z') });
  await assert.rejects(
    () => adapter.validateCredential(chatGptWebCredential(state)),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /expired/.test(error.publicMessage),
  );
});

/* ------------------------------------------------------------------ *
 * The plan decides the catalog
 * ------------------------------------------------------------------ */

test('a free plan is not offered the paid model set', () => {
  assert.equal(isFreeChatGptPlan('free'), true);
  assert.equal(isFreeChatGptPlan('Free'), true);
  assert.equal(isFreeChatGptPlan('pro'), false);
  assert.equal(isFreeChatGptPlan(undefined), false, 'an unknown plan is not assumed to be free');
  const free = chatGptWebModels('free').map((model) => model.id);
  const paid = chatGptWebModels('pro').map((model) => model.id);
  assert.ok(free.every((id) => paid.includes(id)), 'the free set is a subset of the paid one');
  assert.ok(paid.length > free.length);
});

test('an unrecognised plan gets the full set, because a visible failure beats a hidden model', () => {
  // Showing a model a paid account cannot use costs a failing test. Hiding one a free
  // account can use hides something that works.
  assert.equal(chatGptWebModels(undefined).length, chatGptWebModels('pro').length);
  assert.equal(chatGptWebModels('team').length, chatGptWebModels('pro').length);
});

test('the catalog comes from the plan on the session, not from a fixed list', async () => {
  const { driver: d } = driver();
  const adapter = new ChatGptWebAdapter({ driver: d });
  const free = await adapter.listModels({ credential: chatGptWebCredential(parseChatGptStorageState(authExport())) });
  assert.deepEqual(free.map((model) => model.id), chatGptWebModels('free').map((model) => model.id));
  const pro = await adapter.listModels({
    credential: chatGptWebCredential(parseChatGptStorageState(authExport({ account: { planType: 'pro' } }))),
  });
  assert.deepEqual(pro.map((model) => model.id), chatGptWebModels('pro').map((model) => model.id));
});

test('a paid-only model on a free session is refused, naming the plan', async () => {
  const { driver: d, asked } = driver();
  const state = parseChatGptStorageState(authExport());
  const adapter = new ChatGptWebAdapter({ driver: d });
  await assert.rejects(
    () => adapter.chat(request('gpt-5.2-codex'), { credential: chatGptWebCredential(state) }),
    (error) => error.code === 'NOT_SUPPORTED' && /a free plan/.test(error.publicMessage) && /custom model id/.test(error.publicMessage),
  );
  assert.equal(asked.length, 0, 'no browser is launched for a model this plan cannot use');
});

/* ------------------------------------------------------------------ *
 * A blocked edge is not a signed-out session
 * ------------------------------------------------------------------ */

test('a block page is told apart from a sign-in wall', () => {
  // Both render a real page with no composer, and they send a user in opposite directions:
  // re-export a good session, or fix the network.
  assert.equal(looksBlocked('Unable to load site [IP:1.2.3.4 | Ray ID:abc]'), true);
  assert.equal(looksBlocked('Attention Required! | Cloudflare'), true);
  assert.equal(looksBlocked('Checking your browser before accessing'), true);
  assert.equal(looksBlocked('What is ChatGPT?'), false);
  assert.equal(looksBlocked(null), false);
  // Cloudflare's interstitial has a blank body, so the title is the only signal there is.
  // This is what a real session gets from a blocked address.
  assert.equal(looksBlocked('', 'Just a moment...'), true);
  assert.equal(looksBlocked(null, 'Just a moment…'), true);
  assert.equal(looksBlocked('Hi', 'ChatGPT'), false);
});

/* ------------------------------------------------------------------ *
 * The reason has to survive
 * ------------------------------------------------------------------ */

test("a refused page names itself, instead of arriving as 'every route failed'", async () => {
  // The driver's failures are plain errors describing the page. Crossing the routing layer
  // as a plain error they become "every provider route failed" with the reason discarded —
  // which is a refused request reported as a broken model.
  const { driver: d } = driver({
    async ask() {
      throw new Error('chatgpt.com served its bot-protection challenge instead of the application');
    },
  });
  const state = parseChatGptStorageState(authExport());
  await assert.rejects(
    () => new ChatGptWebAdapter({ driver: d }).chat(request(), { credential: chatGptWebCredential(state) }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.match(error.publicMessage ?? '', /bot-protection challenge/);
      return true;
    },
  );
});

test('an ordinary page failure is not misfiled as an outage', async () => {
  const { driver: d } = driver({
    async ask() {
      throw new Error('The ChatGPT page loaded but never showed a composer.');
    },
  });
  const state = parseChatGptStorageState(authExport());
  await assert.rejects(
    () => new ChatGptWebAdapter({ driver: d }).chat(request(), { credential: chatGptWebCredential(state) }),
    (error) => error.code === 'PROVIDER_REQUEST_FAILED',
  );
});

test('a driver failure is raised, not swallowed into a successful empty answer', async () => {
  const { driver: d } = driver({
    async ask() {
      throw new Error('browser closed');
    },
  });
  const state = parseChatGptStorageState(authExport());
  await assert.rejects(
    () => new ChatGptWebAdapter({ driver: d }).chat(request(), { credential: chatGptWebCredential(state) }),
    (error) => /browser closed/.test(error.publicMessage ?? ''),
  );
});
