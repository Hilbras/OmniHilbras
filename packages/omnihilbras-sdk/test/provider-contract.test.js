import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { scriptedFetch } from './harness/scripted-fetch.js';
import { scriptedDriver, chatGptWebFixtureCredential, CHATGPT_WEB_CONTRACT_MODEL } from './harness/scripted-driver.js';
import test from 'node:test';
import { runProviderContract, CONTRACT_TEXT } from './provider-contract.js';
import { framesFor, scriptedTransport } from './harness/scripted-transport.js';
import { OpenAIAdapter } from '../dist/adapters/openai.js';
import { OpenRouterAdapter } from '../dist/adapters/openrouter.js';
import { OpenAICompatibleAdapter } from '../dist/adapters/openai-compatible.js';
import { AnthropicAdapter } from '../dist/adapters/anthropic.js';
import { GeminiAdapter } from '../dist/adapters/gemini.js';
import { DeepSeekWebAdapter } from '../dist/adapters/deepseek-web.js';
import { ChatGptWebAdapter } from '../dist/adapters/chatgpt-web.js';
import { ClineAdapter } from '../dist/adapters/cline.js';
import { KiroAdapter } from '../dist/adapters/kiro.js';
import { KimiCodeAdapter } from '../dist/adapters/kimi-code.js';
import { OpencodeConsoleAdapter } from '../dist/adapters/opencode-console.js';
import { ZenAdapter } from '../dist/adapters/zen.js';
import { ProviderRegistry } from '../dist/registry.js';
import { ProviderError } from '../dist/errors.js';

/**
 * The contract, run against every adapter that can be driven offline.
 *
 * The registry's own guard is tested first and separately, because it is the one place the Core is
 * allowed to *refuse* a bad adapter — and a guard that has never been seen to fire is a guard
 * nobody can rely on.
 */

/**
 * The harness *is* the transport. It is not wrapped here, and the first version wrapped it:
 * `request` was delegated but `stream` was stubbed as an empty generator, so every streaming
 * assertion failed with "the provider stream ended before completion" for five providers. That
 * reads exactly like five provider bugs and was entirely the wrapper's doing.
 */
const transport = (wireFormat) => {
  const stub = scriptedTransport({ wireFormat });
  return { stub, transport: stub };
};

