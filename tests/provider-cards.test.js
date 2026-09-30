import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The provider cards tell the truth about what has actually happened.
 *
 * ## The rule, and the part of it that was not true
 *
 * `AGENTS.md` says:
 *
 * > A provider card in `src/data/providers.ts` is catalog metadata. Before a card claims a working
 * > connection, the gateway must be able to serve that provider: a card with no connection stays
 * > `status: 'available'` with `—` metrics, and an auth mode with no flow behind it (currently
 * > `OAuth`) must disable Save in `AddProviderModal` and say so.
 *
 * The first clause was violated by exactly one card, and it is worth seeing what it looked like,
 * because the numbers were plausible:
 *
 * ```
 * id: 'ollama'   status: 'attention'   models: '6 models'
 * latency: '92 ms'   requests: '1,417'   lastUsed: '2 min ago'
 * health: 72   modelList: ['qwen3-coder', 'llama3.2', 'nomic-embed-text']
 * ```
 *
 * `ProvidersPage` seeds its state from this catalog and `mergeGatewayConnections` overlays **only the
 * providers that have a connection**, so a card here is exactly what a user sees when the gateway has
 * never been asked about that provider. A user with no Ollama connection was shown an amber
 * "attention" badge, a 92 ms latency, 1,417 requests, and three named models — for a local runtime
 * they had never run. Twelve of the thirteen cards already carried placeholders; this one was left over
 * from when the dashboard was a static mockup, and it contradicted the rule the mockup predates.
 *
 * ## The invariant, restated so it can be checked
 *
 * **The catalog is the no-connection fallback, so no card in it may claim a measurement.** That is a
 * property of the data rather than an instruction about a UI state, which is why it can be asserted:
 * if a card's number could only have come from a measurement, and the catalog is shown precisely when
 * there is nothing to measure, then the number was invented. Live figures arrive from the gateway and
 * overwrite all of it.
 *
 * ## The second clause was both unimplemented and out of date
 *
 * The rule says an auth mode with no flow behind it — "currently `OAuth`" — must disable Save in
 * `AddProviderModal`. Two problems, and they are different problems:
 *
 * - **No such mechanism exists.** `canSave` is computed from form fields alone —
 *   `name`, `apiKey`, `endpoint` — and knows nothing about flows. So the clause described an
 *   unimplemented behaviour, and a reader of `AGENTS.md` would reasonably assume the code had it.
 * - **The parenthetical is false.** Three cards claim `auth: 'OAuth'` — `opencode-console`, `kiro`,
 *   `cline` — and the gateway serves an OAuth start route for all three. OAuth grew a flow after the
 *   rule was written, and the rule was never updated.
 *
 * So the clause is restated in the form that is both true and enforceable: **a card may claim
 * `auth: 'OAuth'` only when the gateway serves an OAuth start route for that provider.** Three cards,
 * three routes, checked against each other. A fourth OAuth card added without a flow now fails, which
 * is what the original clause was reaching for. The `AddProviderModal` half is recorded in
 * `AGENTS.md` as what it is — a requirement that has never been implemented, with no mode to trigger
 * it today — rather than left as a claim about code that does not exist.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'src', 'data', 'providers.ts');
const GATEWAY = join(ROOT, 'apps', 'gateway', 'src');

/** The fields a card must hold when nothing has measured them. */
const PLACEHOLDERS = {
  status: 'available',
  models: '—',
  latency: '—',
  requests: '0',
  lastUsed: 'never',
  health: 0,
};

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The `providerLogoMap` at the top of the catalog, so `providerLogoMap.openai` resolves to a path. */
function logoMap() {
  const source = stripComments(readFileSync(CATALOG, 'utf8'));
  const body = source.slice(source.indexOf('providerLogoMap'), source.indexOf('getProviderLogo'));
  const map = new Map();
  for (const match of body.matchAll(/(\w+):\s*'(\/providers\/[^']+)'/g)) map.set(match[1], match[2]);
  return map;
}

