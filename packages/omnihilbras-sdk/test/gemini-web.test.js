import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GEMINI_WEB,
  GEMINI_WEB_MODELS,
  GeminiWebAdapter,
  buildGeminiWebPrompt,
  geminiWebCookiePresent,
  mergeRotatedGeminiWebCookies,
  normalizeGeminiWebCookie,
  parseGeminiWebCookieHeader,
  parseGeminiWebStreamResponse,
  resolveGeminiWebModel,
} from '../dist/index.js';

/**
 * Gemini Web, the parts that can be checked without a browser.
 *
 * The provider drives `gemini.google.com` in a real browser, so the browser is faked here and the checks are
 * about everything around it: what a pasted cookie is, what the `StreamGenerate` payload means, which models
 * the UI can be driven to, and which refusals are honest to make **before** a browser is opened. The last one
 * matters most — a refusal that happens after launching Chromium has already spent the expensive part.
 */

const cookie = '__Secure-1PSID=psid-value; __Secure-1PSIDTS=psidts-value';

/** A driver whose behaviour the test chooses, so no browser and no network is involved. */
function driver(over = {}) {
  const calls = [];
  return {
    calls,
    async available() {
      return { ok: true };
    },
    async ask(input) {
      calls.push(input);
      return { text: 'an answer' };
    },
    ...over,
  };
}

const request = (over = {}) => ({ model: 'gemini-3.1-pro', messages: [{ role: 'user', content: 'hello' }], ...over });
const credential = { type: 'api-key', value: cookie };

test('a bare cookie value gets the primary cookie name, a header is left alone', () => {
  // The whole reason this is not a split on `=`: `abc` is a value and `abc=def` is a header, and only one of
  // them parses as a cookie. Prefixing the wrong one sends a cookie named after the value.
  assert.equal(normalizeGeminiWebCookie('abc123'), '__Secure-1PSID=abc123');
  assert.equal(normalizeGeminiWebCookie('  abc123  '), '__Secure-1PSID=abc123');
  assert.equal(normalizeGeminiWebCookie('a=1; b=2'), 'a=1; b=2');
  assert.equal(normalizeGeminiWebCookie(''), '');
});

test('a JSON export becomes a cookie header, and anything that is not one is treated as a value', () => {
  assert.equal(normalizeGeminiWebCookie('{"__Secure-1PSID":"x","__Secure-1PSIDTS":"y"}'), '__Secure-1PSID=x; __Secure-1PSIDTS=y');
  // The `{cookies: {...}}` envelope an extension's export uses.
  assert.equal(normalizeGeminiWebCookie('{"cookies":{"__Secure-1PSID":"x"}}'), '__Secure-1PSID=x');
  // Not JSON, so it is a value — and it contains no `=`, so it gets the name. A malformed export must not throw.
  assert.equal(normalizeGeminiWebCookie('{not json'), '__Secure-1PSID={not json');
});

test('cookie attributes are dropped, because they are not cookies', () => {
  // A copied header carries `path`, `domain`, `expires`. Sending those as cookies is at best ignored and at
  // worst a malformed request.
  const pairs = parseGeminiWebCookieHeader('__Secure-1PSID=x; Path=/; Domain=.google.com; Secure; SameSite=None; __Secure-1PSIDTS=y');
  assert.deepEqual(pairs, [{ name: '__Secure-1PSID', value: 'x' }, { name: '__Secure-1PSIDTS', value: 'y' }]);
});

test('a credential is present when it holds a usable cookie, and not when it is empty', () => {
  assert.equal(geminiWebCookiePresent(cookie), true);
  assert.equal(geminiWebCookiePresent('__Secure-1PSID='), false, 'a name with no value is not a credential');
  assert.equal(geminiWebCookiePresent('   '), false);
});

