import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DUCKDUCKGO_WEB,
  DuckDuckGoWebAdapter,
  DuckDuckGoWebError,
  buildDuckDuckGoWebPayload,
  duckDuckGoWebContent,
  duckDuckGoWebCookieHeader,
  freeDuckDuckGoWebModels,
  normalizeDuckDuckGoWebCookie,
  normalizeDuckDuckGoWebError,
  parseDuckDuckGoWebDataLine,
} from '../dist/index.js';

/**
 * Duck.ai, the parts that can be checked without a network.
 *
 * The turn itself is the driver's, so the driver is faked here and the checks are about everything around it:
 * what a pasted cookie is (and what "no cookie" is), which models are free, how an answer is read out of the
 * service's stream, and which refusals are honest to make **before** a request is spent. The last one matters
 * most: this endpoint is rate limited per address, and a request that was going to be refused as a bad model
 * costs the same quota as one that was going to work.
 *
 * The live protocol was proven once, by hand, and recorded in `tasks/todo.md`: one `POST /duckchat/v1/chat`
 * returned 200 and the answer asked for. That is the evidence for the driver's side; this file is the evidence
 * for the adapter's.
 */

/**
 * A catalog shaped exactly like the live one, including the trap.
 *
 * `model.accessTier` is where "free" lives — 6 models there. `reasoningEffortAccess[].accessTier` marks only 3,
 * so a parser that reached for the nested field would silently drop half the free lineup. Both numbers are
 * asserted below, from this one fixture.
 */
const CATALOG = {
  models: [
    { id: 'gpt-5.4-mini', modelName: 'GPT-5.4', accessTier: ['free', 'plus', 'pro'], reasoningEffortAccess: [{ accessTier: ['free', 'plus', 'pro'] }] },
    { id: 'claude-haiku-4-5', modelName: 'Claude', accessTier: ['free', 'plus'], reasoningEffortAccess: [{ accessTier: ['free', 'plus'] }] },
    { id: 'tinfoil/gpt-oss-120b', modelName: 'gpt-oss', accessTier: ['free'], reasoningEffortAccess: [{ accessTier: ['free'] }] },
    { id: 'gpt-6-luna', modelName: 'GPT-6', accessTier: ['free', 'plus'], reasoningEffortAccess: [] },
    { id: 'mistral-small-2603', modelName: 'Mistral', accessTier: ['free'], reasoningEffortAccess: [] },
    { id: 'tinfoil/gemma4-31b', modelName: 'Gemma 4', accessTier: ['free'], reasoningEffortAccess: [] },
    { id: 'gpt-5.6-terra', modelName: 'GPT-5.6', accessTier: ['plus', 'pro', 'internal'], reasoningEffortAccess: [{ accessTier: ['plus', 'pro'] }] },
    { id: 'claude-opus-4-8', modelName: 'Claude', accessTier: ['pro'], reasoningEffortAccess: [{ accessTier: ['pro'] }] },
  ],
};

/** A driver whose behaviour the test chooses, so no network is involved. */
function driver(over = {}) {
  const calls = [];
  const base = {
    async available() {
      return { ok: true };
    },
    async catalog() {
      return CATALOG;
    },
    async status() {
      return { challengeServed: true, solvedMs: 2 };
    },
    async ask(input) {
      calls.push(input);
      return { text: 'answered', model: input.model };
    },
  };
  return { calls, ...base, ...over };
}

const cookie = 'dcs=1; dcm=3; isRecentChatOn=1';
const request = (over = {}) => ({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], ...over });

/* ------------------------------------------------------------------ *
 * The cookie, which may legitimately be absent
 * ------------------------------------------------------------------ */

test('a cookie is accepted in all three shapes a browser hands over', () => {
  assert.equal(normalizeDuckDuckGoWebCookie(cookie), cookie);
  assert.equal(normalizeDuckDuckGoWebCookie(`Cookie: ${cookie}`), cookie);
  // The devtools JSON export, both the bare array and the `{ cookies: [...] }` wrapper.
  assert.equal(
    normalizeDuckDuckGoWebCookie(JSON.stringify([{ name: 'dcs', value: '1' }, { name: 'dcm', value: '3' }])),
    'dcs=1; dcm=3',
  );
  assert.equal(
    normalizeDuckDuckGoWebCookie(JSON.stringify({ cookies: [{ name: 'dcs', value: '1' }] })),
    'dcs=1',
  );
});

test('a paste that carries nothing is "no cookie", and junk is not', () => {
  // The difference matters: no cookie is this provider's normal case, junk is a mistake worth reporting.
  assert.equal(normalizeDuckDuckGoWebCookie(''), undefined);
  assert.equal(normalizeDuckDuckGoWebCookie('   '), undefined);
  assert.equal(normalizeDuckDuckGoWebCookie('{}'), undefined);
  assert.equal(normalizeDuckDuckGoWebCookie('not a cookie at all'), undefined);
});

