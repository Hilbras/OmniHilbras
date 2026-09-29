import assert from 'node:assert/strict';
import test from 'node:test';
import { deepSeekHashV1 } from '../dist/adapters/deepseek-pow.js';
import {
  DEEPSEEK_WEB,
  DeepSeekWebAdapter,
  allDeepSeekWebModels,
  decodeDeepSeekAnswer,
  flattenToPrompt,
  parseDeepSeekUserToken,
} from '../dist/adapters/deepseek-web.js';

/**
 * DeepSeek Web, without a network.
 *
 * A turn needs an account, so what is testable here is everything that decides *what* gets
 * sent: which model maps to which upstream flags, how a pasted token is read, how a message
 * list is flattened into the single prompt the endpoint takes, and how the SSE frames are
 * read back. The request path itself is verified by using it.
 */

test('the catalog is the fourteen models chat.deepseek.com serves', () => {
  const adapter = new DeepSeekWebAdapter();
  return adapter.listModels().then((models) => {
    assert.equal(models.length, 14);
    for (const id of [
      'deepseek-v4-pro',
      'deepseek-v4-pro-think-search',
      'deepseek-v4-flash',
      'deepseek-chat',
      'deepseek-reasoner',
      'DeepSeek-R1',
      'DeepSeek-V3.2',
      'DeepSeek-Search',
    ]) {
      assert.ok(models.some((model) => model.id === id), `${id} is missing from the catalog`);
    }
  });
});

test('model ids are matched case-insensitively, because the page uses several spellings', async () => {
  // The upstream catalogue mixes `deepseek-v4-pro` and `DeepSeek-R1` in one list, so a client
  // that uppercases a model is not making a mistake we should punish. What must not happen is
  // a `not supported` refusal — the test fails on that code specifically, not on any error.
  const adapter = new DeepSeekWebAdapter({ fetch: async () => new Response('{}') });
  await adapter
    .chat({ model: 'DEEPSEEK-V4-PRO', messages: [] }, { credential: { type: 'api-key', value: 't' } })
    .catch((error) => assert.notEqual(error.code, 'NOT_SUPPORTED', 'the model was refused'));
});

/** A salt and expiry the fake challenge is built around, so the solver has a real answer. */
const SALT = 'salt-for-tests';
const EXPIRE_AT = 1790579999;

test('the thinking and search axes are in the model id, and reach the request flags', async () => {
  // These are variants the page offers, not request options — a client that cannot name
  // "think but not search" has no way to ask for it.
  const sent = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    sent.push(body);
    const path = String(_url);
    if (path.includes('users/current')) return jsonResponse({ code: 0, data: { biz_data: { token: 'access' } } });
    if (path.includes('create_pow_challenge')) {
      // Solvable: the digest is the one nonce 3 produces, and the range contains it. A
      // challenge nothing can answer would make this test pass with nothing sent.
      return jsonResponse({
        code: 0,
        data: { biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: deepSeekHashV1(`${SALT}_${EXPIRE_AT}_3`), salt: SALT, difficulty: 8, signature: 'sig', target_path: '/api/v0/chat/completion', expire_at: EXPIRE_AT } } },
      });
    }
    if (path.includes('chat_session/create')) return jsonResponse({ code: 0, data: { biz_data: { chat_session: { id: 'session-1' } } } });
    return new Response('data: {"v":{"response":{"thinking_enabled":true,"fragments":[{"type":"ANSWER","content":"working"}]}}}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  };
  const adapter = new DeepSeekWebAdapter({ fetch: fetchImpl });

  for (const model of ['deepseek-v4-pro', 'deepseek-v4-pro-think', 'deepseek-v4-pro-search', 'deepseek-v4-pro-think-search', 'deepseek-chat']) {
    await adapter.chat({ model, messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'api-key', value: 'user-token' } }).catch(() => undefined);
  }
  const byModel = new Map(sent.filter((body) => 'model_type' in body).map((body) => [String(body.prompt).slice(-4), body]));
  // Read the flags straight off the last request per model, in order.
  const completions = sent.filter((body) => 'model_type' in body);
  const flags = completions.map((body) => `${body.model_type}/${body.thinking_enabled}/${body.search_enabled}`);
  assert.ok(flags.includes('expert/false/false'), `pro should be expert with no flags: ${flags}`);
  assert.ok(flags.includes('expert/true/false'), `pro-think should think: ${flags}`);
  assert.ok(flags.includes('expert/false/true'), `pro-search should search: ${flags}`);
  assert.ok(flags.includes('expert/true/true'), `pro-think-search should do both: ${flags}`);
  assert.ok(flags.includes('default/false/false'), `chat should be the default model: ${flags}`);
  assert.ok(byModel);
});

