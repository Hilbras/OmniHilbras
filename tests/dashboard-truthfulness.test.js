import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * The dashboard does not report a result it did not obtain.
 *
 * ## What was wrong, and it was in the one place that matters
 *
 * `AddProviderModal` asks the user to paste a provider key and offers a **Check** button. That function
 * used to branch:
 *
 * ```ts
 * if (selected.id === 'openrouter') {
 *   await checkOpenRouterConnection(apiKey, controller.signal);
 *   setTestState('success');
 * } else {
 *   await new Promise<void>((resolve) => {
 *     window.setTimeout(() => { setTestState('success'); resolve(); }, 850);   // ← nothing was asked
 *   });
 * }
 * ```
 *
 * So for **every provider except OpenRouter**, the button waited 850 ms and reported success without
 * making a request. A key that was any string at all — `x`, a truncated paste, a key for the wrong
 * service — produced a green "Key looks valid". The only thing distinguishing the two branches was
 * which provider the card was for, so the *one* provider whose key was really checked was the exception.
 *
 * This is the rule at the top of `AGENTS.md` — *"a test, health check, or simulated result must not be
 * presented as a live one"* — broken in the single place where a user is told their credential works.
 * And it is the same class as the invented card metrics fixed in 1.34.5: mockup behaviour that outlived
 * the mockup, surviving because nothing compared what the UI claimed against what it did.
 *
 * The cause was not the timer. It was that the client could not name a provider: `checkOpenRouterConnection`
 * posted to a hardcoded `/v1/connections/openrouter/check` while the save beside it was already generic.
 * The gateway has served `POST /v1/connections/:providerId/check` for every provider since the duplicated
 * OpenRouter-only route was deleted in 1.34.0 — so the real answer was available and unreachable.
 *
 * ## What is asserted
 *
 * **No timer may be what produces a success state.** A `setTimeout` in a `setState('success')`'s
 * enclosing function is a mockup, whatever it is named. This is the check that makes the fix stick, and
 * it is deliberately narrow: it looks at *who sets success*, not at timers in general, because polling
 * and debouncing are legitimate and a guard that flags all of them is a guard that gets switched off.
 *
 * **No provider may be hardcoded in the client's paths.** One spelling per decision: a path that names a
 * provider is a path that cannot serve the next card.
 *
 * Comments are stripped before matching. The explanation of what used to happen is written next to the
 * code that replaced it, and a guard that cannot tell a comment from code reports a fixed bug.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = join(ROOT, 'src');

/** Every `.ts`/`.tsx` file in the dashboard, as repo-relative paths. */
function dashboardFiles(directory = DASHBOARD, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) dashboardFiles(full, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(relative(ROOT, full));
  }
  return found;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Whether a match at `index` sits inside a function that was *created by* a timer.
 *
 * The subtlety, which the first version of this got wrong and only a planted defect revealed: the scope
 * has to include the text **before** the innermost `=> {`, because that is where the `setTimeout(` lives.
 * Slicing from the arrow forward gives `=> { setTestState('success'); resolve(); }, 850);` — the callback
 * with the word "setTimeout" cropped off, so a check reading it finds nothing and passes. The guard for
 * "a timer must not produce a success" then has no way to see a timer, which is the one thing it exists
 * to see.
 *
 * So: find the innermost function start, then look a short window *backwards* from it for the call that
 * created it. That handles the multi-line original and a one-line plant equally, and it does not
 * over-trigger on a function that merely mentions a timer elsewhere.
 */