test('no credential means no Cookie header — and that is the normal case', () => {
  // Every other web-cookie adapter in this repository refuses `{ type: 'none' }`. This one cannot: it is what
  // the connect route stores when nothing is pasted, and the service is anonymous.
  assert.equal(duckDuckGoWebCookieHeader({ type: 'none' }), undefined);
  assert.equal(duckDuckGoWebCookieHeader(undefined), undefined);
  assert.equal(duckDuckGoWebCookieHeader({ type: 'api-key', value: cookie }), cookie);
  assert.equal(duckDuckGoWebCookieHeader({ type: 'oauth', value: 'token' }), undefined);
});

/* ------------------------------------------------------------------ *
 * The catalog, and the field that decides what is free
 * ------------------------------------------------------------------ */

test('the free lineup is read from the model, not from its reasoning tiers', () => {
  // THE TRAP. Both numbers are real, measured against the live catalog: six models carry `free` on the model
  // itself, and only three mention it inside `reasoningEffortAccess`. The nested field describes which effort
  // levels an account tier may pick, not whether the model is served — so reading it drops half the lineup,
  // silently, and the drop looks like a smaller catalog rather than a bug.
  const free = freeDuckDuckGoWebModels(CATALOG);
  assert.equal(free.length, 6, 'six models are free by the field the service actually uses');

  const byNestedField = CATALOG.models.filter((model) =>
    (model.reasoningEffortAccess ?? []).some((entry) => (entry.accessTier ?? []).includes('free')),
  );
  assert.equal(byNestedField.length, 3, 'and only three by the field that measures something else');

  for (const model of ['gpt-6-luna', 'mistral-small-2603', 'tinfoil/gemma4-31b']) {
    assert.ok(free.some((entry) => entry.id === model), `${model} is free on the model and must not be dropped`);
  }
  assert.equal(free.some((entry) => entry.id === 'claude-opus-4-8'), false, 'a pro-only model is not free');
});

test('a catalog that is not a catalog yields nothing rather than throwing', () => {
  // `listModels` runs on every save and refresh, and a proxy or an error page returns HTML with a 200.
  for (const value of [undefined, null, '', {}, { models: 'nope' }, { models: [null, 5] }]) {
    assert.deepEqual(freeDuckDuckGoWebModels(value), []);
  }
});

/* ------------------------------------------------------------------ *
 * Reading the answer
 * ------------------------------------------------------------------ */

test('the answer is read from `message`, which is where this service puts it', () => {
  // THE OTHER TRAP. The live stream sends `{"action":"success","message":"..."}` and then `{"message":"..."}`
  // frames; `content` — the field every other provider here uses — never appears. A reader that looked only
  // for `content` returns HTTP 200 with an empty answer, and the spike's own first attempt did exactly that.
  assert.equal(duckDuckGoWebContent(parseDuckDuckGoWebDataLine('data: {"action":"success","message":"hel"}')), 'hel');
  assert.equal(duckDuckGoWebContent(parseDuckDuckGoWebDataLine('data: {"message":"lo"}')), 'lo');
  // And `content` still wins where it appears, so the reader is not narrowed to one shape.
  assert.equal(duckDuckGoWebContent(parseDuckDuckGoWebDataLine('data: {"content":"direct"}')), 'direct');
});

test('the pseudo-events around the answer are dropped, not thrown on', () => {
  // The stream opens with `data: [CHAT_TITLE:...]` and ends with `[DONE]`. A parser that threw on the first
  // would fail every turn at its first byte; both are normal.
  assert.equal(parseDuckDuckGoWebDataLine('data: [CHAT_TITLE:Spike ok]'), undefined);
  assert.equal(parseDuckDuckGoWebDataLine('data: [DONE]'), undefined);
  assert.equal(parseDuckDuckGoWebDataLine('event: ping'), undefined);
  assert.equal(parseDuckDuckGoWebDataLine(''), undefined);
  assert.equal(duckDuckGoWebContent(undefined), '');
});

test('the request body carries what the service requires, and the key it is handed', () => {
  const publicKey = { kty: 'RSA', n: 'modulus', e: 'AQAB', alg: 'RSA-OAEP-256', ext: true, key_ops: ['encrypt'], use: 'enc' };
  const payload = buildDuckDuckGoWebPayload({
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: 'hi' }],
    publicKey,
    conversationId: 'c-1',
    messageId: 'm-1',
  });

  assert.equal(payload.model, 'gpt-5.4-mini');
  // Required on every request by the working implementation's measurement (a 400 without it).
  assert.equal(payload.reasoningEffort, DUCKDUCKGO_WEB.defaultReasoningEffort);
  // Every tool off: a search tool firing on its own is a request the caller did not ask for.
  assert.deepEqual(payload.metadata, { toolChoice: { NewsSearch: false, VideosSearch: false, LocalSearch: false, WeatherForecast: false } });
  // The key is passed through as a **value**. Generating it needs `node:crypto`, which this package may not
  // import — `tests/sdk-browser-safety.test.js` fails if anything reachable from the barrel does.
  assert.deepEqual(payload.durableStream.publicKey, publicKey);
  assert.equal(payload.durableStream.messageId, 'm-1');
});

/* ------------------------------------------------------------------ *
 * Refusals, before anything is spent
 * ------------------------------------------------------------------ */

