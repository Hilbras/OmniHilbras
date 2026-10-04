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
const SRC = join(ROOT, 'src');

/**
 * Every `.tsx` file under a directory, as source text.
 *
 * `.tsx` and not `.ts`: the panel that carried `1,284 req/min`, `p95 412ms` and an animated
 * "listening" badge is `src/components/RoutePreview.tsx`, rendered by `App.tsx` inside the very
 * section whose copy 1.37.0 rewrote to say the product has no traces. A guard that reads `App.tsx`
 * cannot see a component `App.tsx` renders, and this one did not — the fix in 1.37.0 passed while
 * the fabrication stayed on the page.
 */
function readAllTsx(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return readAllTsx(full);
    return entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) ? [readFileSync(full, 'utf8')] : [];
  });
}

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
  // Not the bare word "spend": `ProviderPlayground` legitimately says a provider "will spend" credits
  // on a real request, which is true and is the point of the warning. A guard that forbids a common
  // English verb gets switched off rather than weakened, so the phrase that is actually a claim is
  // forbidden instead.
  'spend tracking': 'no cost accounting exists; the only "cost" in the gateway is the word in prose comments.',
  'request activity': 'the panel that carried this heading reported hardcoded numbers and is gone.',
  'last 15 minutes': 'a time window implies a rolling feed; nothing on this page is fed.',
  'updated just now': 'nothing on the page updates, so a freshness claim is a claim about a poller that does not exist.',
  'listening': 'a liveness badge is a claim about a feed, and nothing polls. The animated dot on the route panel was this claim in a component the guard could not see.',
  'req/min': 'the gateway keeps no request counter, so no throughput figure exists to print.',
  // 1.46.0. The router sorts on `left.priority - right.priority || left.name.localeCompare(...)`
  // (`apps/gateway/src/routing.ts`) and then filters on health, credential and rate limit. There is no
  // cost, no quality, no privacy and no spend budget — every `budget` in the gateway is a *retry* budget,
  // which is a different word meaning a different thing. `RoutingPage.tsx` already said so in its own
  // header ("a feature that does not exist anywhere in the gateway"), so the product had told the truth
  // on the page showing real routing state while this page still claimed it.
  'lowest cost': 'the router has no cost input; `modelFilters.ts` prices are a dashboard sort comparator.',
  'per-model rules': 'there is no rules store and no per-model routing decision anywhere in the gateway.',
  'quality, latency, cost, privacy': 'the router sorts by priority then name. Nothing else is an input.',
  'policy engine': 'no policy, no strategy setting, no rules store — `RoutingPage.tsx` documents the absence.',
  'all systems operational': 'a status claim with no probe behind it, rendered unconditionally in the header. It contradicted the sidebar badge in the same file, which does poll. Now reports the same hook.',
  'gateway.omnihilbras.dev': 'no DNS record, and the product is local-first. The first thing a reader copies did not work.',
};

/**
 * The marketing entry **and the components it renders**.
 *
 * Widened from `App.tsx` alone in 1.41.0, after `RoutePreview.tsx` survived 1.37.0's fix while being
 * rendered inside the very section whose copy said the product had no traces. Reading only the file
 * that imports a component is not reading what the visitor sees.
 *
 * Comments are stripped first, and that matters: every reason above is written in prose containing the
 * very words it forbids, so a check that grepped raw source would fail on its own documentation.
 */
