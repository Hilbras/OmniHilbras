import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const read = (file) => readFileSync(new URL(file, ROOT), 'utf8');

/**
 * The account allowance on a provider's Usage tab.
 *
 * This panel exists because the capability was already built and never wired: Kiro has read its
 * `getUsageLimits` for a while, the gateway serves it, and the dashboard had never called it. Wiring
 * it is easy; wiring it *honestly* is the part with teeth.
 *
 * Most providers publish no account quota at all. Some decide entitlement per request and only ever
 * reveal it by refusing with a `402`. So the panel has three states that look identical from the
 * outside and mean opposite things — still asking, "this provider publishes nothing", and a real
 * reading — and the failure this file exists to catch is collapsing the middle one into zeroes. A
 * panel that showed `0 of 0` for every provider would look finished, be wrong everywhere, and be
 * indistinguishable from a measurement at a glance.
 */

const page = read('src/pages/UsagePage.tsx');

test('a provider that publishes no quota is told so, not shown an empty allowance', () => {
  // The distinction is made by the gateway's code rather than by reading the sentence, because a
  // refusal and a failure both arrive as an Error with a message.
  assert.match(page, /isNotSupported\(cause\)/, 'the panel no longer tells "no quota published" apart from "the request failed"');
  assert.match(page, /does not publish an allowance/, 'the unsupported state has no wording of its own');
  // The load-bearing sentence: not an empty balance, an unanswerable question.
  assert.match(page, /Not an empty balance/, 'the panel no longer says that no reading is not a zero reading');
});

test('the panel never renders a figure it was not given', () => {
  // A hardcoded zero would survive every loading state and every refusal, which is exactly how a
  // simulated measurement gets shipped.
  assert.doesNotMatch(page, /resources\.length \? ['"]?0/, 'the panel derives a count rather than reporting what arrived');
  // Remaining and limit come from the provider's own numbers, rendered as given.
  assert.match(page, /\{resource\.remaining\} of \{resource\.limit\} left/, 'the figures are not the provider\'s own');
});

test('a provider that answered with no named resource is not called unlimited', () => {
  // An empty map after a successful read is a real answer that says nothing useful, and "nothing was
  // metered" is not "there is no limit".
  assert.match(page, /named no metered resource/, 'an empty resource map has no wording of its own');
  assert.match(page, /not the same as an\s+unlimited one/, 'an empty map is now presented as unlimited');
});

test('the bar is not drawn from a limit that is absent or zero', () => {
  // Dividing by a zero limit would produce Infinity or NaN, which React renders as a bar of nonsense.
  assert.match(page, /resource\.limit > 0/, 'the share is computed without checking the limit is usable');
});

test('the allowance is rendered outside the recorded-usage branch, so neither can hide the other', () => {
  // Both are real measurements from different sources. A gateway with no usage store still answers a
  // quota question, and a provider with no quota still has records; nesting one inside the other
  // makes one of the two disappear whenever the other is in an empty state.
  const panelIndex = page.indexOf('<QuotaPanel');
  const usageBranchIndex = page.indexOf('usage && !usage.recording');
  assert.ok(panelIndex > 0, 'the panel is not rendered at all');
  assert.ok(panelIndex < usageBranchIndex, 'the panel is nested inside the recorded-usage branch, so an empty usage store hides the provider\'s own allowance');
});

test('the panel is asked for the connection, not the card', () => {
  // A card that shares another provider's credential records under the owner; asking the card for a
  // quota would either 404 or read someone else's balance.
  const detail = read('src/pages/ProviderDetailPage.tsx');
  assert.match(detail, /connectionId=\{connection\?\.id\}/, 'the panel is asked for the card rather than the connection behind it');
  assert.match(page, /providerId && connectionId \?/, 'the panel renders without a connection to read');
});

test('the panel says where the figures come from', () => {
  // These are the provider's numbers about a subscription; the rest of the page is OmniHilbras'
  // own records. Stating it is the difference between a reading and a claim.
  assert.match(page, /Reported by \{providerName\} itself/, 'the panel does not say the figures are the provider\'s');
  assert.match(page, /are not\s+OmniHilbras&rsquo; own measurement/, 'the panel does not separate the provider\'s reading from our records');
});
