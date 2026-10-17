import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { CHALLENGE_STUBS } from '../dist/duckduckgoChallengeStubs.js';
import {
  CHALLENGE_MARKERS,
  duckDuckGoFeSignals,
  duckDuckGoFeVersion,
  duckDuckGoJourneyId,
  sha256Base64,
  solveDuckDuckGoChallenge,
} from '../dist/duckduckgoChallenge.js';

/**
 * The `x-vqd-hash-1` solver, and the shape of the string it runs.
 *
 * ## What is at stake if this is wrong
 *
 * An unsolved challenge is not a no-op: the service answers `418 ERR_CHALLENGE` and the wasted call still
 * counts against the address's anonymous-chat quota. So a solver that "mostly works" is worse than one that
 * refuses, because each failure costs budget on a rate-limited endpoint. That is why every refusal here is
 * named, and why the properties below are asserted rather than left to the code that consumes them.
 *
 * ## The one thing `pnpm typecheck` cannot see
 *
 * `CHALLENGE_STUBS` is a `String.raw` template compiled by `vm.runInContext` in **script mode**. A stray
 * `export` or `import` inside it is a run-time `SyntaxError` — the compiler never looks at it, nothing fails
 * at build time, and every request fails afterwards. The first test is that assertion, and it is the reason
 * this file exists at all.
 */

test('the stub template is valid script-mode JavaScript', () => {
  // Asserted over the *template*, which is what the vm compiles. A backtick would terminate the literal
  // early and a module keyword would be a SyntaxError the compiler cannot report.
  assert.equal(CHALLENGE_STUBS.includes('`'), false, 'a backtick inside the template ends it early');
  assert.doesNotMatch(CHALLENGE_STUBS, /(^|\n)\s*(export|import)\b/, 'script mode has no import/export');
  assert.ok(CHALLENGE_STUBS.length > 10_000, `the shim set looks truncated at ${CHALLENGE_STUBS.length} bytes`);

  // And it must actually parse, in the same mode the solver uses.
  const stubs = CHALLENGE_STUBS.replace('__DDG_REAL_UA__', '"probe"').replace('__DDG_HTML_LOOKUP__', '{}');
  const context = createContext({});
  runInContext(stubs, context, { timeout: 5_000 });
});

