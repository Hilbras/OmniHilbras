import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/**
 * The plan's own risk table, checked rather than believed.
 *
 * `tasks/plan.md` carries, as the mitigation for its only **High** risk — *"Provider APIs change
 * independently"* — this sentence:
 *
 * > Keep adapters isolated, use official API documentation, and **pin response fixtures per
 * > adapter.**
 *
 * Measured, there are **four** pinned fixtures for **fourteen** adapters. `kiro-stream.bin` is a real
 * captured binary eventstream, with tests asserting both the answer it decoded to and the frame names
 * the service really sends. Since 1.48.0 there are three more — `openrouter`, `cline` and
 * `opencode-console` — captured from the providers themselves, all three of them **model listings**, so
 * the total cost was nothing.
 *
 * The remaining ten are accounted for by a stated reason, and the count is asserted so the two cannot
 * drift apart. Eight of those ten need a credential this machine does not have: `openai`,
 * `openai-compatible`, `anthropic`, `gemini`, `zen`, `zen-free-tier`, `kimi-code` and `claude-code`.
 * `chatgpt-web` and `deepseek-web` are browser DOM sessions, where a byte capture pins nothing useful.
 *
 * ## Why one of eleven is a problem and not a detail
 *
 * The provider contract suite does not cover this, and the two are not substitutes. The contract
 * suite proves an adapter satisfies an *invariant* — text survives the round trip, a refusal is a
 * `ProviderError`. A pinned fixture proves the adapter still understands **that provider's wire
 * format**. When DeepSeek renames a frame key, the contract still passes, and the first sign is a
 * broken request in production.
 *
 * That is not hypothetical. Earlier in this work, DeepSeek Web's own tests asserted two
 * hand-written frame shapes, passed, and shipped — while live traffic used bare-string appends, and
 * the adapter was silently truncating every answer to one character. The tests agreed with the
 * test's author. A pinned capture is the thing that would have caught it.
 *
 * ## What this guard does and deliberately does not do
 *
 * It does **not** manufacture fixtures. A fabricated capture is worse than no capture: it is
 * indistinguishable from a real one in every review, and it is the exact artefact that hid the
 * DeepSeek bug for as long as it existed. So an adapter with no real capture must **say so**, and
 * the reason is recorded — and a new adapter cannot be added without being asked.
 *
 * This is the same discipline as the contract's coverage guard, which has paid for itself several
 * times over: an unclaimed gap is a silent one, and a silent gap is how a class of bug reaches
 * production unnoticed.
 */

const FIXTURES = new URL('./fixtures/', import.meta.url);

const ADAPTERS = readdirSync(new URL('../src/adapters/', import.meta.url))
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .map((file) => file.replace(/\.ts$/, ''))
  // `deepseek-pow` solves a hash rather than speaking a protocol, `chatgpt-first-party` is the
  // browser driver behind ChatGPT Web, and `qwen-web` is a probe with no completion path.
  .filter((id) => !['deepseek-pow', 'chatgpt-first-party', 'qwen-web'].includes(id));

/**
 * Adapters with no pinned real capture, and why.
 *
 * Each entry is a claim that can be wrong, in a file a reviewer reads. Adding one is cheap;
 * adding one carelessly is the failure this whole guard exists to prevent.
 */
const NO_CAPTURE_YET = {
  'openai-compatible': 'the shape is the SSE other adapters also produce; a capture would pin OpenAI\'s framing specifically',
  openai: 'shares the OpenAI-compatible wire format, so a capture here would duplicate that one',
  anthropic: 'its frames are hand-written in `anthropic.test.js`; no real capture was taken',
  gemini: 'its frames are hand-written in `gemini.test.js`; no real capture was taken',
  'chatgpt-web': 'the protocol is a browser DOM rather than a wire format, so a byte capture would pin nothing useful',
  'deepseek-web': 'its frames are hand-written in `deepseek-web.test.js`, and that is how a real truncation bug survived',
  zen: 'a composite of other providers\' protocols; a capture would pin the composite, not a provider',
  // The free-tier contract is four request conditions measured against someone else's service on a
  // date, and it changes: the working implementation in OmniRoute records the accepted placeholder
  // tool name moving between models within a week. A byte capture would freeze one day of it and
  // then be wrong, which is the reason the two moving parts are configuration and not constants.
  'zen-free-tier': 'the gate is a request contract measured on a date and it drifts; pinning a capture would pin the drift',
  // Kimi Code is **not** excused for cost. Its `/coding/v1/models` listing is free and needs no paid
  // call, and it is exactly the capture the guard exists to encourage — the reason it is absent is
  // that the endpoint answers only to a credential this machine does not have. A subscription token
  // is per-account, so the capture has to wait for a signed-in one rather than be skipped as expensive.
  //
  // Saying "no capture yet, needs a credential" is the claim the guard asks for; the alternative —
  // manufacturing one from a scripted transport — is the artefact that hid the DeepSeek bug.
  'kimi-code': 'its models listing needs a Kimi Code subscription token this machine does not have; the listing itself is free, so this is a credential gap rather than a cost one',
  // Claude Code is the same shape as Kimi Code and is excused the same way. `/v1/models` is a free,
  // authenticated read, so the capture costs nothing — it is absent only because this machine holds no
  // Claude subscription grant to read it with, and `claude-code.test.js` asserts the decode against a
  // scripted transport instead of claiming a capture that was never taken.
  'claude-code': 'its `/v1/models` listing needs a Claude subscription OAuth grant this machine does not have; the listing itself is free, so this is a credential gap rather than a cost one',
  // Token Harbor Web is a named-event SSE body over a Supabase session cookie. The catalog is
  // read from the `/models` page, not an endpoint, so the only captureable bytes are a live
  // `direct-chat/stream` body — which needs a signed-in session this machine does not have, and
  // which its terms do not permit proxying in the first place. The frames are transcribed from
  // the client bundle in `scripted-tokenharbor-fetch.js` rather than invented.
  'tokenharbor-web': 'the only captureable bytes are a live direct-chat/stream body, which needs a signed-in Token Harbor session this machine has no credential for; the frames come from that service\'s own client bundle',
};

