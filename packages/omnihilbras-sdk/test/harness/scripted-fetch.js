import { deepSeekHashV1 } from '../../dist/providers/deepseek-web/deepseek-pow.js';

/**
 * A `fetch` double for adapters that inject one instead of a transport.
 *
 * `DeepSeekWebAdapter` takes `{ fetch }` and talks to four endpoints in a fixed order before it
 * produces an answer. An HTTP transport cannot stand in for it, because that adapter needs
 * `Response` objects it can *stream* from — `readBodyCapped` reads `response.body` as a stream and
 * refuses a body that grows past 8 MB. A harness that returned parsed JSON could not have exercised
 * it, and a pass that way would prove nothing.
 *
 * So this is a real `fetch` implementation, built from real `Response` objects, scripting all four.
 *
 * ## The fixture that is deliberately hostile
 *
 * Every completion frame is a **bare string append** — `{ p: 'response/fragments', v: { content } }`
 * with no `type` — because that is what live traffic carries, and because it is the case the adapter
 * previously got wrong: a decoder that only follows an explicit `type` returns the answer truncated
 * to its first character while every existing test still passed, because those tests asserted two
 * hand-written frame shapes the real service never sent.
 */

/**
 * The exact string the adapter hashes: `${salt}_${expire_at}_${nonce}`.
 *
 * A fixture cannot invent a solvable challenge. The solver tries `nonce` from `0` to `difficulty`
 * and compares the **whole digest** for equality, so the challenge a fixture serves has to be the
 * real hash of one of those nonces. Inventing `'fixture-challenge'` produced a challenge no nonce
 * could satisfy, and the adapter correctly reported *"no answer within the range it announced"* —
 * which reads like a provider problem and is really a fixture that did not do the arithmetic.
 */
const powInput = (salt, expireAt, nonce) => `${salt}_${expireAt}_${nonce}`;

/** DeepSeek wraps everything in `{ code, data: { biz_data } }`, and reads a non-zero code as a refusal. */
const biz = (bizData) => ({ code: 0, msg: '', data: { biz_data: bizData } });

export function scriptedFetch({ parts = ['Hello', ', ', 'world'], status = 200 } = {}) {
  const seen = [];
  // Read `state.status` everywhere below, never the `status` parameter. An earlier version closed
  // over the parameter, so `setStatus` changed nothing and the refusal tests all ran at 200 — which
  // is how a fixture bug presented as an adapter bug.
  const state = { parts, status };

  const impl = async (url, init = {}) => {
    const href = String(url);
    seen.push({ url: href, method: init.method ?? 'GET', headers: init.headers ?? {} });

    // 1. Exchange the long-lived user token for a short-lived access token.
    if (href.includes('/v0/users/current')) {
      return json(state.status, biz({ token: 'access-token-from-fixture' }));
    }

    // 2. A proof-of-work challenge. Difficulty 1 so the real solver finds a nonce immediately:
    //    the contract is about the adapter, not about hashing, and a slow fixture would make a
    //    pass depend on this machine's load.
    if (href.includes('/v0/chat/create_pow_challenge')) {
      // A proof-of-work challenge, *computed* rather than invented.
      //
      // The solver tries `nonce` from 0 to `difficulty` and compares the whole digest for
      // equality, so a fixture cannot invent a solvable challenge — it has to be the real hash of
      // one of those nonces. Difficulty 1 means nonce 0, which keeps the fixture instant and stops
      // a pass from depending on this machine's load. Inventing `'a'.repeat(64)` produced a
      // challenge no nonce could satisfy, and the adapter correctly said *"no answer within the
      // range it announced"*, which reads like a provider fault and is really a fixture that did
      // not do the arithmetic.
      const salt = 'fixture-salt';
      const expireAt = 0;
      return json(state.status, biz({
        challenge: {
          algorithm: 'DeepSeekHashV1',
          challenge: deepSeekHashV1(powInput(salt, expireAt, 0)),
          salt,
          difficulty: 1,
          signature: 'fixture-signature',
          target_path: '/api/v0/chat/completion',
          expire_at: expireAt,
        },
      }));
    }

    // 3. A chat session to hang the request on.
    if (href.includes('/v0/chat_session/create')) {
      return json(state.status, biz({ chat_session: { id: 'session-from-fixture' } }));
    }

    // 4. The completion, as a stream of `data:` lines.
    if (href.includes('/chat/completion')) {
      return new Response(deepSeekBody(state.parts), { status: state.status, headers: { 'content-type': 'text/event-stream' } });
    }

    return json(404, { code: 404, msg: `the fixture has no answer for ${href}` });
  };

  /** Sets the answer the next completion will stream, as bare string appends. */
  impl.set = (next) => { state.parts = next; };
  /**
   * Makes every call answer with one status, for the refusal tests.
   *
   * Every call, on purpose: a provider that refuses a credential refuses it at the first exchange,
   * so a fixture that let the sign-in through and refused only the completion would be modelling a
   * failure mode that does not exist.
   */
  impl.setStatus = (next) => { state.status = next; };
  impl.seen = seen;

  return impl;
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * DeepSeek's answer, as bare string appends and nothing else.
 *
 * No `type` on any fragment, which is the whole point: the adapter has to carry an untyped append
 * to whichever side it was last told about, and the first fragment in this stream is not the first
 * character of the answer.
 */
function deepSeekBody(parts) {
  const lines = [];
  for (const content of parts) {
    lines.push(`data: ${JSON.stringify({ p: 'response/fragments', v: { content } })}`);
  }
  // `FINISHED` is a status, not an answer. It is checked before the string branch in the decoder
  // precisely so it cannot be appended — a decoder that appended it would show every answer
  // ending in the word FINISHED.
  lines.push(`data: ${JSON.stringify({ p: 'response/status', v: 'FINISHED' })}`);
  return lines.join('\n\n') + '\n\n';
}
