import assert from 'node:assert/strict';
import test from 'node:test';
import { QWEN_WEB_MODELS, parseQwenCookieHeader, probeQwenWeb, qwenWebProviderId } from '../dist/providers/qwen-web/index.js';
import { ProviderError } from '../dist/core/errors.js';

/**
 * Qwen Web, without a network.
 *
 * What is testable here is the decision logic: reading a pasted cookie, and reading Qwen's
 * refusals. The refusals are the whole reason this file exists, because **Qwen signals every
 * refusal in the body and never in the status code** — a check that trusted the status would
 * report a guest cookie as a working credential, which is exactly what the first version did.
 */

const ORIGIN = 'https://auth.qwen.ai';
const CHAT = 'https://chat.qwen.ai';

/** A transport that answers each URL from a table, and records what was asked. */
function transport(table) {
  const asked = [];
  return {
    asked,
    async request({ url, method, headers, body }) {
      asked.push({ url, method, cookie: headers?.cookie, body });
      const entry = table[url];
      if (typeof entry === 'function') return entry({ url, method, headers, body });
      if (!entry) throw new ProviderError('PROVIDER_UNAVAILABLE', `no answer for ${url}`);
      if (entry.status && (entry.status < 200 || entry.status >= 300)) {
        throw new ProviderError('AUTHENTICATION_FAILED', `HTTP ${entry.status}`, { publicMessage: entry.detail ?? `HTTP ${entry.status}` });
      }
      return { status: entry.status ?? 200, headers: new Headers(), data: entry.data };
    },
  };
}

const MODELS_BODY = { success: true, data: { data: [{ id: 'qwen3.7-plus' }, { id: 'qwen3.8-max' }] } };

/** A signed-in-looking response from the auth origin. */
const AUTH_OK = { status: 200, data: { success: true, data: { user: { id: 'u1' } } } };

test('a pasted cookie header is read, and a request line is refused as a request line', () => {
  assert.deepEqual(parseQwenCookieHeader('a=1; b=2'), { a: '1', b: '2' });
  assert.throws(
    () => parseQwenCookieHeader('GET /api/v2/auths/ HTTP/1.1'),
    (error) => error.code === 'INVALID_REQUEST' && /request line/i.test(error.publicMessage),
  );
  assert.throws(() => parseQwenCookieHeader('   '), /Paste the Cookie header/);
  assert.throws(() => parseQwenCookieHeader('no equals here'), /no name=value pairs/);
});

test('an unauthenticated credential is recognised from the body, not the status', async () => {
  // The trap: `auth.qwen.ai` answers a guest with HTTP 200 and
  // `{"success":false,"data":{"code":"Unauthorized"}}`. Trusting the status is what made a guest
  // cookie report as `authenticated: true`.
  const probe = await probeQwenWeb('cna=x', transport({
    [`${ORIGIN}/api/v2/auths/`]: { status: 200, data: { success: false, data: { code: 'Unauthorized', details: '401 Unauthorized' } } },
    [`${CHAT}/api/v2/models/`]: { status: 200, data: MODELS_BODY },
    [`${CHAT}/api/v2/chat/completions`]: { status: 200, data: { ret: ['FAIL_SYS_USER_VALIDATE'] } },
  }));
  assert.equal(probe.authenticated, false);
  assert.match(probe.authDetail, /Unauthorized/);
});