test('the fixtures directory holds only captures, named for the adapter they came from', () => {
  const files = readdirSync(FIXTURES);
  for (const file of files) {
    const named = ADAPTERS.some((id) => file.startsWith(id));
    assert.ok(named, `${file} does not name the adapter it captured, so nobody will know what to do when it breaks`);
  }
  assert.ok(files.length > 0, 'and the directory is not empty — a guard over nothing guards nothing');
});

test('a pinned capture is actually asserted, not just filed', () => {
  // A capture nobody decodes is a file that rots. Kiro's is decoded by two tests; that is the
  // shape every future capture should take.
  for (const file of readdirSync(FIXTURES)) {
    const referenced = readdirSync(new URL('./', import.meta.url))
      .filter((test) => test.endsWith('.test.js'))
      .some((test) => readFileSync(new URL(test, import.meta.url), 'utf8').includes(file));
    assert.ok(referenced, `${file} is pinned but no test reads it`);
  }
});

test('every adapter either has a pinned capture or says why it does not', () => {
  const pinned = new Set(readdirSync(FIXTURES).map((file) => ADAPTERS.find((id) => file.startsWith(id))).filter(Boolean));
  const unaccounted = ADAPTERS.filter((id) => !pinned.has(id) && !(id in NO_CAPTURE_YET));
  assert.deepEqual(unaccounted, [], `adapters with neither a pinned capture nor a stated reason: ${unaccounted.join(', ')}`);
});

test('a stated reason is a reason, not a shrug', () => {
  // Every entry has to say something a reviewer could disagree with, or the list becomes a place
  // to record "todo" and thereby hide the work.
  for (const [id, reason] of Object.entries(NO_CAPTURE_YET)) {
    assert.ok(ADAPTERS.includes(id), `${id} is listed but is not an adapter`);
    assert.ok(reason.length > 30, `${id} has a reason too short to argue with: ${JSON.stringify(reason)}`);
  }
});

test('THE COUNT, asserted so it cannot drift quietly', () => {
  // The number is the finding. It is asserted rather than merely recorded so that adding a capture
  // has to update it, and so that a future reader sees the real figure rather than having to count again.
  //
  // 1 of 12 in 1.32.0 → **4 of 12** in 1.48.0: `openrouter`, `cline` and `opencode-console` were captured
  // for real. All three are **model listings**, so the total cost was nothing — no tokens, no billing.
  //
  // The capture is a *shape*, not a snapshot. OpenRouter's full `/models` response is 1,286,456 bytes of a
  // catalog that changes daily; the committed fixture pins every key and its type and keeps five ids, so
  // a renamed field fails the test while a new model does not churn the file. Two files were written and
  // deleted first: one that captured our own normalised `{"connection": {...}}` instead of the provider's
  // bytes, and one that recorded a single-element array because `opencode-console` has no `data` array to
  // slice — a capture that looked like coverage and asserted nothing.
  const pinned = readdirSync(FIXTURES).length;
  const accounted = ADAPTERS.length - Object.keys(NO_CAPTURE_YET).length;
  assert.equal(pinned, accounted, `fixtures on disk (${pinned}) and adapters with a capture (${accounted}) disagree`);
  assert.ok(pinned >= 1, 'at least one real capture exists, so the mitigation is real for someone');
  // The honest headline, which will change when someone takes more captures.
  console.log(`    pinned real captures: ${pinned} of ${ADAPTERS.length} adapters`);
});
