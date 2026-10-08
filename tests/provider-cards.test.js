import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { providerCatalog } from '../src/data/providers.ts';
import { WEB_SESSION_PROVIDERS } from '../src/lib/webSessionProviders.ts';

/**
 * The provider cards tell the truth about what has actually happened.
 *
 * ## The data here is imported, not scraped
 *
 * The first version of this file parsed `src/data/providers.ts` with a regular expression — twenty-odd
 * lines of `matchAll` over object literals, re-implementing a parser and therefore agreeing with it
 * wherever the parser was wrong. `providers.ts` and `webSessionProviders.ts` are plain modules with no
 * JSX, and Node imports a type-erased `.ts` file directly, so the catalog is now **read from the
 * product** rather than re-derived from its text.
 *
 * That is only possible because `allowImportingTsExtensions` is on — it requires `noEmit`, which the
 * root tsconfig already had — so a module can import `'../data/providers.ts'` and Node can follow it.
 * The gateway is a compiled package and is still read as text, which is a real limit rather than a
 * preference: its `dist/` is what runs, and its route table is built by string comparison at runtime.
 *
 * ## The rule, and the part of it that was not true
 *
 * `AGENTS.md` says a card with no connection stays `status: 'available'` with `—` metrics. Twelve of the
 * thirteen cards did that. One did not:
 *
 * ```
 * id: 'ollama'   status: 'attention'   models: '6 models'
 * latency: '92 ms'   requests: '1,417'   lastUsed: '2 min ago'
 * health: 72   modelList: ['qwen3-coder', 'llama3.2', 'nomic-embed-text']
 * ```
 *
 * The numbers were invented, left over from when the dashboard was a static mockup.
 * `ProvidersPage` seeds from this catalog and `mergeGatewayConnections` overlays only providers that have
 * a connection, so a card here is exactly what a user sees when the gateway has never been asked about
 * that provider. A user who had never run Ollama was shown a plausible week of traffic for it.
 *
 * **The catalog is the no-connection fallback, so no card in it may claim a measurement.** That is a
 * property of the data rather than an instruction about a UI state, which is the only reason it can be
 * asserted: if a card's number could only have come from a measurement, and the catalog is shown
 * precisely when there is nothing to measure, then the number was invented.
 *
 * A card claiming `auth: 'OAuth'` must have a matching `/v1/oauth/:id/start` route — the enforceable form
 * of a rule that used to say "an auth mode with no flow (currently `OAuth`) must disable Save in
 * `AddProviderModal`". `canSave` is computed from form fields alone and never knew about flows, and the
 * parenthetical had gone false: three providers have since grown real OAuth flows. The
 * `AddProviderModal` half is recorded in `AGENTS.md` as a requirement that was never implemented, with no
 * mode to trigger it today, rather than left as a claim about code that does not exist.
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

/**
 * The one card allowed to carry model names, and why it is not the same as Ollama's invented ones.
 *
 * `qwen-web` lists `qwen3.7-plus`, `qwen3.8-max` and `qwen3.8-omni-flash`, and the comment beside it
 * records where they came from: read from `GET /api/v2/models/`, which answers guests, returning three
 * consistently — and seven to someone else minutes later, which is why the card calls it a dated snapshot
 * rather than a promise and the connect dialog shows the live list instead. **Those are measured names
 * with their provenance written down.**
 *
 * Ollama's three were different: fabrications for a static mockup, with nothing behind them, and a card
 * claiming `1,417` requests beside them. A mechanical rule cannot tell those apart — "a list of model
 * names in a catalog file" is the same shape in both cases — so the distinction is recorded here, with
 * the reasoning, and the count is asserted so a second list is a decision rather than an accident.
 */
const MEASURED_MODEL_LISTS = {
  'qwen-web': 'read from GET /api/v2/models/ on a guest request; the card calls it a dated snapshot and the dialog shows the live list',
};

