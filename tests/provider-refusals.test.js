import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A provider refusal must name its cause, and a gated one must not blame the key.
 *
 * ## What was wrong, and it was two layers
 *
 * Every free model on an `opencode` connection was refused with *"The provider refused the request."* —
 * a verdict with no cause, sent to a user whose next move is obviously "rotate my API key". The key was
 * fine. The cause was a request contract this adapter never sent (1.42.0), and behind that a network
 * restriction.
 *
 * The reasonless message was **not** only in the adapter. `FetchHttpTransport.stream` raises its own
 * `ProviderError` for a non-2xx *before* yielding an event, so the gate's refusal arrived as a throw that
 * never reached the adapter's handler. Fixed in the adapter with `captureGateRefusal`, and this test
 * asserts the seam: a refusal on the gated path must not be the transport's bare sentence.
 *
 * ## The property
 *
 * **A refusal whose cause is known must say it, and must not send the user to fix the credential.**
 * Enumerating adapters would let a new one appear unreviewed, so this scans the directory.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTERS = join(ROOT, 'packages/omnihilbras-sdk/src/adapters');

/** Strips comments, because a doc comment quoting a bad message is not code sending one. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('no adapter invents a refusal sentence with no cause', () => {
  // The sentence itself is the defect: it tells the user nothing and invites them to blame the key.
  const files = readdirSync(ADAPTERS).filter((file) => file.endsWith('.ts'));
  const offenders = files.filter((file) =>
    /['"`]The provider refused the request\.['"`]/.test(code(readFileSync(join(ADAPTERS, file), 'utf8'))),
  );
  assert.deepEqual(offenders, [], `${offenders.join(', ')} send a refusal with no cause`);
});

test('the Zen gated path catches the transport refusal, or the cause is lost one layer down', () => {
  // The seam. `transport.stream` throws before yielding, so without this the adapter's own message —
  // the one that says the key was accepted and names the network — is never reached.
  //
  // The check reads the **body of the wrapper**, not a window of characters after `catch`. My first
  // version used a 400-character window, and deleting the `gatedRefusal(...)` call from the middle of
  // the catch still passed — the window ran on and found the word in the *next* method's name. That is
  // the same guard bug as `health-surfaces`, and it means a window is not a place to look.
  const source = code(readFileSync(join(ADAPTERS, 'zen.ts'), 'utf8'));
  assert.match(source, /captureGateRefusal/, 'the gated stream is wrapped');

  const body = /private async \*captureGateRefusal\([^)]*\)[^{]*\{([\s\S]*?)\n  \}/.exec(source);
  assert.ok(body, 'captureGateRefusal has a body to inspect');
  assert.match(body[1], /catch\s*\(/, 'it catches');
  assert.match(body[1], /gatedRefusal\(/, 'and the caught transport error becomes the gated refusal — not the bare rethrow');
  assert.doesNotMatch(body[1], /\?\s*error\s*:\s*error\b/, 'a catch that returns the error unchanged defeats the wrapper');
});

test('a gated refusal clears the credential, because the key was accepted', () => {
  // Measured: the upstream answers 403 FreeTierError *after* the contract is satisfied. A message that
  // did not say so would send the user to rotate a working key, which is the mistake this release exists
  // to stop — and the mistake I made earlier in this session, from the other direction.
  const source = code(readFileSync(join(ADAPTERS, 'zen.ts'), 'utf8'));
  assert.match(source, /not a credential problem/i, 'the credential is explicitly cleared');
  assert.match(source, /datacenter networks/i, 'and the likely cause is named');
});

test('the gate is recognised by the provider\'s own wording, not by an assumed status', () => {
  // `providerErrorFromResponse` maps every 403 to `PROVIDER_REQUEST_FAILED` and attaches no
  // `statusCode`, so recognising the gate by status alone is impossible here. Matching the provider's
  // `FreeTierError` text is what keeps a 429 as `RATE_LIMITED` instead of collapsing every gated
  // refusal into one code that means nothing to the retry policy.
  const source = code(readFileSync(join(ADAPTERS, 'zen.ts'), 'utf8'));
  assert.match(source, /freetiererror\|free tier/i, 'the gate is matched on the upstream wording');
});

test('the free-tier gate is decided by suffix, not by a list that goes stale', () => {
  // The upstream rotates its free lineup; OmniRoute records six models delisted and replaced inside a
  // week. A hardcoded list would serve models that no longer exist and refuse ones that do.
  const source = code(readFileSync(join(ADAPTERS, 'zen.ts'), 'utf8'));
  assert.match(source, /\/-free\$\//, 'the suffix decides, so a new free model needs no release');
});

test('a caller\'s real tools are never displaced by the placeholder', () => {
  // The contract requires a non-empty `tools` array. Satisfying it by replacing a tool the caller
  // declared would trade a working request for a permitted one — and the tool would be missing from a
  // conversation that needs it.
  const source = code(readFileSync(join(ADAPTERS, 'zen.ts'), 'utf8'));
  assert.match(source, /request\.tools && request\.tools\.length > 0 \? request\.tools\.map\(toGatedTool\) : \[zenPlaceholderTool\(\)\]/,
    'the placeholder is a fallback, not an override');
});

test('the placeholder name is configuration, because the accepted names move over time', () => {
  // One made-up name was accepted on `big-pickle` and refused on two other free models the next day.
  // That is an observation about someone else's service, so it must not need a release to change.
  const source = readFileSync(join(ADAPTERS, 'zen-free-tier.ts'), 'utf8');
  assert.match(source, /OMNIHILBRAS_ZEN_PLACEHOLDER_TOOL/, 'the placeholder is overridable');
  assert.match(source, /OMNIHILBRAS_ZEN_USER_AGENT/, 'and so is the client version');
});