test('the page claims nothing it cannot back', () => {
  const page = stripComments(readAllTsx(SRC).join('\n')).toLowerCase();
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
  const page = stripComments(readFileSync(join(SRC, 'App.tsx'), 'utf8')).toLowerCase();
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
  // 7 in 1.37.0. 8 in 1.38.0 (`request activity`). **9 in 1.41.0**: `listening` and `req/min`, both
  // from `RoutePreview.tsx` — a component 1.37.0's fix never reached because the guard read
  // `App.tsx` alone, and the two replacements of the `spend` entry for `spend tracking` are the same
  // entry. **15 in 1.46.0**: the marketing page advertised a policy engine with cost, quality, privacy
  // and budgets, the header of every page carried a hardcoded "All systems operational", the curl
  // sample pointed at a hostname with no DNS record, and a decorative diagram was labelled
  // "policy engine". Five of the six were in files this guard had been reading all along — it caught
  // them only because the entries were added while fixing them, which is the dependency it has: a
  // false claim is recorded when someone notices it, not when it is written.
  assert.equal(Object.keys(FALSE_CLAIMS).length, 15, `the recorded-claims list now has ${Object.keys(FALSE_CLAIMS).length} entries`);
  console.log(`    recorded false claims: ${Object.keys(FALSE_CLAIMS).length}   present on the page: 0`);
});


// ---------------------------------------------------------------------------
// The Usage page, specifically. (1.64.0)
// ---------------------------------------------------------------------------
//
// `FALSE_CLAIMS` above scans all of `src/`, which catches a claim the page cannot back. It cannot catch the
// opposite error, which is the one this page is most likely to make: **rendering a number that means
// nothing**.
//
// Every figure on `UsagePage.tsx` comes from `GET /v1/usage`, and three of them have a "we don't know"
// state that is easy to collapse into a zero. The collapse is the failure:
//
//   tokensUnmeasured  -> "0 input tokens"   (says: the provider reported none, i.e. it used none)
//   unpricedEntirely  -> "$0.00"            (says: this was free, rather than nobody published a price)
//   providerId absent -> some default      (says: that provider served it, when no provider was reached)
//
// So these are asserted structurally. A change that renders any of them as a value fails here rather than
// shipping, and the reasoning lives next to the assertion rather than in a reviewer's memory.

test('the Usage page renders an absent measurement as absent, never as a number', () => {
  const page = readFileSync(join(SRC, 'pages', 'UsagePage.tsx'), 'utf8');

  // `tokensUnmeasured` gates both token figures. Checked as a real conditional in the source, not by
  // looking for the words, so renaming the variable does not silently disarm it.
  // **Both** figures, named individually. The first version counted the gates (`>= 1`) and I removed the
  // input-token one to test it: the output-token gate remained, the count stayed at 1, and the guard
  // passed. A guard that counts occurrences of a pattern cannot tell "both are gated" from "one is", which
  // is the same mistake as asserting two branches when only one was checked.
  for (const field of ['inputTokens', 'outputTokens']) {
    const gated = new RegExp(`tokensUnmeasured[^\\n]*${field}`).test(page);
    assert.ok(
      gated,
      `the ${field} figure is not gated on \`tokensUnmeasured\`, so an unmetered provider renders as 0 tokens`,
    );
  }

  // `unpricedEntirely` gates cost, and the alternative to a number is words rather than `$0`.
  assert.ok(
    /unpricedEntirely\s*\?\s*'Not priced'/.test(page),
    "an entirely unpriced page must say so; `\"$0.00\"` would claim the requests were free",
  );
  assert.ok(
    /cost\?\.caveat/.test(page),
    'the cost caveat from the gateway is never rendered, so a partial total would look complete',
  );

  // A record with no provider says so. The alternative is a fallback provider name.
  assert.ok(
    /providerId\s*\?\?\s*'unattributed'/.test(page),
    "a request with no provider must render as unattributed; any fallback name puts a provider on a " +
      'request that provider never served',
  );
});

test('the Usage page shows cancellations separately, because they are neither success nor failure', () => {
  // The v1.52.0 rule, in the one place a reader will count them. Folding a cancellation into "failed" is
  // what the health counter was fixed for, and the same mistake in the same product would be found by
  // nobody, because the totals would still add up.
  const page = readFileSync(join(SRC, 'pages', 'UsagePage.tsx'), 'utf8');
  assert.ok(/label="Cancelled"/.test(page), 'cancellations have no summary card of their own');
  // `totals.cancelled`, not `totals?.cancelled` — the page narrows with `totals ? String(...) : '—'`,
  // so the optional chain never appears. My first assertion looked for the chain and reported the card
  // as unread when it was reading the field perfectly well.
  assert.ok(
    /totals\s*\?[^\n]*totals\.cancelled/.test(page) || /totals\?\.cancelled/.test(page),
    'the cancellation total is never read, so the card would show nothing',
  );
});