function createdByTimer(source, index) {
  const before = source.slice(Math.max(0, index - 2000), index);
  const arrow = before.lastIndexOf('=> {');
  const fn = Math.max(before.lastIndexOf('async function '), before.lastIndexOf('function '));
  const start = Math.max(arrow, fn);
  if (start === -1) return false;
  // A window before the callback's own `{`, long enough for a call site and short enough not to reach
  // an unrelated timer earlier in the file.
  const window = before.slice(Math.max(0, start - 200), start);
  return /setTimeout\s*\(|setInterval\s*\(|requestAnimationFrame\s*\(/.test(window);
}

test('no success state is produced by a timer', () => {
  const offences = [];
  for (const file of dashboardFiles()) {
    const source = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    for (const match of source.matchAll(/set[A-Za-z]*\(\s*'success'\s*\)/g)) {
      if (createdByTimer(source, match.index)) {
        offences.push(`${file}:${source.slice(0, match.index).split('\n').length}  a 'success' state is set inside a timer callback, so it reports a result nothing waited for`);
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    'a timer is a mockup. A success state must be set in response to something that came back — a ' +
      'request, a measurement, a user action that genuinely finished.',
  );
});

test('every provider the client names in a path is a real card, on a route the gateway serves', () => {
  // The narrower, true version of a rule I first wrote too broadly.
  //
  // I asserted "no provider may appear in a client path", expecting the OAuth surface to be as uniform
  // as the credential check turned out to be. It is not, and the difference matters:
  // `startGatewayOauthSignIn(providerId)` is generic, but `startGatewayDeviceSignIn` posts to
  // `/v1/oauth/opencode-console/start` and gets back a `userCode` and a `verificationUrl`, and
  // `getClineSignInStatus` hits a `/session/` route Cline alone has. **Different endpoints with
  // different payloads are not two spellings of one decision** — that is what made the credential check
  // wrong, where the request and the response were identical and only the path differed.
  //
  // So this asserts the two things that are true regardless: the provider named is a card that exists,
  // and the path is one the gateway actually serves. A hardcoded path for a card that was removed, or
  // for a route that was renamed, fails here instead of 404ing in a browser.
  const client = stripComments(readFileSync(join(DASHBOARD, 'lib', 'gatewayClient.ts'), 'utf8'));
  const cards = new Set(
    [...stripComments(readFileSync(join(DASHBOARD, 'data', 'providers.ts'), 'utf8')).matchAll(/^\s{4}id: '([\w-]+)'/gm)].map((match) => match[1]),
  );
  const gateway = join(ROOT, 'apps', 'gateway', 'src');
  const served = new Set();
  for (const file of [join(gateway, 'server.ts'), ...readdirSync(join(gateway, 'routes')).map((name) => join(gateway, 'routes', name))]) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/url\.pathname\s*(?:===|\.endsWith\(|\.startsWith\()\s*['"`]([^'"`]*)['"`]/g)) {
      served.add(match[1].replace(/\/$/, ''));
    }
  }

  const problems = [];
  for (const match of client.matchAll(/['"`](\/v1\/[a-z-]+\/([a-z0-9-]+)\/[^'"`]*)['"`]/g)) {
    const [, path, provider] = match;
    if (!['oauth', 'connections'].includes(path.split('/')[2])) continue;
    if (!cards.has(provider)) problems.push(`${path} names ${JSON.stringify(provider)}, which is not a card in the catalog`);
    const covered = [...served].some((servedPath) => servedPath === path || servedPath.startsWith(`${path}/`) || path.startsWith(`${servedPath}/`));
    if (!covered) problems.push(`${path} is called by the client but the gateway does not serve it`);
  }
  assert.deepEqual(problems, [], 'a client path for a card that does not exist, or for a route the gateway dropped, is a 404 waiting to happen');
});

test('the check goes through the gateway for every provider, not one', () => {
  // A weaker, more direct statement of the same thing, kept because it names the failure in the terms a
  // reader of the client would use: one function that can only ever check one provider.
  const client = stripComments(readFileSync(join(DASHBOARD, 'lib', 'gatewayClient.ts'), 'utf8'));
  assert.ok(
    /export function checkConnectionCredential\(providerId: string/.test(client),
    'the client should expose one credential check that takes a provider id',
  );
  assert.equal(
    /check(OpenRouter|[A-Z][A-Za-z]*)Connection\b/.test(client),
    false,
    'a per-provider check function is back, which is the shape that made this unreachable for twelve cards',
  );
});

test('the modal asks the gateway rather than waiting', () => {
  const modal = stripComments(readFileSync(join(DASHBOARD, 'components', 'AddProviderModal.tsx'), 'utf8'));
  const check = modal.slice(modal.indexOf('async function testConnection'), modal.indexOf('async function testConnection') + 1600);
  assert.ok(check.length > 0, 'testConnection should still exist');
  assert.ok(
    check.includes('checkConnectionCredential('),
    'the check must call the gateway, or there is no result to report',
  );
  assert.equal(
    /setTimeout/.test(check),
    false,
    'testConnection still contains a timer. A check that waits and then reports success is the exact ' +
      'defect this suite was written for.',
  );
  assert.ok(
    !/Key looks valid/.test(stripComments(readFileSync(join(DASHBOARD, 'components', 'AddProviderModal.tsx'), 'utf8'))),
    'the hedged "Key looks valid" wording existed only because the result was fake; with a real check ' +
      'there is one honest sentence. Read with comments stripped, since the explanation of what it ' +
      'replaced is written next to the code that replaced it.',
  );
});

test('the marketing page does not badge itself live, because nothing here is', () => {
  // `src/App.tsx` is the **marketing entry** — `main.tsx` renders it, and the dashboard has its own
  // entries. It carried a panel headed "Request activity", captioned "last 15 minutes · all routes",
  // with an animated green dot and the word **live**, reporting `18.4k` requests, a `412 ms` p95 and a
  // `99.98%` success rate over four hardcoded rows, closing with "Updated just now".
  //
  // Every number was a literal in that file. The gateway keeps no request log and no trace —
  // `request-context.ts` says so outright: *"Not telemetry, and not a trace."* An operator running this
  // locally knows exactly how many requests they have made, so a panel claiming 18.4k in the last
  // fifteen minutes is a false claim about **their own installation**, not a decorative flourish.
  //
  // An earlier version of this matched the *word* `live` between two tags. It caught a standalone badge
  // and missed the same lie inside a sentence, which is the more natural way to write one. Two rules
  // instead, both cheap and both for the same reason:
  //
  // - **no `animate-pulse` anywhere in this file.** A pulse is a liveness signal, and there is no live
  //   data on the page to be live about. This is the stronger of the two and the one that generalises: a
  //   fake feed needs a fake heartbeat whatever it calls itself.
  // - **no standalone liveness word as an element's whole text**, which is the shape a status badge
  //   actually takes.
  //
  // Both are revisitable if this page ever gains a real feed, and the reason is written down so that is
  // a decision rather than a deletion.
  const marketing = stripComments(readFileSync(join(DASHBOARD, 'App.tsx'), 'utf8'));
  const pulses = [...marketing.matchAll(/animate-pulse/g)];
  assert.equal(
    pulses.length,
    0,
    `the marketing page has ${pulses.length} pulsing element(s). A pulse says "this is updating", and ` +
      'nothing on this page is fed — no request log, no trace, no poller.',
  );
  const badges = [...marketing.matchAll(/[>']([\s·-]*(?:live|real-?time|streaming)[\s·-]*)[<]/gi)].map((match) => match[1].trim());
  assert.deepEqual(
    badges,
    [],
    `the marketing page labels itself "${badges.join('", "')}". There is no request log, no trace and no ` +
      'polling behind it, so a liveness badge is a claim about a feed that does not exist. ' +
      'tests/marketing-claims.test.js records the specific claims that were removed and why.',
  );
});

test('every dashboard page asks the gateway for something', () => {
  // The defect this catches appeared twice, and both times it was the same shape: a page that
  // **imported no data source at all**, so every number on it had to be a literal.
  //
  // ```
  // src/pages/DashboardOverview.tsx    client:0  useEffect:0  hardcoded metric rows: 7
  // src/pages/RoutingPage.tsx          client:0  useEffect:0  hardcoded metric rows: 8
  // ```
  //
  // `DashboardOverview` was the **landing page** — `/` redirected to it — with a range selector that
  // swapped between three invented request counts. `RoutingPage` had three clickable policies and four
  // togglable rules for features that do not exist anywhere in the gateway, plus a "Test policies"
  // button that reported a health check passing without making a request. Both are gone: `/` now lands
  // on Providers, and Routing shows what `GET /v1/routing` actually returns.
  //
  // The check is mechanical and it is the general one: **a page that asks the gateway nothing cannot be
  // showing the gateway's state.** A page that legitimately needs no data would have to say so here.
  //
  // **An import is not a call, and only a call counts.** The original check asked whether the file
  // contained the text `from '../lib/gatewayClient'`, which a single unused import satisfies. Proven by
  // planting exactly that on `RoutingPage` — an import plus four invented metrics, no call:
  //
  // ```
  // const INVENTED = { p95: '412 ms', successRate: '99.98%', spend: '$14,802', tokensToday: '9.4M' };
  // import { getGatewayRouting } from '../lib/gatewayClient';   // never called
  // ℹ pass 13   ℹ fail 0
  // ```
  //
  // So the rule is now: every name imported from `gatewayClient` must appear at a **call site** somewhere
  // in the file. An import that is never used is dead code pretending to be a data source, and it is the
  // cheapest possible way to satisfy this guard.
  const pages = readdirSync(join(DASHBOARD, 'pages')).filter((file) => file.endsWith('.tsx'));

  const noImport = [];
  const unusedImports = [];
  for (const file of pages) {
    const source = stripComments(readFileSync(join(DASHBOARD, 'pages', file), 'utf8'));
    const importBlock = source.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/lib\/gatewayClient'/);
    if (!importBlock) {
      noImport.push(file);
      continue;
    }
    // Everything after the import statement is where a call must appear.
    const body = source.slice(source.indexOf(importBlock[0]) + importBlock[0].length);
    for (const raw of importBlock[1].split(',')) {
      const entry = raw.trim();
      // A **type-only** import is erased at compile time and exists to annotate a value, so it is never
      // called and never should be. All seven current hits were `import { type GatewayHealth }` — a
      // correct and idiomatic import that this check initially reported as seven unused functions.
      if (/^type\s/.test(entry)) continue;
      const name = entry.split(/\s+as\s+/).pop()?.trim();
      if (!name) continue;
      // A call is `name(`. A bare mention in a comment is stripped already; a mention in code that is
      // not a call is exactly the case this rejects.
      if (!new RegExp(`\\b${name}\\s*\\(`).test(body)) {
        unusedImports.push(`${file}: \`${name}\` is imported from gatewayClient but never called`);
      }
    }
  }

  assert.deepEqual(
    noImport,
    [],
    `these pages import nothing from the gateway, so anything numeric on them is a literal: ${noImport.join(', ')}. ` +
      'Either fetch from the gateway, or delete the page — do not fill it with plausible numbers.',
  );
  assert.deepEqual(
    unusedImports,
    [],
    `an unused gatewayClient import satisfies the "asks the gateway" rule without asking it anything:\n${unusedImports.join('\n')}\n` +
      'Either call the function, or drop the import.',
  );
  assert.ok(pages.length >= 4, `expected the dashboard pages, found ${pages.length}`);
});

test('a request count is only ever the placeholder, because nothing counts requests', () => {
  // The gateway keeps no request counter. The only `count()` in it belongs to browser locators in the
  // ChatGPT Web driver. So a request count on any dashboard page can only be the "not measured" value.
  //
  // Measured, the dashboard had `18,492`, `124.8k`, `486.2k`, `18.4k`, `8,921`, `8.9k` and more, across
  // two pages, none of them backed by anything — and the same `92 ms` / `1,417` Ollama figures appeared
  // in three components after the card that invented them was fixed in 1.34.5. Fixing one instance and
  // not asking where else the number lived is how the same lie shipped three times.
  const offenders = [];
  for (const file of dashboardFiles()) {
    const source = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    for (const match of source.matchAll(/requests:\s*'([^']*)'/g)) {
      if (match[1] !== '0') offenders.push(`${file}: requests: '${match[1]}' — nothing counts requests, so only the placeholder is available`);
    }
  }
  assert.deepEqual(offenders, [], 'a displayed request count can only be a measurement, and there is no counter to measure with');
});

test('the clipboard receives a value, not a rendering of one', () => {
  // The clipboard is an API surface. Whatever lands there is what the user pastes somewhere else —
  // a `model:` field, a shell, a config file — and a rendering of a value is not the value.
  //
  // `ProviderDetailPage` used to write `modelReference(provider.id, model)`, which returned
  // `${providerId}/${model}` for everything except OpenRouter. A user on the Mistral page clicked copy
  // beside `mistral-large` and got `mistral/mistral-large` on their clipboard, then pasted it into a
  // `model:` field, and Mistral rejected an id it does not know. The gateway routes by the
  // `x-omnihilbras-provider` header and passes `model` to the adapter **verbatim**, so a qualified
  // string was never a friendlier spelling — it was a different, invalid one.
  //
  // So the rule is deliberately narrow and mechanical: the argument must be a plain identifier or a
  // member expression. No template literal, no concatenation, no call. If a composed string is
  // genuinely what should be copied, compose it into a named value first, so the thing on the clipboard
  // and the thing the toast confirms are visibly the same variable.
  const offenders = [];
  for (const file of dashboardFiles()) {
    const source = stripComments(readFileSync(join(ROOT, file), 'utf8'));
    for (const match of source.matchAll(/clipboard\.writeText\(([^;]*?)\)\s*;/g)) {
      const argument = match[1].trim();
      if (!/^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*$/.test(argument)) {
        offenders.push(`${file}: clipboard.writeText(${argument.slice(0, 60)}) — the clipboard gets a value, not a rendering of one`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'something transforms a value on its way to the clipboard, so what the user pastes is not what the product holds');
});

test('THE COUNT, asserted so it cannot drift quietly', () => {
  // The finding was one function in one file. The number is small on purpose: this suite is a tripwire
  // for one specific way the dashboard can lie, not a general audit of the frontend.
  const files = dashboardFiles();
  assert.ok(files.length > 20, `expected a substantial dashboard, found ${files.length} files`);
  const offenders = files.filter((file) => /set[A-Za-z]*\(\s*'success'\s*\)/.test(stripComments(readFileSync(join(ROOT, file), 'utf8'))));
  assert.ok(offenders.length > 0, 'there are success states in the dashboard, so the check above is not vacuous');
  console.log(`    dashboard files: ${files.length}   success states: ${offenders.length}   produced by a timer: 0`);
});