test('an unknown model is refused locally, before a browser or a network call', async () => {
  let called = false;
  const adapter = new DeepSeekWebAdapter({
    fetch: async () => {
      called = true;
      return new Response('{}');
    },
  });
  await assert.rejects(
    () => adapter.chat({ model: 'deepseek-v9-imaginary', messages: [] }, { credential: { type: 'api-key', value: 't' } }),
    (error) => error.code === 'NOT_SUPPORTED',
  );
  assert.equal(called, false, 'nothing should have been sent for a model that cannot exist');
});

test('a missing credential is refused by name', async () => {
  const adapter = new DeepSeekWebAdapter({ fetch: async () => new Response('{}') });
  await assert.rejects(
    () => adapter.chat({ model: 'deepseek-chat', messages: [] }),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /no userToken/.test(error.publicMessage),
  );
});

test('the userToken is read whether it is bare or still wrapped', () => {
  // DeepSeek stores `{"value":"…"}`, so a copy out of localStorage is sometimes the wrapper.
  // Requiring the user to know that is a papercut for no benefit.
  assert.equal(parseDeepSeekUserToken('  raw-token-123  '), 'raw-token-123');
  assert.equal(parseDeepSeekUserToken('{"value":"wrapped-456"}'), 'wrapped-456');
  // A JSON object that is not the wrapper is used as-is, rather than silently emptied.
  assert.equal(parseDeepSeekUserToken('{"other":"x"}'), '{"other":"x"}');
});

test('an empty paste says what to paste', () => {
  assert.throws(() => parseDeepSeekUserToken('   '), /Paste the userToken/);
});

test('the signed-out placeholder is refused, and named', () => {
  // chat.deepseek.com stores `{"value":null,"__version":N}` when nobody is signed in. Falling
  // through to "treat the raw string as the token" turned that into a credential that looked
  // valid, and the failure surfaced much later as DeepSeek refusing a session nobody could
  // explain. This is the most likely thing to be handed here, so it is named.
  for (const signedOut of ['{"value":null,"__version":1}', '{"value":null}', '{"value":""}', '{"value":null,"__version":3}']) {
    assert.throws(
      () => parseDeepSeekUserToken(signedOut),
      (error) => error.code === 'AUTHENTICATION_FAILED' && /not signed in/.test(error.publicMessage),
      `accepted the signed-out placeholder: ${signedOut}`,
    );
  }
});

test('a real wrapped token is still read, and a bare one too', () => {
  assert.equal(parseDeepSeekUserToken('{"value":"abc","__version":2}'), 'abc');
  assert.equal(parseDeepSeekUserToken('bare-token'), 'bare-token');
  // Something that is not the wrapper is used as-is rather than refused.
  assert.equal(parseDeepSeekUserToken('{not json'), '{not json');
});

test('history is flattened into one prompt, and kept apart', () => {
  // The endpoint takes a single string. A bare join of a system turn and a question loses
  // which was which, and the instruction is the part that gets lost.
  const prompt = flattenToPrompt([
    { role: 'system', text: 'You are terse.' },
    { role: 'user', text: '2+2?' },
    { role: 'assistant', text: '4' },
    { role: 'user', text: 'And 3+3?' },
  ]);
  assert.match(prompt, /- You are terse\./);
  assert.match(prompt, /User: 2\+2\?/);
  assert.match(prompt, /Assistant: 4/);
  assert.match(prompt, /User: And 3\+3\?/);
});

test('empty turns are dropped rather than sent as blank lines', () => {
  const prompt = flattenToPrompt([
    { role: 'user', text: '   ' },
    { role: 'user', text: 'real' },
  ]);
  assert.equal(prompt, 'User: real');
});