/** Each provider supplies only the wire shape; the contract owns every assertion. */
const providers = [
  {
    name: 'openai',
    make: () => {
      const { stub, transport: t } = transport('openai');
      return { adapter: new OpenAIAdapter({ transport: t }), script: (parts, options) => { stub.set(parts, options); return async () => {}; } };
    },
  },
  {
    name: 'openrouter',
    make: () => {
      const { stub, transport: t } = transport('openai');
      return { adapter: new OpenRouterAdapter({}, { transport: t }), script: (parts, options) => { stub.set(parts, options); return async () => {}; } };
    },
  },
  {
    name: 'openai-compatible',
    make: () => {
      const { stub, transport: t } = transport('openai');
      const adapter = new OpenAICompatibleAdapter({ id: 'contract', name: 'Contract', baseUrl: 'https://example.invalid/v1' }, { transport: t });
      return { adapter, script: (parts, options) => { stub.set(parts, options); return async () => {}; } };
    },
  },
  {
    name: 'anthropic',
    make: () => {
      const { stub, transport: t } = transport('anthropic');
      return { adapter: new AnthropicAdapter({ transport: t }), script: (parts, options) => { stub.set(parts, options); return async () => {}; } };
    },
  },
  {
    // Kimi Code's `/coding/v1` endpoints speak the OpenAI shape — chat, stream and models — so the
    // contract applies unchanged rather than being excused. Its account host (device code, token,
    // refresh) is form-encoded and is *not* the OpenAI wire format, so those calls are covered by
    // `kimi-code.test.js` against a scripted transport instead.
    name: 'kimi-code',
    make: () => {
      const { stub, transport: t } = transport('openai');
      return { adapter: new KimiCodeAdapter({ transport: t }), script: (parts, options) => { stub.set(parts, options); return async () => {}; } };
    },
  },
  {
    name: 'cline',
    make: () => {
      const { stub, transport: t } = transport('openai');
      return { adapter: new ClineAdapter({ transport: t }), script: (parts, options) => { stub.set(parts, options); return async () => {}; } };
    },
  },
  {
    name: 'kiro',
    make: () => {
      const { stub, transport: t } = transport('openai');
      return { adapter: new KiroAdapter({ transport: t }), model: 'claude-sonnet-5', script: (parts, options) => { stub.set(parts, options); return async () => {}; } };
    },
  },
  {
    name: 'opencode-console',
    make: () => {
      const { stub, transport: t } = transport('console');
      return { adapter: new OpencodeConsoleAdapter({ transport: t }), model: 'contract-model', script: (parts, options) => { stub.set(parts, options); return async () => {}; } };
    },
  },
  {
    name: 'zen',
    make: () => {
      const { stub, transport: t } = transport('openai');
      return { adapter: new ZenAdapter({ transport: t }), script: (parts, options) => { stub.set(parts, options); return async () => {}; } };
    },
  },
  {
    name: 'deepseek-web',
    make: () => {
      // A `fetch` double, not a transport. Its four-endpoint flow is scripted in full, because an
      // adapter that needs a proof of work and a chat session cannot be exercised by returning
      // parsed JSON — and a pass that way would prove nothing about either.
      const fetchImpl = scriptedFetch();
      return {
        adapter: new DeepSeekWebAdapter({ fetch: fetchImpl }),
        // An api-key, because that is what a DeepSeek Web connection holds: the userToken
        // DeepSeekWeb parses out of localStorage, wrapped by deepSeekWebCredential.
        credential: { type: 'api-key', value: 'fixture-user-token' },
        script: (parts, options) => {
          fetchImpl.set(parts);
          if (options?.refuseWith !== undefined) fetchImpl.setStatus(options.refuseWith);
          return async () => { fetchImpl.setStatus(200); };
        },
        // A fixed catalog, like Kiro's: the contract cannot ask for it and be believed.
        model: 'deepseek-v4-pro',
      };
    },
  },
  {
    name: 'chatgpt-web',
    make: () => {
      // A browser driver, not a transport. There is no HTTP request to intercept here, so the
      // driver interface *is* the seam, and a transport-shaped harness could not have stood in
      // for it at all.
      const driver = scriptedDriver();
      return {
        adapter: new ChatGptWebAdapter({ driver }),
        credential: chatGptWebFixtureCredential(),
        model: CHATGPT_WEB_CONTRACT_MODEL,
        script: (parts, options) => {
          driver.set(parts);
          if (options?.refuseWith !== undefined) {
            // The page refusing is a plain Error from the driver; the adapter's job is to turn it
            // into a ProviderError the router can classify, and that is what the refusal
            // assertions are checking.
            driver.setThrow(new Error('The page said the session is no longer signed in.'));
          }
          return async () => { driver.setThrow(undefined); };
        },
      };
    },
  },
  {
    name: 'gemini',
    make: () => {
      const { stub, transport: t } = transport('gemini');
      return { adapter: new GeminiAdapter({ transport: t }), script: (parts, options) => { stub.set(parts, options); return async () => {}; } };
    },
  },
];

for (const provider of providers) {
  const { adapter, script, model, credential } = provider.make();
  runProviderContract({
    name: provider.name,
    adapter,
    script,
    credential,
    // Only a provider that cannot be *asked* for its catalog nominates one; the rest let the
    // contract ask, so a change to a catalog does not require editing this file.
    ...(model ? { model } : {}),
  });
}

/* ------------------------------------------------------------------ *
 * Adapters the contract does not yet reach, and why
 * ------------------------------------------------------------------ */

/**
 * The coverage gap, named rather than omitted.
 *
 * `deepseek-web` and `chatgpt-web` inject `{ fetch }` and `{ driver }` rather than a transport,
 * so they need a different harness. Listing them here means the gap is visible in the test output
 * and grows loudly when an eleventh adapter arrives — an adapter silently missing from the
 * contract is how a class of bug reaches production unnoticed, which is the whole failure this
 * suite was written to prevent.
 */
/**
 * Adapters the contract does not yet reach.
 *
 * Empty on purpose. When it is not, every entry must say why, and adding a new adapter to the SDK
 * fails this suite until it is either contracted or accounted for. The entries this list has held —
 * `deepseek-web` needing its four-endpoint `fetch` flow, `chatgpt-web` needing a browser-driver
 * double — were both resolved by a harness that speaks the provider's real protocol rather than by
 * a looser assertion.
 */
const NOT_YET_CONTRACTED = {};