test('the Usage page states that its window is bounded, because it is', () => {
  // The store keeps a bounded number of records and drops the rest, so "requests" is a count of what is
  // retained, not of everything ever sent. A page that shows a bare total without saying so invites the
  // reader to treat it as a lifetime figure.
  const page = stripComments(readFileSync(join(SRC, 'pages', 'UsagePage.tsx'), 'utf8')).toLowerCase();
  assert.ok(
    page.includes('tail') && page.includes('history'),
    'the page must say its list is a bounded tail rather than a history; without that, the total reads as lifetime',
  );
});

test('the Usage nav entry is live, and its route exists', () => {
  // The nav had carried a disabled "soon" entry for this page since before the data existed. Two things
  // must hold together: the entry is not pending, and the router serves the path. Either alone would be a
  // link to nowhere or a page nothing can reach.
  const shell = readFileSync(join(SRC, 'components', 'DashboardShell.tsx'), 'utf8');
  const usageEntry = shell.match(/label: 'Usage'[^\n]*/)?.[0] ?? '';
  assert.ok(usageEntry, 'the Usage nav entry is gone');
  assert.ok(
    !usageEntry.includes('pending'),
    `the Usage nav entry is still disabled: ${usageEntry.trim()}`,
  );
  assert.ok(usageEntry.includes("to: '/usage'"), `the Usage nav entry points elsewhere: ${usageEntry.trim()}`);

  const router = readFileSync(join(SRC, 'dashboardApp.tsx'), 'utf8');
  assert.ok(
    /path="\/usage"\s+element=\{<UsageContent \/>\}/.test(router),
    'no route serves /usage, so a live nav entry would go nowhere',
  );
});

// The Settings page (1.65.0). Same three failure modes as Usage, one of them new.
// ---------------------------------------------------------------------------
//
// `read-only` is the claim most likely to be wrong here, because a page of nine values with no indication
// of which can change invites the reader to treat all nine as editable. The gateway reports the split; the
// page must use it rather than deciding for itself, or it will drift the first time a setting moves.

