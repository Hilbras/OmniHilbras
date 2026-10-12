import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * The usage page's charts must not draw a measurement that was never taken.
 *
 * The page's oldest rule — from the store that made this page possible — is that a missing measurement is
 * shown as *missing*, never as `0`. The cards obey it (`tokensUnmeasured`, `cost.unpricedEntirely`). The
 * charts are a second surface where the same mistake is easy and quieter: a group whose provider reported no
 * tokens sums to zero, and a group with no published price costs zero, so a chart that plots the number draws
 * a **zero bar** — a claim the value is zero, made about a value nobody measured.
 *
 * So the rule is asserted against the chart source: the measurement carries whether it was taken, and the
 * charts render a labelled empty state rather than a bar when nothing in the group was measured.
 *
 * This reads source, not a render. A render test would need a browser and a gateway; the property here is
 * which strings and branches the code contains, which is what a fast source check can see.
 */

const ROOT = new URL('..', import.meta.url);
const charts = readFileSync(new URL('src/components/UsageCharts.tsx', ROOT), 'utf8');
const page = readFileSync(new URL('src/pages/UsagePage.tsx', ROOT), 'utf8');

test('a chart measurement carries whether it was actually taken', () => {
  // The helper must return `measured` from the group's own counts, not from the number being non-zero: a real
  // zero (a measured free request) and an absence both have `value === 0`, and only one is a measurement.
  assert.match(charts, /function measurement\(/, 'the measured/measured-presence helper is gone');
  assert.match(charts, /measured: group\.tokensMeasured > 0/, 'tokens are no longer gated on tokensMeasured');
  assert.match(charts, /measured: group\.pricedRequests > 0/, 'cost is no longer gated on pricedRequests');
});

test('a group with nothing measured renders a label, not a zero-height bar', () => {
  assert.match(
    charts,
    /!anyMeasured\s*\?/,
    'the charts no longer check anyMeasured, so an unmeasured window would draw as a flat zero',
  );
  // The cost mode is offered only when something was priced, so it cannot be the source of a "$0" read.
  assert.match(charts, /costAvailable/, 'the cost mode is no longer gated on something being priced');
});

test('the page shows a dash for an unmeasured total rather than a zero', () => {
  assert.match(page, /tokensUnmeasured \? '—'/, 'the input-tokens card prints a zero for an unmeasured total');
  assert.match(page, /unpricedEntirely \? 'Not priced'/, 'the cost card prints "$0" for a wholly unpriced window');
});

test('the page states that the charts cover a bounded tail, not all history', () => {
  assert.match(
    page,
    /tail, not a history/,
    'the retained-window caveat is gone, so the charts would read as an all-time summary',
  );
});