/** The catalog's cards, as objects, parsed from the literal. */
function cards() {
  const source = stripComments(readFileSync(CATALOG, 'utf8'));
  const body = source.slice(source.indexOf('providerCatalog'), source.lastIndexOf(']'));
  const logos = logoMap();
  return body
    .split(/\n  \{\n/)
    .slice(1)
    .map((block) => {
      const card = {};
      for (const match of block.matchAll(/^\s*(\w+):\s*(?:'([^']*)'|"([^"]*)"|(-?[\d.]+)|(\[[^\]]*\])|providerLogoMap\.(\w+))/gm)) {
        const [, key, single, double, number, list, logo] = match;
        card[key] = single ?? double ?? (number !== undefined ? Number(number) : list ?? (logo !== undefined ? logos.get(logo) : undefined));
      }
      return card;
    })
    .filter((card) => card.id);
}

/**
 * The web-session collectors, from the descriptor table the dialog is driven by.
 *
 * `WebCookieConnectDialog` takes a `descriptor` with a `check.path` and a `paste.path`, so the
 * providers it serves are **data**, not code. That makes the table the thing to check: it is the only
 * place that says "this card's credential is collected by pasting a cookie", and nothing compared it
 * to the catalog or to the gateway's routes.
 */
function webSessionDescriptors() {
  const source = stripComments(readFileSync(join(ROOT, 'src', 'lib', 'webSessionProviders.ts'), 'utf8'));
  return source
    .split(/\n\s*id: '/)
    .slice(1)
    .map((block) => ({
      id: block.slice(0, block.indexOf("'")),
      check: (block.match(/check:\s*\{\s*path:\s*'([^']+)'/) || [])[1],
      paste: (block.match(/paste:\s*\{[\s\S]*?path:\s*'([^']+)'/) || [])[1],
    }));
}

/** Providers the gateway can begin an OAuth sign-in for, from its real route table. */
function oauthCapableProviders() {
  const files = [join(GATEWAY, 'server.ts'), ...readdirSync(join(GATEWAY, 'routes')).map((file) => join(GATEWAY, 'routes', file))];
  const found = new Set();
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/url\.pathname\s*===\s*'\/v1\/oauth\/([\w-]+)\/start'/g)) {
      found.add(match[1]);
    }
  }
  return found;
}

/** Every path the gateway actually serves, for checking a descriptor's routes exist. */
function servedPaths() {
  const files = [join(GATEWAY, 'server.ts'), ...readdirSync(join(GATEWAY, 'routes')).map((file) => join(GATEWAY, 'routes', file))];
  const found = new Set();
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/url\.pathname\s*(?:===|\.endsWith\(|\.startsWith\()\s*['"`]([^'"`]*)['"`]/g)) {
      found.add(match[1].replace(/\/$/, ''));
    }
  }
  return found;
}

test('no catalog card claims a measurement, because the catalog is the no-connection fallback', () => {
  const offenders = [];
  for (const card of cards()) {
    for (const [field, placeholder] of Object.entries(PLACEHOLDERS)) {
      if (card[field] !== placeholder) offenders.push(`${card.id}.${field} = ${JSON.stringify(card[field])} (must be ${JSON.stringify(placeholder)} until a connection supplies a real one)`);
    }
    if (Array.isArray(card.modelList) && card.modelList.length > 0) {
      offenders.push(`${card.id}.modelList has ${card.modelList.length} invented model name(s); a catalog card has no way to have listed any`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the catalog is what a card shows when the gateway has no connection for that provider, so every ' +
      'number on it is a number nobody measured. Live figures arrive from the gateway and overwrite ' +
      'these. Invented metrics here are indistinguishable from real ones to the person reading them.',
  );
});

test('a card may claim OAuth only where the gateway has an OAuth flow to sign in with', () => {
  // The enforceable form of the clause AGENTS.md used to state aspirationally — and with a
  // parenthetical that had gone stale, since three providers have grown real flows since it was written.
  const claimOauth = cards().filter((card) => card.auth === 'OAuth').map((card) => card.id);
  const capable = oauthCapableProviders();
  const unsupported = claimOauth.filter((id) => !capable.has(id));
  assert.deepEqual(
    unsupported,
    [],
    `these cards claim an OAuth sign-in and the gateway has no start route for them: ${unsupported.join(', ')}. ` +
      'A card whose auth mode has no flow behind it must either gain the route or stop claiming the mode.',
  );
  // The other direction is deliberately not asserted: a provider can have an OAuth route and no OAuth
  // card, because an API key may also be accepted (Kiro does). That is a product choice, not a defect.
  assert.ok(claimOauth.length > 0, 'there are OAuth cards, so the check above is not vacuous');
});

test('every card has a mark or a letter to fall back on, and no card is listed twice', () => {
  const seen = new Map();
  const problems = [];
  for (const card of cards()) {
    if (seen.has(card.id)) problems.push(`${card.id} appears twice in the catalog`);
    seen.set(card.id, card);
    // The logo is written `logo: providerLogoMap.x`, so this is also the check that the map entry
    // exists — a card naming a key the map lacks resolves to `undefined`, and `undefined` in an
    // `img src` fails silently rather than loudly.
    //
    // A card with **no** logo is legitimate: `ProviderMark` takes `logo?` and falls back to
    // `initial`, which is how the user-defined `custom` card renders a tile. So the rule is a mark
    // *or* a letter, not a mark.
    const path = String(card.logo ?? '');
    if (path) {
      if (!path.startsWith('/providers/')) problems.push(`${card.id} has logo ${JSON.stringify(card.logo)}, which resolved to no bundled mark`);
      else if (!existsSync(join(ROOT, 'public', path.slice(1)))) problems.push(`${card.id} points at ${path}, which is not in public/`);
    } else if (!card.initial) {
      problems.push(`${card.id} has neither a bundled logo nor an initial, so ProviderMark has nothing to draw`);
    }
  }
  assert.deepEqual(problems, [], 'a card with no way to render a mark shows an empty tile, and a duplicate id renders twice and merges wrongly');
});

test('every card that pastes a credential has a descriptor, and its routes are real', () => {
  // Three files have to agree for a card's credential to be collectable: the card's `auth`, the
  // descriptor the dialog is driven by, and the gateway route that receives it. Nothing compared them.
  // `AddProviderModal` collects keys and endpoints, `WebCookieConnectDialog` is driven by the
  // descriptor table, and OAuth is a gateway route checked in its own test.
  const served = servedPaths();
  const problems = [];

  for (const descriptor of webSessionDescriptors()) {
    const declared = [descriptor.check, descriptor.paste].filter(Boolean);
    if (declared.length === 0) problems.push(`${descriptor.id} has a descriptor with no route at all, so the dialog would post nowhere`);
    for (const path of declared) {
      // Matched against the route table rather than a filename, so a route the gateway renamed stops
      // counting as a match and the descriptor is reported instead of silently 404ing in a browser.
      if (![...served].some((servedPath) => servedPath === path || servedPath.startsWith(path))) {
        problems.push(`${descriptor.id} posts to ${path}, which the gateway does not serve`);
      }
    }
  }

  // Every card whose credential is a pasted cookie needs an entry, keyed by the card's own id. A card
  // whose id is not in the table renders a dialog with no descriptor and a Save that goes nowhere.
  const descriptors = new Map(webSessionDescriptors().map((entry) => [entry.id, entry]));
  for (const card of cards()) {
    if (card.auth === 'API key' || card.auth === 'No key' || card.auth === 'OAuth') continue;
    if (!descriptors.has(card.id)) {
      problems.push(`${card.id} claims auth ${JSON.stringify(card.auth)} and nothing collects it: no descriptor with that id, and it is not an API key or an OAuth flow`);
    }
  }
  assert.deepEqual(problems, [], 'a card whose credential nothing collects will render a form that asks for nothing and a Save that goes nowhere');
});

test('no card claims an auth mode outside the set the collectors understand', () => {
  const known = new Set(['API key', 'No key', 'OAuth', 'Web cookie', 'Session cookie', 'Web session']);
  const used = [...new Set(cards().map((card) => card.auth))].sort();
  const unknown = used.filter((mode) => !known.has(mode));
  assert.deepEqual(unknown, [], `these auth modes are new: ${unknown.join(', ')}. Add the collector and say here what asks for the credential, or the card promises a flow that does not exist`);
  console.log(`    auth modes in use: ${used.join(', ')}`);
});

test('every provider the dialog can open is either a card or a declared exception, and never both', () => {
  // `AddProviderModal` used to re-declare `name`, `description`, `auth`, `color`, `initial`, `logo` and
  // the endpoint for ten providers, beside the catalog's own copy of the same fields. Seven of the seven
  // shared providers had two different descriptions, and the dialog's is the one a user reads while
  // pasting a key that will be transmitted to that vendor.
  //
  // The list is now derived from the catalog, so the only hand-written entries are the providers the
  // dialog can connect that have **no card** — `openai`, `anthropic`, `google`. This asserts that
  // exception list stays exactly what it claims to be: the moment a card is added for one of them, the
  // hand-written entry becomes a second copy free to disagree, and that is the state this whole change
  // exists to remove.
  const modal = stripComments(readFileSync(join(ROOT, 'src', 'components', 'AddProviderModal.tsx'), 'utf8'));
  const declared = [...(modal.slice(modal.indexOf('withoutCard: ProviderOption[] = [')).matchAll(/id: '([\w-]+)'/g) || [])].map((match) => match[1]);
  assert.ok(declared.length > 0, 'the exception list should still exist — a provider the gateway serves with no card');

  const cardIds = cards().map((card) => card.id);
  const shadowed = declared.filter((id) => cardIds.includes(id));
  assert.deepEqual(
    shadowed,
    [],
    `these have a hand-written dialog entry AND a catalog card: ${shadowed.join(', ')}. The card is the ` +
      'source of truth, so the entry is a second copy of eight fields waiting to disagree — which is ' +
      'how seven providers ended up with two different descriptions.',
  );
});

test('the neutral fallback is a named entry, not whichever option happens to be last', () => {
  // `customOption()` was `providerOptions[providerOptions.length - 1]`. That is a bet that the custom
  // entry is last, and when this list was first derived from the catalog the `custom` card fell out of
  // the group filter — so the last element became **Google**, and an unknown provider id would have
  // resolved to Google with Google's endpoint.
  //
  // That is the incident `resolveProviderOption`'s own comment documents — a key typed for one provider
  // transmitted to another — reintroduced by the fix for it. So the fallback is found by id, and this
  // asserts both halves: that the lookup is not positional, and that a `custom` entry exists to find.
  const modal = stripComments(readFileSync(join(ROOT, 'src', 'components', 'AddProviderModal.tsx'), 'utf8'));
  assert.equal(
    /providerOptions\s*\[\s*providerOptions\.length/.test(modal),
    false,
    'the neutral fallback is positional again, so the day the ordering changes it names a vendor',
  );
  assert.ok(
    /find\(\(item\) => item\.id === 'custom'\)/.test(modal),
    'the neutral fallback should be found by the id "custom"',
  );
  const customCard = cards().find((card) => card.id === 'custom');
  assert.ok(customCard, 'the catalog still has a card for a custom endpoint, which is what the fallback resolves to');
  // Read the declaration, not the first mention: the doc comment above it also names `eligibleGroups`
  // and `custom`, and slicing from the first occurrence picks the comment's words up as a second entry.
  const declaredGroups = modal.match(/eligibleGroups\s*=\s*new Set\(\[([^\]]*)\]\)/)?.[1]?.match(/'([\w-]+)'/g)?.map((value) => value.slice(1, -1)).sort();
  assert.deepEqual(
    declaredGroups,
    ['api-key', 'custom', 'local'],
    "the eligible groups must include 'custom' — leaving it out drops the neutral option from the dialog, " +
      'and the positional fallback that used to depend on it',
  );
});

test('THE COUNT, asserted so it cannot drift quietly', () => {
  // 13 cards, 12 of which were already honest and 1 of which was not. The number is the finding: a
  // single card out of thirteen is exactly the kind of defect a spot check misses and a reader trusts.
  const all = cards();
  assert.equal(all.length, 13, `the catalog now has ${all.length} cards`);
  assert.equal(oauthCapableProviders().size, 3, 'the gateway serves an OAuth start route for three providers');
  console.log(`    cards: ${all.length}   claiming OAuth: ${all.filter((c) => c.auth === 'OAuth').length}   gateway OAuth routes: ${oauthCapableProviders().size}   claiming a measurement: 0`);
});
