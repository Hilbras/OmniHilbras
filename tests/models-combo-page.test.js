import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The Models page's combo controls.
 *
 * A combo is an `oh/` virtual model: one id whose targets are accounts across providers. The routing, the
 * failover ledger and the strategies live in the gateway and are tested there
 * (`Kernel/API/test/virtual-models-routing.test.js`, `routing.test.js`). What is asserted here is the part the
 * page is responsible for — that its Test button spends a real turn through the *combo's own* routing rather
 * than picking a member itself, and that what it reports is what the gateway said.
 *
 * Source assertions, because this suite has no DOM: the behavioural half is covered by the gateway tests and
 * by the live proof recorded in the release notes (a turn served by member A, then `RATE_LIMITED` on A with
 * member B serving the same id).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('the combo test button spends a real turn through the combo, naming no account', () => {
  const client = read('src/lib/gatewayClient.ts');
  const page = read('src/pages/ModelsPage.tsx');

  // The request must not pin a provider or an account: a page that picks the member would be testing itself.
  const probe = client.slice(client.indexOf('export async function testGatewayVirtualModel'));
  assert.ok(probe.length > 0, 'the probe exists');
  assert.equal(probe.includes("'x-omnihilbras-provider'"), false, 'no provider is pinned');
  assert.equal(probe.includes("'x-omnihilbras-connection'"), false, 'no account is pinned');
  assert.match(probe, /model,/, 'and the combo id is what is sent');

  assert.match(page, /testGatewayVirtualModel\(model\.id\)/, 'the page sends the combo id');
  // The serving member is the gateway's own report, not something the page derived.
  assert.match(page, /result\.provider/, 'the provider comes from the reply');
  assert.match(page, /result\.connection/, 'and so does the account');
  assert.match(page, /Answered by \$\{served\}/, 'and the page says which member answered');
});

test('a target is chosen by provider name, and disambiguated only where it must be', () => {
  const page = read('src/pages/ModelsPage.tsx');

  // Asked for directly: the selector said "Account" and listed connection names, which are often notes to
  // self — "main", "5k0eqgspm6" — where the provider is what a person recognises.
  assert.match(page, /mono-label mb-1 block text-\[9px\]">Provider</, 'the selector says Provider');
  assert.equal(/>Account</.test(page), false, 'and no longer says Account');

  // The name is the catalog's, resolved from the provider id — not whatever the connection is called.
  assert.match(page, /resolveProviderOption\(connection\.providerId\)/, 'the provider name comes from the catalog');
  assert.match(page, /providerLabel\(entry\)/, 'and the selector renders it');
  assert.match(page, /providerLabel\(connectionById\.get\(target\.connectionId\)!\)/, 'so does the card, so both read the same');

  /**
   * The disambiguation is load-bearing rather than decoration: the store holds a **connection**, so two
   * accounts of one provider must stay tellable apart, or one of them becomes unpickable.
   */
  assert.match(page, /if \(accounts\.length <= 1\) return name;/, 'one account reads as the provider alone');
  assert.match(page, /return `\$\{name\} — \$\{connection\.name\}/, 'two accounts of one provider keep the account');
});

test('a test states its cost, and a refused test reports the refusal', () => {
  const page = read('src/pages/ModelsPage.tsx');
  // A real turn costs money or allowance: `AGENTS.md` requires saying so rather than spending silently.
  assert.match(page, /billed to that member/, 'the cost is stated where the button is offered');
  // Failures are the gateway's words, not an invented member.
  assert.match(page, /\[model\.id\]: \{ ok: false, text: cause instanceof Error \? cause\.message/, 'a failure shows the gateway\'s message');
});

test('every target shows why routing would skip it', () => {
  const page = read('src/pages/ModelsPage.tsx');
  assert.match(page, /getGatewayRoutingState\(\)/, 'the live routing state is read');
  for (const condition of ['no credential', 'rate-limited', 'ejected', 'never measured']) {
    assert.ok(page.includes(condition), `the page names "${condition}"`);
  }
  // Absent is its own answer: the ledger records latency only after a success, so an unmeasured account must
  // not be shown as an instant one.
  assert.match(page, /entry\.latency\) return \{ label: `\$\{Math\.round\(entry\.latency\.latencyMs\)\} ms`/, 'a measured account shows its measured milliseconds');
});
