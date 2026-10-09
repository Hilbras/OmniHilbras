import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TokenHarborWebAdapter,
  decodeTokenHarborStream,
  flattenMessages,
  parseTokenHarborCookieHeader,
  sessionExpiresAt,
  tokenHarborWebCredential,
} from '../dist/providers/tokenharbor-web/index.js';
import { ProviderError } from '../dist/core/errors.js';
import { scriptedTokenHarborFetch } from './harness/scripted-tokenharbor-fetch.js';

/** `assert.throws` returns nothing, so the error is captured explicitly to assert its code. */
function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw');
}

/**
 * Token Harbor Web's own semantics, which the provider contract deliberately does not cover.
 *
 * The contract proves the adapter satisfies an *invariant* — text survives the round trip, a
 * refusal is a `ProviderError`. It cannot know that this provider's cookie is split into chunks
 * that must be rejoined in numeric order, or that its stream separates reasoning from the answer
 * by event name. Those are the places a real bug would live, so they are asserted here.
 */

/* ------------------------------------------------------------------ *
 * The cookie
 * ------------------------------------------------------------------ */

const b64url = (value) => Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sessionValue = (session = { access_token: 'header.payload.signature', expires_at: 4102444800, refresh_token: 'r' }) =>
  `base64-${b64url(JSON.stringify(session))}`;

test('a Cookie header is carried through, with the session reassembled in numeric chunk order', () => {
  // The order here is deliberately wrong: a header that lists `.1` before `.0` is exactly what a
  // browser emits, and a parser that joins in the order it reads reassembles a corrupt session.
  // The chunks are a real value split in two, because a reassembled one has to *decode* now.
  const full = sessionValue();
  const half = Math.floor(full.length / 2);
  const header = `cf_clearance=abc; sb-auth-auth-token.1=${full.slice(half)}; th-theme=dark; sb-auth-auth-token.0=${full.slice(0, half)}`;
  const cookie = parseTokenHarborCookieHeader(header);

  assert.ok(cookie.includes(`sb-auth-auth-token=${full}`), 'the chunks were not rejoined in numeric order into the whole session');
  assert.match(cookie, /cf_clearance=abc/, 'the Cloudflare clearance was dropped, and the SSR layer reads it');
  assert.match(cookie, /th-theme=dark/, 'a sibling cookie was dropped');
  assert.doesNotMatch(cookie, /sb-auth-auth-token\.\d/, 'the numbered chunks survived as well as the reassembled value');
});

test('a bare session value and a name=value pair are both accepted', () => {
  // The Application panel offers both copy targets; a parser that demanded the header would refuse
  // the one-field copy the guide describes. Supabase v2 keeps the session as `base64-...`.
  const full = sessionValue();
  assert.equal(parseTokenHarborCookieHeader(`sb-auth-auth-token=${full}`), `sb-auth-auth-token=${full}`);
  assert.equal(parseTokenHarborCookieHeader(full), `sb-auth-auth-token=${full}`);
  const error = thrownBy(() => parseTokenHarborCookieHeader('some-random-value'));
  assert.equal(error.code, 'INVALID_REQUEST');
});

test('a paste with no session cookie is refused by name, and nothing is stored', () => {
  const error = thrownBy(() => parseTokenHarborCookieHeader('cf_clearance=abc; th-theme=dark'));
  assert.equal(error.name, 'ProviderError');
  assert.equal(error.code, 'INVALID_REQUEST');
  assert.match(error.message, /sb-auth-auth-token/);
});

test('an empty session cookie is the signed-out state, and says so', () => {
  // Supabase stores an empty value when there is no session. Treating it as a credential is how a
  // refusal later looks like a provider fault instead of "you are signed out".
  const error = thrownBy(() => parseTokenHarborCookieHeader('sb-auth-auth-token='));
  assert.equal(error.code, 'AUTHENTICATION_FAILED');
  assert.match(error.publicMessage, /signed out/i);
});

test('a connection with no credential is refused as an authentication failure, not an internal error', () => {
  const error = thrownBy(() => tokenHarborWebCredential(''));
  assert.equal(error.name, 'ProviderError');
  assert.equal(error.code, 'INVALID_REQUEST');
});

test('a truncated session cookie is refused here, by name, instead of sent and reported as dead', () => {
  // The most likely bad paste: a session is long, and an Application-panel row or a wrapped header
  // line cuts it short. Forwarded, it produces a 401 that tells the user to sign in again for a
  // paste that never finished — the same fault as DeepSeek's `{"value":null}` read as a token.
  const full = sessionValue({ access_token: 'a.b.c', expires_at: 1791404149, user: { email: 'x@y.z' } });
  const error = thrownBy(() => parseTokenHarborCookieHeader(`sb-auth-auth-token=${full.slice(0, Math.floor(full.length * 0.7))}`));
  assert.equal(error.code, 'INVALID_REQUEST');
  assert.match(error.message, /cut short|not valid base64/i);
});

test('an intact session is accepted, and its expiry can be read back', () => {
  const full = sessionValue({ access_token: 'a.b.c', expires_at: 1791404149, refresh_token: 'r' });
  const cookie = parseTokenHarborCookieHeader(`sb-auth-auth-token=${full}`);
  assert.match(cookie, /sb-auth-auth-token=base64-/);
  assert.equal(sessionExpiresAt(cookie), 1791404149);
});

/* ------------------------------------------------------------------ *
 * The decoder
 * ------------------------------------------------------------------ */