const cards = () => providerCatalog;
const webSessionDescriptors = () => Object.entries(WEB_SESSION_PROVIDERS).map(([id, descriptor]) => ({
  id,
  check: descriptor.check?.path,
  paste: descriptor.paste?.path,
}));

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
    if (Array.isArray(card.modelList) && card.modelList.length > 0 && !(card.id in MEASURED_MODEL_LISTS)) {
      offenders.push(`${card.id}.modelList has ${card.modelList.length} model name(s) and is not in MEASURED_MODEL_LISTS. A catalog card ` +
        'has no way to have listed any, unless the list is a dated observation someone recorded and said where it came from.');
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
  const allCards = cards();
  const capable = oauthCapableProviders();
  const cardById = new Map(allCards.map((card) => [card.id, card]));
  /**
   * A card is signed into if the gateway serves a start route for it **or** for the card whose
   * connection it shares. `clinepass` is the second case: it has no route of its own because its sign-in
   * *is* Cline's — Cline's auth registry registers `cline-pass` as an alias of the `cline` handler — so
   * `connectionProviderId: 'cline'` points at the route that serves it. Reading only the card's own id
   * would call a correctly-signed-in card "unsupported".
   */
  const servedBy = (card) => capable.has(card.id) || (card.connectionProviderId ? capable.has(card.connectionProviderId) : false);
  const claimOauth = allCards.filter((card) => card.auth === 'OAuth');
  const unsupported = claimOauth.filter((card) => !servedBy(card)).map((card) => card.id);
  assert.deepEqual(
    unsupported,
    [],
    `these cards claim an OAuth sign-in and the gateway has no start route for them: ${unsupported.join(', ')}. ` +
      'A card whose auth mode has no flow behind it must either gain the route or stop claiming the mode.',
  );
  // The shared route must point at a real OAuth card, not an arbitrary id — otherwise the escape hatch
  // above would accept any string.
  for (const card of claimOauth) {
    if (!card.connectionProviderId) continue;
    assert.ok(
      cardById.get(card.connectionProviderId)?.auth === 'OAuth',
      `${card.id} shares ${card.connectionProviderId}'s connection, but that card is not an OAuth card`,
    );
  }
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

// The two checks that used to live here — "the dialog's exception list must not shadow a card", and
// "the neutral fallback must not be positional" — are gone from this file, and were replaced rather than
// duplicated. They were text checks over `AddProviderModal.tsx` because the logic was trapped in a view
// that nothing could import. It now lives in `src/lib/providerOptions.ts`, so
// `tests/provider-options.test.js` **calls** it: the neutral fallback is proved to resolve to `custom` for
// twelve malformed inputs, proved to point at localhost, and proved not to be positional by the fact
// that it never returns anything else. A source-shape check and a behavioural check for the same
// guarantee is two places to keep in step, which is the defect class this whole refactor has been about.
//
// What remains here needs the catalog file itself: the gateway is a compiled package, so its route table
// is read as text, and that is a real limit rather than a preference.

test('THE COUNT, asserted so it cannot drift quietly', () => {
  // 13 cards, 12 of which were already honest and 1 of which was not. The number is the finding: a
  // single card out of thirteen is exactly the kind of defect a spot check misses and a reader trusts.
  const all = cards();
  // 13 until 1.43.0, then 22: Kimi, DeepSeek, Qwen, Groq, Grok, NVIDIA, OpenAI, Anthropic and Gemini.
  // 23 from 1.71.0, which added `kimi-code` — the Kimi *subscription*, which is a separate account
  // with separate billing from the `kimi` platform card rather than a second auth mode on it.
  // 24 from 1.72.0, which added `claude-code` — the same shape again: the Claude *subscription*,
  // reached by OAuth, is a separate account from the metered `anthropic` API key.
  // 25 from 1.73.0, which added `tokenharbor-web` — the web-session twin of the `tokenharbor` API-key
  // card, the same split as Anthropic versus Claude Code: one vendor, two credentials.
  // 26 from 1.76.0, which added `clinepass` — the *same* account as the `cline` OAuth card, not a second
  // credential: same vendor, same host, and Cline's own auth registry registers `cline-pass` as an alias
  // of the `cline` handler reusing the identical stored credential. So it is a second *card* over one
  // connection (`connectionProviderId: 'cline'`), the opposite of every pair above.
  // Every one is OpenAI-compatible or already adapted, so each is a catalog card and no adapter work.
  // Mistral is **not** in that list — the catalog already had it, and the ten requested included it.
  assert.equal(all.length, 26, `the catalog now has ${all.length} cards`);
  // Six cards claim OAuth, but the gateway serves **five** start routes: `clinepass` shares `cline`'s,
  // which is why the count of routes and the count of claims no longer coincide.
  assert.equal(oauthCapableProviders().size, 5, 'the gateway serves an OAuth start route for five providers');
  assert.equal(all.filter((card) => card.auth === 'OAuth').length, 6, 'six cards claim OAuth, one of them over a shared route');
  console.log(`    cards: ${all.length}   claiming OAuth: ${all.filter((c) => c.auth === 'OAuth').length}   gateway OAuth routes: ${oauthCapableProviders().size}   claiming a measurement: 0`);
});