test('rotation replaces the three rotatable cookies and leaves everything else alone', () => {
  const merged = mergeRotatedGeminiWebCookies('__Secure-1PSID=old; __Secure-1PSIDTS=old; SID=keep', [
    { name: '__Secure-1PSIDTS', value: 'new' },
    { name: '__Secure-1PSIDCC', value: 'minted' },
    { name: 'SID', value: 'should-not-apply' },
  ]);
  // 1PSID stays as pasted (the jar did not report it), 1PSIDTS is refreshed, 1PSIDCC is appended, and a
  // non-rotatable cookie the jar happens to hold does not overwrite what the user pasted.
  assert.equal(merged, '__Secure-1PSID=old; __Secure-1PSIDTS=new; SID=keep; __Secure-1PSIDCC=minted');
});

test('the answer is read out of the wrb.fr envelope', () => {
  const payload = JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [[null, ['Hello', ' there']]]])]]);
  const body = `)]}'\n\n30\n${payload}\n`;
  assert.equal(parseGeminiWebStreamResponse(body), 'Hello there');
});

test('cumulative frames keep only the last, because concatenating them would duplicate the reply', () => {
  // **The rule that matters.** Gemini's frames are snapshots of the same answer, not increments. This test
  // fails with `HellHello there` the moment someone "fixes" the parser to concatenate.
  const frame = (text) => {
    const payload = JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [[null, [text]]]])]]);
    return `)]}'\n${payload}`;
  };
  const body = [frame('Hello'), frame('Hello there')].join('\n');
  assert.equal(parseGeminiWebStreamResponse(body), 'Hello there');
});

test('a malformed line is skipped, and a payload with no answer yields empty rather than throwing', () => {
  // A page that changes its framing must produce "no answer" — which the adapter reports as a refusal — not an
  // exception the caller has to interpret.
  const good = JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [[null, ['ok']]]])]]);
  assert.equal(parseGeminiWebStreamResponse(`{not json\n)]}'\n${good}`), 'ok');
  assert.equal(parseGeminiWebStreamResponse('nonsense'), '');
  assert.equal(parseGeminiWebStreamResponse(''), '');
});

test('only the models the UI can be driven to resolve, and an unknown one is undefined', () => {
  assert.equal(resolveGeminiWebModel('gemini-3.1-pro')?.id, 'gemini-3.1-pro');
  assert.equal(resolveGeminiWebModel('gemini-3.7-flash')?.id, 'gemini-3.7-flash');
  assert.equal(resolveGeminiWebModel('gemini-2.5-pro'), undefined, 'a Google API model id is not a UI mode');
  assert.equal(resolveGeminiWebModel(undefined), undefined);
  // The default mode is marked, because claiming to have selected it would be a claim about a click that
  // never happened — the page already opens to it.
  assert.equal(GEMINI_WEB_MODELS.find((model) => model.id === 'gemini-3.1-pro')?.isDefault, true);
  assert.equal(GEMINI_WEB.streamMarker, 'StreamGenerate', 'the response is matched on this substring');
});

test('a user turn is typed into the page, with earlier turns flattened into it', () => {
  assert.equal(buildGeminiWebPrompt([{ role: 'user', text: 'hi' }]), 'hi');
  const withSystem = buildGeminiWebPrompt([{ role: 'system', text: 'Be brief.' }, { role: 'user', text: 'hi' }]);
  assert.match(withSystem, /System:\nBe brief\./);
  assert.match(withSystem, /Current user message:\nhi$/);
  // The last user message is byte-for-byte what was typed, because that is what the model answers.
  const multi = buildGeminiWebPrompt([
    { role: 'system', text: 'Be brief.' },
    { role: 'user', text: 'first' },
    { role: 'assistant', text: 'ok' },
    { role: 'user', text: 'second' },
  ]);
  assert.match(multi, /Previous conversation:[\s\S]*User: first[\s\S]*Assistant: ok/);
  assert.match(multi, /Current user message:\nsecond$/);
});

test('a turn is answered through the driver, and the prompt reaches it', async () => {
  const fake = driver();
  const adapter = new GeminiWebAdapter({ driver: fake, id: 'gemini-web' });
  const response = await adapter.chat(request(), { credential });
  assert.equal(response.message.content, 'an answer');
  assert.equal(response.model, 'gemini-3.1-pro');
  assert.equal(response.finishReason, 'stop');
  assert.equal(fake.calls.length, 1, 'the driver is driven exactly once');
  assert.equal(fake.calls[0].messages.at(-1).text, 'hello');
  assert.equal(fake.calls[0].model?.id, 'gemini-3.1-pro');
});