test('an adapter that can tell when a credential expired never throws and never guesses', () => {
  // The value of `isCredentialExpired` is entirely in what it *refuses* to claim. An adapter that
  // answered `false` for a credential it could not read would turn its own uncertainty into a
  // confident "still valid", and the gateway would then send a request that cannot succeed — which
  // for a ChatGPT Web connection means launching a browser.
  //
  // So the contract pins what holds for **any** credential shape: it does not throw, it returns one
  // of three answers, and a credential it cannot read comes back `undefined` rather than a guess.
  //
  // It deliberately does *not* assert "a past expiry is expired" here, because a contract cannot
  // know each provider's credential shape — a ChatGPT Web credential is a JSON storage state, not
  // an OAuth record, and feeding one the other's shape is exactly the kind of plausible-looking
  // fixture that proves a test rather than a fact. Those assertions live with the adapters that own
  // the shape, and the gateway's lifecycle test makes them for both of the current ones.
  const UNREADABLE = [
    { type: 'oauth', value: 'not a shape this adapter reads' },
    { type: 'api-key', value: 'k' },
    { type: 'none' },
    undefined,
  ];
  let checked = 0;
  for (const provider of providers) {
    const { adapter } = provider.make();
    if (typeof adapter.isCredentialExpired !== 'function') continue;
    checked += 1;
    for (const credential of UNREADABLE) {
      const verdict = adapter.isCredentialExpired(credential);
      const what = JSON.stringify(credential);
      assert.ok(verdict === true || verdict === false || verdict === undefined, `${provider.name} returned ${String(verdict)} for ${what}`);
      // "Cannot say" and never "not expired": only the first of the two guesses is safe.
      assert.equal(verdict, undefined, `${provider.name} guessed ${String(verdict)} for a credential it cannot read`);
    }
    // An expiry it cannot parse is also "cannot say", for the same reason.
    assert.equal(adapter.isCredentialExpired({ type: 'oauth', value: 'x', expiresAt: 'not-a-date' }), undefined, `${provider.name} guessed at an unreadable expiry`);
  }
  assert.ok(checked > 0, 'at least one adapter implements the pre-check, or this test proves nothing');
});

test('the contract knows which adapters it does not cover, and says why', () => {
  const covered = new Set(providers.map((provider) => provider.name));
  for (const [id, reason] of Object.entries(NOT_YET_CONTRACTED)) {
    assert.ok(reason.length > 20, `${id} is listed without saying why it is not covered`);
    assert.equal(covered.has(id), false, `${id} is listed as uncovered but is in the suite`);
  }
});

test('every adapter in the SDK is either contracted or listed as not', () => {
  // The point of the list above: an adapter cannot be added and forgotten. This reads the
  // adapter directory, so a new one without a contract fails here rather than passing quietly.
  const files = readdirSync(new URL('../src/adapters/', import.meta.url))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .map((file) => file.replace(/\.ts$/, ''))
    // Not adapters: `deepseek-pow` is a proof-of-work solver, `chatgpt-first-party` is the
    // first-party client behind the ChatGPT Web driver, `qwen-web` is a probe, and `zen-free-tier`
    // is the free-tier request contract that `zen` uses — a rule about a request, not a provider.
    //
    // Each exclusion needs its reason here, because a bare name in this list is how a real adapter
    // stops being contracted without anything saying so.
    .filter((id) => !['deepseek-pow', 'chatgpt-first-party', 'qwen-web', 'zen-free-tier'].includes(id));
  const known = new Set([...providers.map((provider) => provider.name), ...Object.keys(NOT_YET_CONTRACTED)]);
  const missing = files.filter((file) => !known.has(file));
  assert.deepEqual(missing, [], `adapters with neither a contract nor a stated reason: ${missing.join(', ')}`);
});

/* ------------------------------------------------------------------ *
 * The registry's guard
 * ------------------------------------------------------------------ */

test('an adapter that declares a capability it does not implement is refused at registration', () => {
  // This is the invariant the whole contract rests on: routing dispatches on the flag, so a flag
  // without a method is a crash the first time the flag is trusted. The Core has to catch it at
  // the door, not at the request.
  const lying = { id: 'liar', name: 'Liar', capabilities: { chat: true, streaming: true, models: false }, chat: async () => ({}) };
  assert.throws(() => new ProviderRegistry().register(lying), /streaming/i);
});

test('a model adapter with no listModels is refused at registration', () => {
  const lying = { id: 'liar', name: 'Liar', capabilities: { chat: false, streaming: false, models: true } };
  assert.throws(() => new ProviderRegistry().register(lying), /models/i);
});

test('an adapter with no id is refused at registration', () => {
  assert.throws(() => new ProviderRegistry().register({ id: '  ', name: 'x', capabilities: {} }), /id/i);
});

test('two adapters cannot claim the same id', () => {
  const registry = new ProviderRegistry();
  const adapter = { id: 'same', name: 'Same', capabilities: {} };
  registry.register(adapter);
  assert.throws(() => registry.register(adapter), /already registered/i);
});

/* ------------------------------------------------------------------ *
 * The harness itself
 * ------------------------------------------------------------------ */