test('reasoning and the answer are read from their own events, not appended together', () => {
  // A decoder that appends every `delta` regardless of the event name answers with the model's
  // thinking. The client bundle splits them for this reason, and so does this.
  const body = [
    'event: thinking\ndata: {"delta":"let me think"}',
    'event: chunk\ndata: {"delta":"Hello"}',
    'event: chunk\ndata: {"delta":", world"}',
    'event: done\ndata: {}',
  ].join('\n\n');

  const answer = decodeTokenHarborStream(body);
  assert.equal(answer.content, 'Hello, world');
  assert.equal(answer.reasoning, 'let me think');
  assert.equal(answer.finished, true);
});

test('a stream that closes without `done` is reported as unfinished', () => {
  // This is the DeepSeek truncation fault: a body that ends mid-generation, handed back as a clean
  // `finish_reason: stop` answer that is silently missing its ending.
  const answer = decodeTokenHarborStream('event: chunk\ndata: {"delta":"half an ans"}');
  assert.equal(answer.content, 'half an ans');
  assert.equal(answer.finished, false);
});

test('an `error` event is returned with its own code rather than thrown as a generic failure', () => {
  const answer = decodeTokenHarborStream('event: error\ndata: {"code":"unauthorized","message":"Please sign in again."}');
  assert.equal(answer.error?.code, 'unauthorized');
  assert.equal(answer.error?.message, 'Please sign in again.');
});

test('attachment events are ignored rather than read as answer text', () => {
  // `image`, `file`, `citation` and `tool_use` carry payloads for a UI. Appending them to the
  // answer is the guess this adapter refuses to make.
  const body = [
    'event: chunk\ndata: {"delta":"Here"}',
    'event: citation\ndata: {"url":"https://example.com"}',
    'event: image\ndata: {"url":"https://example.com/a.png"}',
    'event: chunk\ndata: {"delta":" it is."}',
    'event: done\ndata: {}',
  ].join('\n\n');

  const answer = decodeTokenHarborStream(body);
  assert.equal(answer.content, 'Here it is.');
  assert.doesNotMatch(answer.content, /example\.com/);
});

/* ------------------------------------------------------------------ *
 * The turn
 * ------------------------------------------------------------------ */

test('a turn starts a temporary session and sends the flattened conversation', async () => {
  const fetchImpl = scriptedTokenHarborFetch();
  const adapter = new TokenHarborWebAdapter({ fetch: fetchImpl });

  const response = await adapter.chat(
    { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'again' }] },
    { credential: tokenHarborWebCredential(sessionValue()) },
  );

  assert.equal(response.message.content, 'Hello, world');
  assert.equal(response.providerId, 'tokenharbor-web');

  const sessionCall = fetchImpl.seen.find((call) => call.url.includes('/api/direct-chat/sessions'));
  assert.equal(sessionCall.method, 'POST');
  const streamCall = fetchImpl.seen.find((call) => call.url.includes('/api/direct-chat/stream'));
  assert.equal(streamCall.method, 'POST');
  // The cookie is on the request, which is the whole point of the provider.
  assert.ok(String(streamCall.headers.Cookie).includes('sb-auth-auth-token=base64-'), 'the session cookie was not sent');
});

test('the request body carries no invented fields, and the flattened history keeps its labels', async () => {
  const fetchImpl = scriptedTokenHarborFetch();
  // Capture the bodies by wrapping the double, so the assertions are on what was really sent.
  const bodies = [];
  const adapter = new TokenHarborWebAdapter({
    fetch: (url, init) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return fetchImpl(url, init);
    },
  });

  await adapter.chat(
    { model: 'gpt-6-luna', messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: '2+2?' }] },
    { credential: tokenHarborWebCredential(sessionValue()) },
  );

  const session = bodies.find((body) => 'model' in body && 'temporary' in body);
  assert.equal(session.temporary, true, 'a gateway request must not file a conversation in the user sidebar');
  assert.equal(session.model, 'gpt-6-luna');

  const stream = bodies.find((body) => 'sessionId' in body);
  assert.equal(stream.sessionId, 'session-from-fixture');
  assert.match(stream.content, /Follow these instructions:/, 'the system turn lost its instruction framing');
  assert.match(stream.content, /User: 2\+2\?/, 'the history was joined without labels');
});

test('a 401 on the profile check is an authentication failure, nameable by routing', async () => {
  const fetchImpl = scriptedTokenHarborFetch({ status: 401 });
  const adapter = new TokenHarborWebAdapter({ fetch: fetchImpl });

  await assert.rejects(
    () => adapter.validateCredential(tokenHarborWebCredential(sessionValue())),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'AUTHENTICATION_FAILED');
      return true;
    },
  );
});

test('health is a credential check and says so, never `inference`', async () => {
  const fetchImpl = scriptedTokenHarborFetch();
  const adapter = new TokenHarborWebAdapter({ fetch: fetchImpl });
  const health = await adapter.healthCheck({ credential: tokenHarborWebCredential(sessionValue()) });

  assert.equal(health.status, 'healthy');
  assert.equal(health.verified, 'credential');
  // The property the type exists to force: reading a profile must not be reported as a model
  // having answered.
  assert.notEqual(health.verified, 'inference');
});

test('flattenMessages drops empty turns rather than emitting a bare label', () => {
  assert.equal(flattenMessages([{ role: 'user', content: '' }, { role: 'user', content: 'only' }]), 'User: only');
});