test('a model that is not free is refused by name, without asking the service', async () => {
  const fake = driver();
  const adapter = new DuckDuckGoWebAdapter({ driver: fake });

  await assert.rejects(() => adapter.chat(request({ model: 'claude-opus-4-8' })), (error) => {
    assert.equal(error.code, 'NOT_SUPPORTED');
    assert.match(error.publicMessage, /free/);
    // The point of the refusal: the rate-limited endpoint is never touched.
    assert.match(error.publicMessage, /gpt-5\.4-mini/, 'the message names what is free instead');
    return true;
  });
  assert.deepEqual(fake.calls, [], 'a refused model must not spend a request');
});

test('a forced tool call is refused, because prose cannot honour it', async () => {
  const fake = driver();
  const adapter = new DuckDuckGoWebAdapter({ driver: fake });
  await assert.rejects(() => adapter.chat(request({ toolChoice: 'required' })), /force a tool call/);
  assert.deepEqual(fake.calls, []);
});

test('an unreadable catalog does not refuse the turn — the service decides', async () => {
  // A catalog read that fails is a fact about this gateway, not about the request. Refusing here would be a
  // named error about the wrong thing, and the service is one request away from answering.
  const fake = driver({ async catalog() { throw new Error('catalog unreachable'); } });
  const adapter = new DuckDuckGoWebAdapter({ driver: fake });
  const response = await adapter.chat(request());
  assert.equal(response.finishReason, 'stop');
  assert.equal(fake.calls.length, 1, 'the turn went ahead');
});

test('a cookie is sent when there is one, and nothing is sent when there is not', async () => {
  for (const [credential, expected] of [
    [{ type: 'api-key', value: cookie }, cookie],
    [{ type: 'none' }, undefined],
    [undefined, undefined],
  ]) {
    const fake = driver();
    const adapter = new DuckDuckGoWebAdapter({ driver: fake });
    await adapter.chat(request(), { credential });
    assert.equal(fake.calls[0].cookieHeader, expected);
  }
});

/* ------------------------------------------------------------------ *
 * Failures, classified by kind rather than by prose
 * ------------------------------------------------------------------ */

test('each failure kind maps to one code and one retryability, from a field', () => {
  // The service's own errors cannot be told apart by their text: `ERR_CHALLENGE` and `ERR_BN_LIMIT` share a
  // user-facing message token, so a regex over prose would classify a per-address quota as an expired
  // challenge. Measured: a 418 `ERR_CHALLENGE` appeared 43 s after a successful turn and cleared 4.9 min
  // later, so retrying it in a loop spends the quota that just refused.
  const cases = [
    ['challenge', 'PROVIDER_UNAVAILABLE', false],
    ['quota', 'PROVIDER_UNAVAILABLE', false],
    ['bad-request', 'INVALID_REQUEST', false],
    ['rate-limit', 'PROVIDER_REQUEST_FAILED', true],
    ['unavailable', 'PROVIDER_REQUEST_FAILED', true],
  ];
  for (const [kind, code, retryable] of cases) {
    const error = normalizeDuckDuckGoWebError(new DuckDuckGoWebError(kind, 'probe', 'd78d'), 'duckduckgo-web');
    assert.equal(error.code, code, `${kind} mapped to the wrong code`);
    assert.equal(error.retryable, retryable, `${kind} has the wrong retryability`);
    assert.match(error.message, /overrideCode d78d/, 'the identifier a support question needs is carried');
    assert.ok(error.publicMessage && error.publicMessage.length > 40, `${kind} needs a sentence a person can act on`);
  }
});

test('a provider error from the driver is passed through unchanged', () => {
  // The driver may already have classified something better than this adapter can.
  const original = normalizeDuckDuckGoWebError(new DuckDuckGoWebError('quota', 'x'), 'duckduckgo-web');
  assert.equal(normalizeDuckDuckGoWebError(original, 'duckduckgo-web'), original);
});

test('the adapter does not claim to stream', async () => {
  // The answer is assembled from the service's stream and handed back once. Presenting that as a stream would
  // claim tokens arriving over time when none do — the same rule `gemini-web` follows.
  const adapter = new DuckDuckGoWebAdapter({ driver: driver() });
  assert.equal(adapter.capabilities.streaming, false);
  const chunks = [];
  for await (const chunk of adapter.streamChat(request())) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].delta.content, 'answered');
});

test('a health verdict says what it established', async () => {
  const adapter = new DuckDuckGoWebAdapter({ driver: driver() });
  const health = await adapter.healthCheck({ credential: { type: 'none' } });
  assert.equal(health.status, 'healthy');
  // `credential`, not `inference`: this reads the endpoint and solves a challenge, which is not the same claim
  // as "a model can answer".
  assert.equal(health.verified, 'credential');

  const noChallenge = new DuckDuckGoWebAdapter({ driver: driver({ async status() { return { challengeServed: false, solvedMs: 0 }; } }) });
  const degraded = await noChallenge.healthCheck({});
  assert.equal(degraded.status, 'degraded');
  assert.match(degraded.message ?? '', /challenge/);
});