test('the harness serves a multi-part answer as separate frames', async () => {
  // If the harness joined the parts into one frame, every assertion built on it would be testing
  // a joined string — and a decoder that drops everything after the first frame would pass. The
  // fixture has to be hostile for the assertion to mean anything.
  const frames = framesFor({ url: 'https://example.invalid/v1/chat/completions' }, ['a', 'b', 'c'], 'openai');
  const contentFrames = frames.filter((frame) => frame.includes('"content"'));
  assert.ok(contentFrames.length === 3, `expected one frame per part, got ${contentFrames.length}`);
  const reassembled = contentFrames
    .map((frame) => JSON.parse(frame.replace(/^data: /, '').trim()).choices[0].delta.content)
    .join('');
  assert.equal(reassembled, 'abc');
});

test('the harness can express a refusal that arrives as HTTP 200 with a refusal in the body', async () => {
  // Qwen does exactly this on both origins, and a harness that could only express an HTTP error
  // would have hidden an entire class of provider behaviour. The refusal has to survive the
  // transport untouched, because whether the adapter notices it is the thing under test.
  const stub = scriptedTransport();
  stub.set(['a'], { refuseWith: { status: 200, body: { ret: ['FAIL_SYS_USER_VALIDATE'] } } });
  const response = await stub.request({ url: 'https://example.invalid/v1/chat/completions', method: 'POST', headers: {}, body: '{}' });
  assert.equal(response.status, 200, 'a 200 refusal must not be turned into a transport error by the harness');
  assert.deepEqual(response.data.ret, ['FAIL_SYS_USER_VALIDATE']);
});

test('the harness classifies a real HTTP refusal the way the transport does', async () => {
  // Duplicated rather than shared with the transport on purpose: a double that shares the
  // implementation it stands in for cannot catch a bug in it, and this mapping decides whether a
  // connection is ejected.
  const stub = scriptedTransport();
  stub.set(['a'], { refuseWith: 401 });
  await assert.rejects(
    () => stub.request({ url: 'https://example.invalid/v1/chat/completions', method: 'POST', headers: {}, body: '{}' }),
    (error) => error.code === 'AUTHENTICATION_FAILED' && error.statusCode === 401,
  );
});

test('a bare status and a shaped refusal mean the same thing', () => {
  // `{ refuseWith: 401 }` is the obvious thing to write, and reading only `.status` off a number
  // yields undefined and then 200 — so a refusal test silently asserted that a refusal works.
  const bare = scriptedTransport();
  bare.set(['a'], { refuseWith: 401 });
  const shaped = scriptedTransport();
  shaped.set(['a'], { refuseWith: { status: 401 } });
  assert.equal(bare.seen.length, 0);
  assert.equal(shaped.seen.length, 0);
  return Promise.all([
    bare.request({ url: 'https://x.invalid/v1/chat/completions', method: 'POST', headers: {}, body: '{}' }).catch((e) => e.code),
    shaped.request({ url: 'https://x.invalid/v1/chat/completions', method: 'POST', headers: {}, body: '{}' }).catch((e) => e.code),
  ]).then(([a, b]) => assert.equal(a, b));
});

test('a Gemini chat URL is not mistaken for the catalog', () => {
  // Gemini embeds the model name in the path, so a naive `/models` test answered a chat with a
  // model list and the adapter reported "missing a candidate" — a failure that named the provider
  // and was entirely the harness's fault.
  const stub = scriptedTransport({ wireFormat: 'gemini' });
  stub.set(['a', 'b']);
  return stub.request({ url: 'https://generativelanguage.googleapis.com/v1beta/models/contract-model:generateContent', method: 'POST', headers: {}, body: '{}' }).then((response) => {
    assert.ok(Array.isArray(response.data.candidates), 'a generateContent request must be answered with a candidate, not a model list');
  });
});

test('the contract answer is awkward on purpose', () => {
  // A tidy fixture proves nothing. The trailing lone space and the shared prefixes are there so
  // that trimming per frame, deduplicating, or dropping empties each show up as a failure.
  assert.ok(CONTRACT_TEXT.endsWith(' '), 'the last part is a lone space, so per-frame trimming loses it');
  assert.equal(CONTRACT_TEXT, 'Hello, world — a ');
  assert.ok(new Set(CONTRACT_TEXT.split('')).size > 3, 'the parts must not be trivially interchangeable');
});

test('ProviderError is the shape routing depends on', () => {
  const error = new ProviderError('AUTHENTICATION_FAILED', 'nope', { publicMessage: 'nope' });
  assert.equal(error.name, 'ProviderError');
  assert.equal(error.code, 'AUTHENTICATION_FAILED');
  assert.ok(error instanceof Error, 'routing catches Error, so it must be one');
});
