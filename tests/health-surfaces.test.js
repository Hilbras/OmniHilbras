import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * One fact, one description — across every surface that shows it.
 *
 * ## What was wrong, measured in the running dashboard
 *
 * Two pages, the same provider, the same moment, two different answers:
 *
 * ```
 * /providers            opencode   Credential check   100%
 * /providers/opencode   opencode   ROUTE HEALTH       Pending
 * ```
 *
 * `ProviderDetailPage` never called `getGatewayProviderHealth` on load. It only read health when
 * someone pressed **Test provider**, into a `connectionHealthy` boolean that carried no notion of
 * *which* question had been asked. So a page opened cold reported a credential poll as "Pending" —
 * a word that claims a check is in progress when nothing has been asked — while the providers page,
 * reading the same poll, showed its result.
 *
 * 1.40.0 had already retired "Route health" as a label for a credential check on the card. The detail
 * page kept it, which is how one decision ends up with two implementations: the same recurring defect
 * as the two health checks themselves.
 *
 * ## The property
 *
 * **Any page that shows a health verdict must name what the verdict established.** Enumerating pages
 * would let a fifth one appear unreviewed, so this scans every dashboard page rather than today's list.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = join(ROOT, 'src/pages');

/** Strips comments, because a doc comment naming a label is not the page rendering it. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('no dashboard page renders "Route health" without asking whether it earned it', () => {
  const pages = readdirSync(PAGES).filter((file) => file.endsWith('.tsx'));
  const offenders = [];
  for (const file of pages) {
    const source = code(readFileSync(join(PAGES, file), 'utf8'));
    for (const match of source.matchAll(/['"](Route health|ROUTE HEALTH)['"]/g)) {
      // Allowed only where the label is chosen by the verification scope. The scope is looked for in
      // the **enclosing line** rather than a fixed window of characters before it: my first version
      // used a 160-char window, which the ternary on one line fell out of, so it flagged a correctly
      // conditional label. A window is a guess about formatting; the line is where the decision is.
      const lineStart = source.lastIndexOf('\n', match.index) + 1;
      const lineEnd = source.indexOf('\n', match.index);
      const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
      // Case-insensitive, and that is not cosmetic. The real label is chosen by `connectionVerified`,
      // and a case-sensitive `/verified/` does not match `Verified` — so this flagged the one line in
      // the dashboard that was doing it correctly. The check has to name the *idea*, not one spelling.
      if (!/verified/i.test(line)) offenders.push(`${file}: an unconditional "${match[1]}"`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the detail page reads health on load, not only when a button is pressed', () => {
  // The defect itself. A page whose health comes solely from a click is a page that is wrong until
  // someone touches it — and the providers page is right at the same moment.
  const source = code(readFileSync(join(PAGES, 'ProviderDetailPage.tsx'), 'utf8'));
  const inEffect = /useEffect\(\(\) => \{[^}]*getGatewayProviderHealth/.test(source);
  assert.ok(inEffect, 'ProviderDetailPage must read provider health from an effect, not only from the Test button');
});

test('the detail page carries the verification scope, so it can label what it read', () => {
  const source = readFileSync(join(PAGES, 'ProviderDetailPage.tsx'), 'utf8');
  assert.match(source, /connectionVerified/, 'the scope is held');
  assert.match(source, /setConnectionVerified\(providerHealth\.verified\)/, 'and recorded from the response');
});

test('an unread health state is named as unread, not as in progress', () => {
  // "Pending" claims a check is running. Nothing was running: the page had never asked.
  const source = code(readFileSync(join(PAGES, 'ProviderDetailPage.tsx'), 'utf8'));
  assert.doesNotMatch(source, /connectionAdded \? 'Pending'/, 'the unread state is not described as pending');
  assert.match(source, /Not read yet/, 'it says it has not been read');
});

test('clearing the health flag clears the scope with it', () => {
  // A stale `verified` next to a cleared `healthy` is the exact disagreement this release removes, one
  // interaction later: the page would keep saying "Credential check" over a connection it no longer
  // believes in.
  const source = code(readFileSync(join(PAGES, 'ProviderDetailPage.tsx'), 'utf8'));
  const clears = [...source.matchAll(/setConnectionHealthy\(false\);/g)];
  assert.ok(clears.length > 0, 'there is at least one reset path to check');
  for (const match of clears) {
    const after = source.slice(match.index, match.index + 200);
    assert.match(after, /setConnectionVerified\(undefined\)/, 'every reset of the flag resets the scope too');
  }
});

test('the connection row does not call a credential poll "healthy"', () => {
  const source = code(readFileSync(join(PAGES, 'ProviderDetailPage.tsx'), 'utf8'));
  assert.doesNotMatch(source, /\{healthy \? 'healthy' : 'health pending'\}/, 'the badge names the scope or admits ignorance');
});