test('a bot-protected turn is reported as refused, with the provider’s own words', async () => {
  const probe = await probeQwenWeb('cna=x', transport({
    [`${ORIGIN}/api/v2/auths/`]: AUTH_OK,
    [`${CHAT}/api/v2/models/`]: { status: 200, data: MODELS_BODY },
    [`${CHAT}/api/v2/chat/completions`]: { status: 200, data: { ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'], data: { url: 'https://chat.qwen.ai/api/v2/chat/completions/_____tmd_____/punish?x5secdata=…' } } },
  }));
  assert.equal(probe.turnServed, false, 'HTTP 200 with a refusal in the body is a refusal');
  assert.match(probe.detail, /FAIL_SYS_USER_VALIDATE/);
  assert.match(probe.detail, /RGV587/);
});

test('a served turn is reported as served, and nothing else is invented', async () => {
  const probe = await probeQwenWeb('cna=x', transport({
    [`${ORIGIN}/api/v2/auths/`]: AUTH_OK,
    [`${CHAT}/api/v2/models/`]: { status: 200, data: MODELS_BODY },
    [`${CHAT}/api/v2/chat/completions`]: { status: 200, data: { id: 'c1', choices: [{ message: { content: 'hi' } }] } },
  }));
  assert.equal(probe.turnServed, true);
  assert.equal(probe.authenticated, true);
  assert.deepEqual(probe.models, ['qwen3.7-plus', 'qwen3.8-max']);
});

test('the model catalog is reported even when the credential is not', async () => {
  // Qwen serves its models to guests, which is why the catalog on the card is real while the
  // provider cannot answer. A probe that reported nothing on a bad credential would hide that.
  const probe = await probeQwenWeb('cna=x', transport({
    [`${ORIGIN}/api/v2/auths/`]: { status: 200, data: { success: false, data: { code: 'Unauthorized' } } },
    [`${CHAT}/api/v2/models/`]: { status: 200, data: MODELS_BODY },
    [`${CHAT}/api/v2/chat/completions`]: { status: 200, data: { ret: ['FAIL_SYS_USER_VALIDATE'] } },
  }));
  assert.deepEqual(probe.models, ['qwen3.7-plus', 'qwen3.8-max']);
});

test('the probe asks the models endpoint before the turn, so the turn names a real model', async () => {
  const t = transport({
    [`${ORIGIN}/api/v2/auths/`]: AUTH_OK,
    [`${CHAT}/api/v2/models/`]: { status: 200, data: MODELS_BODY },
    [`${CHAT}/api/v2/chat/completions`]: { status: 200, data: { ret: [] } },
  });
  await probeQwenWeb('cna=x', t);
  const turn = t.asked.find((call) => call.url.endsWith('/chat/completions'));
  // Hard-coding a model id would go stale the day Qwen renames one, and the request would then
  // fail for a reason that has nothing to do with the credential being tested.
  assert.match(turn.body, /qwen3\.7-plus/);
  assert.equal(turn.cookie, 'cna=x');
});

test('every catalog model is named for the provider, so routing can attribute a turn', () => {
  assert.ok(QWEN_WEB_MODELS.length > 0);
  for (const model of QWEN_WEB_MODELS) {
    assert.equal(model.providerId, qwenWebProviderId, `${model.id} is not attributed`);
    assert.ok(model.id.trim().length > 0);
  }
  assert.equal(new Set(QWEN_WEB_MODELS.map((m) => m.id)).size, QWEN_WEB_MODELS.length, 'duplicate model id');
});

test('the probe cannot wait forever: it has a budget and says what it got', async () => {
  // "Ask Qwen" with no outcome is indistinguishable from a broken button, and the three requests
  // to a host on another continent are exactly the kind that stall. The budget turns a hang into
  // an answer, and the answers gathered so far are returned rather than thrown away — a slow auth
  // origin with a fast refusal on the turn is still a useful answer.
  let calls = 0;
  const stalling = {
    async request() {
      calls += 1;
      return new Promise((_, reject) => {
        // Never settles on its own; only the abort below can end it.
        setTimeout(() => reject(new ProviderError('PROVIDER_TIMEOUT', 'stalled')), 5_000).unref?.();
      });
    },
  };
  const probe = await probeQwenWeb('cna=x', stalling, undefined, { timeoutMs: 120 });
  assert.equal(calls, 3, 'the auth, catalog and turn are all asked');
  assert.equal(probe.turnServed, false);
  assert.ok(probe.detail.length > 0, 'a stalled probe must still report a reason');
  assert.equal(probe.authenticated, false);
});

test('the three questions do not queue behind each other', async () => {
  // Sequential requests cost three round trips. The auth origin and the model catalog are
  // independent, so they are asked together and only the turn waits for a model id.
  const order = [];
  const t = transport({
    [`${ORIGIN}/api/v2/auths/`]: () => { order.push('auth'); return { status: 200, headers: new Headers(), data: AUTH_OK.data }; },
    [`${CHAT}/api/v2/models/`]: () => { order.push('models'); return { status: 200, headers: new Headers(), data: MODELS_BODY }; },
    [`${CHAT}/api/v2/chat/completions`]: () => { order.push('turn'); return { status: 200, headers: new Headers(), data: { ret: [] } }; },
  });
  await probeQwenWeb('cna=x', t);
  assert.ok(order.indexOf('models') < order.indexOf('turn'), 'the turn must wait for the catalog, since it names a model from it');
  assert.equal(order.length, 3);
});