test('the Settings page renders every value from the gateway, and decides nothing itself', () => {
  const page = readFileSync(join(SRC, 'pages', 'SettingsPage.tsx'), 'utf8');

  // The mutability split comes from the gateway, not from a local list.
  assert.ok(
    /settings\?\.mutableAtRuntime/.test(page),
    'the page does not read `mutableAtRuntime`, so it must be deciding mutability locally and will drift',
  );
  // `settings.mutableByRestart`, not `settings?.` -- inside the non-null branch the optional chain never
  // appears, and my first pattern looked for one and reported the field as unread when it was read plainly.
  // Both spellings are accepted for the same reason the Usage guard accepts both: a page that has narrowed
  // the type has no reason to re-narrow it.
  assert.ok(
    /settings\??\.mutableByRestart/.test(page),
    'the page does not read `mutableByRestart`',
  );

  // A restart-only setting must not be rendered with an edit affordance.
  //
  // Only `<input>` and `<select>` count. My first pattern included `<button>`, which matched the header's
  // Refresh button — it mentions `port` nowhere, but it carries a class list long enough to trip a loose
  // keyword check, and a guard that fires on the Refresh button is a guard that gets deleted.
  //
  // So: value-entry controls, and only those. A restart-only setting needs an environment variable and a
  // process restart, and there is no honest widget for that.
  const inputs = page.match(/<(input|select)\b[^>]*>/g) ?? [];
  assert.deepEqual(
    inputs,
    [],
    `the page renders a value-entry control: ${inputs.join(' ')}. Every setting here is set by an ` +
      'environment variable, so an input would be a control that changes nothing.',
  );

  // No secret can be displayed, because the response has no field that could carry one — asserted on the
  // gateway side. Here, the page must not be reaching for anything beyond the named fields.
  //
  // `authRequired` is the exception, and it is not one by my leaving: it is a **boolean about** a credential,
  // never a credential, and whether the compatible endpoint demands one is deployment information an
  // operator needs. My first list included `credential`, which matched `authRequired`'s line and reported the
  // page as reading a secret — a substring guard cannot tell "is a credential required" from "is a
  // credential", so the value-shaped word has to be excluded by hand.
  for (const field of ['apiKey', 'api_key', 'masterKey', 'accessToken', 'refreshToken', 'secretValue']) {
    assert.ok(!new RegExp(`settings[^\\n]*${field}`, 'i').test(page), `the page reads a \`${field}\` field`);
  }
  // **The vault's location must be shown.** A settings page that hid `dataDir` would leave no way to find
  // where the credentials are, and the value is a path the operator chose — not a secret. I dropped this row
  // as a mutation and no test complained, which means the guard was silent about a page that had become
  // less useful while passing every check.
  assert.ok(/settings\.dataDir/.test(page),
    'the page does not show `dataDir`, so there is no way to find where the vault and usage records live');
  assert.ok(/Data directory/i.test(page), 'the data directory has no label a reader would recognise');

  // `authRequired` is a boolean about a credential, and must stay that way: if it ever became a value the
  // page would render, the guard above would not catch it and neither would this comment.
  const authUse = page.match(/authRequired[^;\n]*/g) ?? [];
  for (const use of authUse) {
    assert.ok(!/authRequired\s*[:=]\s*['"$`]/.test(use),
      `authRequired appears to carry a value rather than a boolean: ${use.trim()}`);
  }
});

test('the Settings nav entry is live, and its route exists', () => {
  // The last disabled nav item was Settings. Two things must hold together: the entry is not pending, and the
  // router serves the path — either alone would be a link to nowhere or a page nothing can reach.
  const shell = readFileSync(join(SRC, 'components', 'DashboardShell.tsx'), 'utf8');
  const entry = shell.match(/label: 'Settings'[^\n]*/)?.[0] ?? '';
  assert.ok(entry, 'the Settings nav entry is gone');
  assert.ok(!entry.includes('pending'), `the Settings nav entry is still disabled: ${entry.trim()}`);
  assert.ok(entry.includes("to: '/settings'"), `the Settings nav entry points elsewhere: ${entry.trim()}`);

  // The router must serve the path the nav entry points at. Asserting only that *a* route exists would miss
  // a nav entry retargeted somewhere else -- my first mutation edited the shell and no test noticed, because
  // the router assertion was looking at the router and the nav assertion was looking at a string that still
  // contained `/settings` in the comment above it.
  const router = readFileSync(join(SRC, 'dashboardApp.tsx'), 'utf8');
  const path = entry.match(/to: '([^']+)'/)?.[1];
  assert.ok(path, `the Settings nav entry has no path: ${entry.trim()}`);
  assert.ok(
    new RegExp(`path="${path.replace('/', '\\/')}"\\s+element=\\{<[A-Za-z]+Content />\\}`).test(router),
    `the router serves no page for the path the nav entry points at: ${path}`,
  );
  assert.ok(
    router.includes("<Route path=\"/settings\" element={<SettingsContent />} />"),
    'the /settings route is gone, so a live nav entry would go nowhere',
  );
});

test('only Request log remains disabled, and it says why it has nothing to show', () => {
  // Worth pinning: the day the last "soon" entry goes, this test should be the one that fails, because a
  // `pending: true` list that nobody prunes is how a project ends up advertising features it removed.
  const shell = readFileSync(join(SRC, 'components', 'DashboardShell.tsx'), 'utf8');
  const pending = [...shell.matchAll(/label: '([^']+)'[^\n]*pending: true/g)].map((match) => match[1]);
  assert.deepEqual(pending, ['Request log'],
    `the disabled nav items changed: ${pending.join(', ') || 'none'}. If one shipped, delete its pending flag; ` +
      'if one was removed, update this list.');
});