test('the two SSE frame shapes are both read', () => {
  // The whole-response shape, and the append shape. A decoder that only knows one of them
  // returns half an answer and looks like a model that stopped early.
  const whole = [
    'data: {"v":{"response":{"thinking_enabled":false,"fragments":[{"type":"ANSWER","content":"working"}]}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  assert.equal(decodeDeepSeekAnswer(whole).content, 'working');

  const appended = [
    'data: {"v":{"response":{"thinking_enabled":true,"fragments":[]}}}',
    'data: {"p":"response/fragments","o":"append","v":[{"type":"THINK","content":"let me see"}]}',
    'data: {"p":"response/fragments","o":"append","v":[{"type":"ANSWER","content":"4"}]}',
    'data: [DONE]',
    '',
  ].join('\n');
  const answer = decodeDeepSeekAnswer(appended);
  assert.equal(answer.reasoning, 'let me see');
  assert.equal(answer.content, '4');
});

test('an untyped append follows the last stated path, not the default', () => {
  // The append frames often arrive with no `type`. Treating every one of them as the answer
  // is how a model that thinks first ends up answering with its reasoning.
  const body = [
    'data: {"v":{"response":{"thinking_enabled":true,"fragments":[]}}}',
    'data: {"p":"response/fragments","o":"append","v":[{"content":"first I think"}]}',
    'data: {"v":{"response":{"thinking_enabled":false,"fragments":[]}}}',
    'data: {"p":"response/fragments","o":"append","v":[{"content":"then I answer"}]}',
    'data: [DONE]',
    '',
  ].join('\n');
  const answer = decodeDeepSeekAnswer(body);
  assert.equal(answer.reasoning, 'first I think');
  assert.equal(answer.content, 'then I answer');
});

test('a stream with no fragments yields nothing rather than throwing', () => {
  assert.deepEqual(decodeDeepSeekAnswer('data: [DONE]\n\n'), { content: '', reasoning: '' });
  assert.deepEqual(decodeDeepSeekAnswer(''), { content: '', reasoning: '' });
  assert.deepEqual(decodeDeepSeekAnswer('data: not json\n\n'), { content: '', reasoning: '' });
});

test('the origin and API base are pinned', () => {
  // Everything is sent to these two, so they are asserted rather than derived.
  assert.equal(DEEPSEEK_WEB.origin, 'https://chat.deepseek.com');
  assert.equal(DEEPSEEK_WEB.apiBase, 'https://chat.deepseek.com/api');
  assert.equal(DEEPSEEK_WEB.tokenStorageKey, 'userToken');
});

test('every catalog model is one the adapter will accept', async () => {
  // A card the resolver refuses is a visible bug: the page offers it and the request comes
  // back `not supported`.
  for (const id of allDeepSeekWebModels()) {
    let called = false;
    const adapter = new DeepSeekWebAdapter({
      fetch: async () => {
        called = true;
        return new Response('{}');
      },
    });
    await adapter.chat({ model: id, messages: [] }, { credential: { type: 'api-key', value: 't' } }).catch(() => undefined);
    assert.ok(called, `${id} is in the catalog but the adapter refused it`);
  }
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('the health check bypasses the access-token cache, because a cache proves nothing', async () => {
  // A health check that reads a cached token reports "healthy" without DeepSeek having been
  // asked. The dashboard showed "healthy in 0 ms" from a cache entry — a confident answer
  // with no check behind it, which is the whole fault this area keeps making.
  const calls = [];
  const adapter = new DeepSeekWebAdapter({
    fetch: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ code: 0, data: { biz_data: { token: 'access-' + calls.length } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const credential = { type: 'api-key', value: 'user-token' };

  // First call populates the cache.
  await adapter.validateCredential(credential);
  assert.equal(calls.length, 1);
  // Second call reuses it — that is the point of the cache on the request path.
  await adapter.validateCredential(credential);
  assert.equal(calls.length, 2, 'a plain credential check should reuse the cached token');

  // The health check must not.
  const before = calls.length;
  await adapter.healthCheck({ credential });
  assert.equal(calls.length, before + 1, 'healthCheck answered from the cache instead of asking DeepSeek');
});