test('a forced tool call is refused before the browser is opened', async () => {
  // The cost this avoids: Chromium launched, the page loaded, a prompt typed — all to learn something that was
  // decidable from the request.
  const fake = driver();
  const adapter = new GeminiWebAdapter({ driver: fake, id: 'gemini-web' });
  await assert.rejects(
    () => adapter.chat(request({ toolChoice: 'required' }), { credential }),
    (error) => error.code === 'NOT_SUPPORTED',
  );
  assert.equal(fake.calls.length, 0, 'the driver must not be reached for a refused request');
});

test('a model the UI cannot be driven to is refused, and says which ones it can', async () => {
  const fake = driver();
  const adapter = new GeminiWebAdapter({ driver: fake, id: 'gemini-web' });
  await assert.rejects(
    () => adapter.chat(request({ model: 'gemini-2.5-pro' }), { credential }),
    (error) => error.code === 'NOT_SUPPORTED' && /gemini-3\.1-pro/.test(error.publicMessage),
  );
  assert.equal(fake.calls.length, 0);
});

test('no cookie is an authentication failure, and the message says what to paste', async () => {
  const adapter = new GeminiWebAdapter({ driver: driver(), id: 'gemini-web' });
  await assert.rejects(
    () => adapter.chat(request(), { credential: { type: 'api-key', value: '' } }),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /__Secure-1PSID/.test(error.publicMessage),
  );
});

test('a missing browser is its own failure and is not retried', async () => {
  // Not retryable: a browser that is not installed will still not be installed on the next attempt, and
  // retrying would burn the whole failover chain on an installation problem — and send the user to rotate a
  // credential that was never the problem.
  const adapter = new GeminiWebAdapter({
    driver: driver({ async available() { return { ok: false, reason: 'Run `npx playwright install chromium`.' }; } }),
    id: 'gemini-web',
  });
  await assert.rejects(
    () => adapter.chat(request(), { credential }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.retryable === false && /playwright install/.test(error.publicMessage),
  );
});

test('an empty answer is a refusal about the session, not a silent empty reply', async () => {
  const adapter = new GeminiWebAdapter({ driver: driver({ async ask() { return { text: '   ' }; } }), id: 'gemini-web' });
  await assert.rejects(
    () => adapter.chat(request(), { credential }),
    (error) => error.code === 'INVALID_RESPONSE',
  );
});

test('a driven browser failure is a retryable provider failure, with the page named', async () => {
  const adapter = new GeminiWebAdapter({ driver: driver({ async ask() { throw new Error('Timeout 30000ms exceeded'); } }), id: 'gemini-web' });
  await assert.rejects(
    () => adapter.chat(request(), { credential }),
    (error) => error.code === 'PROVIDER_REQUEST_FAILED' && error.retryable === true && /30000ms/.test(error.message),
  );
});

test('rotated cookies are handed to storage, and a storage failure does not fail the turn', async () => {
  const seen = [];
  const adapter = new GeminiWebAdapter({
    driver: driver({
      async ask(input) {
        await input.onRotatedCookies?.('__Secure-1PSID=refreshed');
        return { text: 'answer' };
      },
    }),
    id: 'gemini-web',
    onTokensRefreshed: (merged) => { seen.push(merged); },
  });
  const response = await adapter.chat(request(), { credential });
  assert.equal(response.message.content, 'answer');
  assert.deepEqual(seen, ['__Secure-1PSID=refreshed']);
});

test('streaming yields the whole answer once, because there is no stream', async () => {
  const adapter = new GeminiWebAdapter({ driver: driver(), id: 'gemini-web' });
  const chunks = [];
  for await (const chunk of adapter.streamChat(request(), { credential })) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].delta.content, 'an answer');
  assert.equal(adapter.capabilities.streaming, false, 'claiming a stream would be a claim tokens arrive over time');
});