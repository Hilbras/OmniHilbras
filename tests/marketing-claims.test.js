import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The marketing page claims only what the product does.
 *
 * ## What was claimed, and what is true
 *
 * `src/App.tsx` is the **marketing entry** — `main.tsx` renders `<App />`, and the dashboard has its own
 * entries. Under the heading *"No black box — See the decision, not just the answer"*, it said:
 *
 * > Every request should tell you where it went, why it went there, **and what it cost**. OmniHilbras
 * > makes routing observable by default.
 * >
> > - **Live request traces** — Follow a request from policy to provider and back.
 * > - **Useful metrics** — Track latency, retries, **spend**, and provider health.
 *
 * And it illustrated all of it with a panel: `18.4k` requests, `412 ms` p95, `99.98%` success, four
 * hardcoded request rows, an animated green dot labelled **live**, the caption "last 15 minutes · all
 * routes", and the footer "Updated just now".
 *
 * Measured against the product:
 *
 * | Claim | True? | Why |
 * | --- | --- | --- |
 * | Live request traces | **no** | the gateway keeps no request log and no trace. `request-context.ts` says so: "Not telemetry, and not a trace." |
 * | …and what it cost / spend | **no** | there is no cost accounting anywhere in the gateway. The only `cost` occurrences are the word in prose comments. |
 * | Useful metrics | partly | provider health and per-provider latency are real and polled; aggregate request counts and spend are not. |
 * | Human-readable reasons | **yes** | `RouteSkipReason` is `disabled`, `no-credential`, `unhealthy`, `rate-limited`, `no-models` — real, and routing records which one applied. |
 *
 * The two true claims were the interesting part, because they are *better* claims than the false ones.
 * This product refuses to swallow a cause: every failure has a named error code, every skip has a named
 * reason, and a failed health check stops the provider being chosen. That is a stronger thing to sell
 * than a request trace, and it is the thing that is actually built.
 *
 * ## What this file is, honestly
 *
 * **A list, not a proof.** Each entry is a claim that was false when written, with the reason recorded,
 * asserted absent from the page. A *new* false claim phrased differently would not be caught here — that
 * needs a human reading the page against the code, and this file is the record of what the last reading
 * found. The one check in this suite that is mechanical is the `live` badge in
 * `dashboard-truthfulness.test.js`: a liveness badge is a claim about a feed, and there is no feed.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKETING = join(ROOT, 'src', 'App.tsx');

/** Every `.ts` file under a directory, as source text. */
function readAll(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return readAll(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [readFileSync(full, 'utf8')] : [];
  });
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Claims that were on this page and are not true of this product.
 *
 * The `because` is the part that matters. Without it this list is a superstition; with it, it is a set of
 * findings somebody can re-verify — and re-verifying is how a claim stops being folklore.
 */
const FALSE_CLAIMS = {
  'live request traces': 'the gateway keeps no request log and no trace; request-context.ts states "Not telemetry, and not a trace."',
  'request trace': 'same: there is no per-request record to trace.',
  'what it cost': 'there is no cost accounting in the gateway, so no response can state a cost.',
  spend: 'no cost accounting exists; the only "cost" in the gateway is the word in prose comments.',
  'request activity': 'the panel that carried this heading reported hardcoded numbers and is gone.',
  'last 15 minutes': 'a time window implies a rolling feed; nothing on this page is fed.',
  'updated just now': 'nothing on the page updates, so a freshness claim is a claim about a poller that does not exist.',
};

test('the page claims nothing it cannot back', () => {
  const page = stripComments(readFileSync(MARKETING, 'utf8')).toLowerCase();
  const present = Object.entries(FALSE_CLAIMS).filter(([claim]) => page.includes(claim));
  assert.deepEqual(
    present.map(([claim]) => claim),
    [],
    `the marketing page says ${present.map(([c]) => `"${c}"`).join(', ')}, which the product does not do. ` +
      'Either build it or stop claiming it. A landing page that overstates the product is the same ' +
      'defect as a card that shows invented metrics, aimed at people who cannot check.',
  );
});

test('every recorded claim carries a reason, so the list is findings rather than folklore', () => {
  for (const [claim, because] of Object.entries(FALSE_CLAIMS)) {
    assert.ok(because.length > 30, `"${claim}" has no usable reason: ${JSON.stringify(because)}`);
  }
  assert.ok(Object.keys(FALSE_CLAIMS).length >= 6, 'the list should record what the last reading found');
});

test('the claims that replaced them are the ones the product can back', () => {
  // The other direction, so the fix is not just subtraction. Each of these names something that
  // exists in the code, which is what makes the page a claim about this product rather than a category.
  const page = stripComments(readFileSync(MARKETING, 'utf8')).toLowerCase();
  for (const claim of ['request id', 'named reasons', 'health that changes routing']) {
    assert.ok(page.includes(claim), `the page should still say "${claim}" — it is true, and it is the better claim`);
  }
  // Recursive: the request-id line is in `src/routes/inference.ts`, and a scan that only reads the
  // top level would have reported the marketing page as wrong when the gateway is the one that is
  // right. A check that cannot see the code it is checking is worse than no check.
  const gateway = readAll(join(ROOT, 'apps', 'gateway', 'src')).join('\n');
  for (const [what, evidence] of [
    ['the request id on every response', /gateway:\s*\{\s*requestId:/],
    ['the named skip reasons', /type RouteSkipReason =/],
    ['health changing routing', /reason: 'unhealthy'/],
  ]) {
    assert.match(gateway, evidence, `"${what}" is on the marketing page but not in the gateway — one of the two is wrong`);
  }
});

test('THE COUNT, asserted so the list cannot be quietly emptied', () => {
  // An allowlist that shrinks is a hole: deleting an entry because it is inconvenient leaves no trace
  // that the claim was ever false.
  assert.equal(Object.keys(FALSE_CLAIMS).length, 7, `the recorded-claims list now has ${Object.keys(FALSE_CLAIMS).length} entries`);
  console.log(`    recorded false claims: ${Object.keys(FALSE_CLAIMS).length}   present on the page: 0`);
});