test('the only bare placeholders are the two the solver substitutes', () => {
  // `window.__DDG_BE_VERSION__` and `window.__DDG_FE_CHAT_HASH__` match the same shape and are **not**
  // placeholders: they are properties the window shim defines, because the page's own bundle reads them as
  // own-properties to decide whether it is on the real site. The stub sets both to `1` and the live service
  // accepted that — five solved challenges — so they are left exactly as the working implementation has them.
  //
  // The distinction that matters is bare versus member-or-key, so this looks for occurrences that would
  // evaluate as an identifier. A *third* bare placeholder would be a `ReferenceError` at run time, inside a
  // string, on a path that costs rate budget to reach.
  const bare = [...CHALLENGE_STUBS.matchAll(/(?<![\w.'"$])__DDG_[A-Z_]+__(?=[\s;,)\]}]|$)/g)].map((match) => match[0]);
  assert.deepEqual(
    [...new Set(bare)].sort(),
    ['__DDG_HTML_LOOKUP__', '__DDG_REAL_UA__'],
    'the template names a placeholder the solver does not replace',
  );
});

test('an unsolvable challenge is refused by name, never sent', () => {
  // Both directions matter: a challenge that is not base64 at all, and one that decodes to nothing. Neither
  // may reach the `vm`, and neither may be forwarded.
  return Promise.all([
    assert.rejects(() => solveDuckDuckGoChallenge('not base64 at all !!', 'ua'), /base64|decoded to nothing/),
    assert.rejects(() => solveDuckDuckGoChallenge(Buffer.from('   ', 'utf8').toString('base64'), 'ua'), /decoded to nothing/),
    assert.rejects(
      () => solveDuckDuckGoChallenge(Buffer.from('(async function(){ return {}; })()', 'utf8').toString('base64'), 'ua'),
      /no client hashes/,
      'JavaScript that runs but returns no hashes must be refused, not sent empty',
    ),
  ]);
});

test('a solved challenge carries every marker the service checks for', async () => {
  // A minimal stand-in for the served challenge: it returns the three fields the real one does, computed
  // against the shims, which is enough to assert the shape of what comes back. The live challenge is
  // exercised by the probe recorded in `tasks/todo.md`, not here — it needs the network.
  const script = `(async function(){
    const hashes = ['probe-one', 'probe-two'];
    return { client_hashes: hashes, server_hashes: [], meta: { v: 'probe' } };
  })()`;
  const solved = await solveDuckDuckGoChallenge(Buffer.from(script, 'utf8').toString('base64'), 'probe-agent');

  const decoded = JSON.parse(Buffer.from(solved.header, 'base64').toString('utf8'));
  for (const marker of CHALLENGE_MARKERS) {
    assert.ok(marker in decoded, `the solved payload has no ${marker}`);
  }
  assert.equal(decoded.client_hashes.length, 2);
  // Hashes are re-encoded, so what is sent is not what the challenge returned verbatim.
  assert.notEqual(decoded.client_hashes[0], 'probe-one');
  assert.equal(decoded.client_hashes[0], sha256Base64('probe-one'));
  // The three fields the source records as required or the service answers 418 regardless of the hashes.
  assert.equal(decoded.meta.origin, 'https://duck.ai');
  assert.ok(Array.isArray(decoded.meta.stack) && decoded.meta.stack.length > 0);
  assert.match(decoded.meta.duration, /^\d+$/);
  assert.ok(solved.elapsedMs >= 0);
});

test('the version token is assembled, because it is not contiguous in the page', () => {
  // The defect this encodes: the source searched the homepage for one `serp_...-<hex>` string and never found
  // it — they are two attributes — so every request carried a version from an earlier release. A stale
  // version is worse than none, because it looks like a measurement.
  const html = '<html lang="en-US" data-version-tag="serp_20261016_162040_ET" data-version-sha="69b477470b6e1e9a59d7b38f6a2ba83ab3fdd747" class="react">';
  assert.equal(duckDuckGoFeVersion(html), 'serp_20261016_162040_ET-69b477470b6e1e9a59d7b38f6a2ba83ab3fdd747');

  // And the assembled value is what the pattern the source wanted would have matched, which is the proof it
  // is the right token rather than a plausible string.
  assert.match(duckDuckGoFeVersion(html), /^serp_\d{8}_\d{6}_[A-Z]{2}-[0-9a-f]{20,40}$/);

  // Missing either attribute is "cannot say", never a fallback: the caller refuses the turn instead.
  assert.equal(duckDuckGoFeVersion('<html data-version-tag="serp_20261016_162040_ET">'), undefined);
  assert.equal(duckDuckGoFeVersion('<html data-version-sha="abc">'), undefined);
  assert.equal(duckDuckGoFeVersion('<html>'), undefined);
});

test('the telemetry and journey id are well-formed, and different each time', () => {
  const signals = JSON.parse(Buffer.from(duckDuckGoFeSignals(), 'base64').toString('utf8'));
  assert.match(signals.start.toString(), /^\d{13}$/);
  assert.ok(signals.events.length > 0, 'a timeline with no events is not a timeline');
  assert.equal(signals.meta.origin, 'https://duck.ai');

  assert.match(duckDuckGoJourneyId(), /^[0-9a-f]{32}$/);
  assert.notEqual(duckDuckGoJourneyId(), duckDuckGoJourneyId(), 'a reused journey id is a reused session');
});

test('the solver file keeps the shim out of the shipped gateway bundle by construction', () => {
  // A guard against a future "tidy-up" that imports the template without the substitutions, or inlines the
  // shims into the driver: `duckduckgoChallenge.ts` is the only module that may read them.
  const readers = readFileSync(new URL('../src/duckduckgoChallenge.ts', import.meta.url), 'utf8');
  assert.match(readers, /import \{ CHALLENGE_STUBS \}/, 'the solver must import the template');
  assert.match(readers, /__DDG_REAL_UA__[\s\S]*__DDG_HTML_LOOKUP__/, 'both placeholders must be substituted');
});