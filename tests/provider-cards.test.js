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
const GATEWAY = join(ROOT, 'Kernel', 'API', 'src');

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
   * connection it shares. No card uses the second case today: ClinePass has its own route now that it
   * is a separate provider. The fallback remains because a genuinely shared account is still expressible
   * with `connectionProviderId`, and reading only the card's own id would call such a card "unsupported".
   */
  const servedBy = (card) => capable.has(card.id) || (card.connectionProviderId ? capable.has(card.connectionProviderId) : false);
  // `authModes` is the truth when a card offers more than one way in (Nous Research: sign-in **and**
  // API key), so a dual card is still checked against the route it claims.
  const claimsOauth = (card) => card.auth === 'OAuth' || card.authModes?.includes('oauth');
  const claimOauth = allCards.filter(claimsOauth);
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
      claimsOauth(cardById.get(card.connectionProviderId) ?? {}),
      `${card.id} shares ${card.connectionProviderId}'s connection, but that card is not an OAuth card`,
    );
  }
  // The other direction is deliberately not asserted: a provider can have an OAuth route and no OAuth
  // card, because an API key may also be accepted (Kiro does). That is a product choice, not a defect.
  assert.ok(claimOauth.length > 0, 'there are OAuth cards, so the check above is not vacuous');
});

test('the dashboard offers a sign-in only for a card whose route the gateway actually serves', () => {
  /**
   * The regression this exists for: an OAuth card whose start route the gateway did not serve used to
   * enable "Add connection", call the missing path, and open a tab that was never navigated — a dead
   * button with no error. ClinePass was the case while it borrowed Cline's connection; it has its own
   * route now and is listed on its own id.
   *
   * So the dashboard's OAuth set is checked against the gateway's real routes: each entry either has its
   * own start route, or names a `connectionProviderId` that does.
   */
  const gateway = stripComments(readFileSync(join(GATEWAY, 'routes', 'oauth.ts'), 'utf8'));
  const routes = new Set([...gateway.matchAll(/url\.pathname === '\/v1\/oauth\/([\w-]+)\/start'/g)].map((match) => match[1]));
  const page = stripComments(readFileSync(join(ROOT, 'src', 'pages', 'ProviderDetailPage.tsx'), 'utf8'));
  const listed = [...page.matchAll(/oauthProvidersWithFlow\s*=\s*new Set\(\[([^\]]*)\]\)/g)]
    .flatMap((match) => [...match[1].matchAll(/'([\w-]+)'/g)].map((id) => id[1]));
  assert.ok(listed.length > 0, 'the OAuth set must be readable, or this proves nothing');
  const cardById = new Map(cards().map((card) => [card.id, card]));
  const broken = listed.filter((id) => !routes.has(id) && !(cardById.get(id)?.connectionProviderId && routes.has(cardById.get(id).connectionProviderId)));
  assert.deepEqual(
    broken,
    [],
    `these cards enable a sign-in but neither they nor the connection they share has a start route: ${broken.join(', ')}. ` +
      'A card that shares another card\'s sign-in must name it as `connectionProviderId`, and the dialog must sign in as that owner.',
  );
  // And the dialog must actually be handed the owner's id, not the card's — the set being right is not
  // enough if the flow still calls the sibling's route.
  assert.match(
    page,
    /providerId=\{signInProviderId\}/,
    'the OAuth dialog must be given the connection owner\'s id, or a shared card calls a route that does not exist',
  );
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
    if (card.authModes?.some((mode) => mode === 'api-key' || mode === 'oauth')) continue;
    if (!descriptors.has(card.id)) {
      problems.push(`${card.id} claims auth ${JSON.stringify(card.auth)} and nothing collects it: no descriptor with that id, and it is not an API key or an OAuth flow`);
    }
  }
  assert.deepEqual(problems, [], 'a card whose credential nothing collects will render a form that asks for nothing and a Save that goes nowhere');
});

test('no card claims an auth mode outside the set the collectors understand', () => {
  const known = new Set(['API key', 'No key', 'OAuth', 'Web cookie', 'Session cookie', 'Web session', 'OAuth or API key', 'Session token']);
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
  // 25 from 1.75.0, which added `tokenharbor-web` — the web-session twin of the `tokenharbor` API-key
  // card, the same split as Anthropic versus Claude Code: one vendor, two credentials. (This line said
  // 1.73.0 until 1.85.1; there is no `v1.73.0` tag, and the card's commit is first contained by
  // `v1.75.0`, so the version a reader would look it up under did not exist.)
  // 26 from 1.76.0, which added `clinepass` — Cline's paid tier. It was modelled as a second card over
  // one connection because Cline's own client stores one token for the account; 3.71.0 makes it a
  // separate provider with its own connection, grant and model tier, after the shared record made its
  // card show Cline's catalog and usage.
  // 30 from 1.78.0, which added four free-tier aggregators — `apinex`, `apmix`, `tiarina`, `xkiro`, each
  // one key in front of other vendors' models over an OpenAI- or Anthropic-compatible path.
  // 31 from 1.85.0, which added `gemini-web` — a web session driving gemini.google.com with cookies the
  // user exports, so there is no API behind it at all.
  // Every one is OpenAI-compatible or already adapted, so each is a catalog card and no adapter work.
  // Mistral is **not** in that list — the catalog already had it, and the ten requested included it.
  //
  // **The log stopped at 26 and the assertion said 31 until 1.85.1**, so five cards were counted by a
  // number whose provenance ended five entries earlier — the drift this comment exists to prevent,
  // in the comment itself. The assertion is unchanged; the entries that explain it are now present.
  // 34-37 from 1.90.0, which added the `qoder`, `kilocode`, `minimax-code` and `minimax-code-global` OAuth
  // cards — four coding-agent subscriptions reached by device flow.
  // 38-39 added the `codebuddy-cn` and `codebuddy-intl` OAuth cards: one vendor, two regions on two
  // domains, because a sign-in on one side does not reach the other.
  // 40-47 from the free-tier wave: `agnes-ai`, `nous`, `beatapi`, `kiraai`, `vengetic`, `anyrouter`,
  // `zro` and `unorouter` — one key over an OpenAI-compatible path each, catalog cards and no adapter
  // work; three of the eight have no documented API surface and say so on the card.
  // 48-49 from 3.6.0: `agentrouter` and `aion-labs`, both keyed API cards in Free Tier Providers,
  // each with the vendor's own mark and no adapter work.
  // 50-51 from 3.7.0: `grok-web` and `perplexity-web`, the two web-cookie sessions ported from the
  // old tree; both have their own adapter and committed mark.
  // 55 from 3.28.0: `zcode`, a ZCode Start Plan OAuth card with its own adapter and standalone sign-in.
  // 59-60 added the `together` and `fireworks` keyed routers: generic OpenAI-compatible adapters
  // registered beside their validation decision, with no dedicated SDK package and no measured claims.
  // 61 added `xai` from the parity backlog: its own card, registry row, caps row and vault entry, with
  // no OAuth claim and no measured metrics until a connection reports them.
  // 62 added `claude` — the authorization-code + PKCE sibling of `claude-code`, with its own card,
  // adapter, caps row, sign-in routes and connection rather than borrowing the subscription's grant.
  // 63-67 from cycle 4: `sambanova`, `cerebras`, `siliconflow`, `nebius` and `perplexity`, five plain
  // API-key OpenAI-compatible routers from the 9router backlog. No measured card fields, no OAuth and
  // no client impersonation came with them; each has a caps row and a scripted transport test.
  // 68 from cycle 5: `glm`, a paid Z.ai coding-plan key on the plain OpenAI chat path, not the ZCode
  // Start Plan subscription and not a CLI OAuth grant. No Claude headers, client identity or measured
  // card field came with it; it has a caps row, an openAiRouter factory and a scripted transport test.
  // 69 from cycle 6: `glm-cn`, the mainland BigModel key on open.bigmodel.cn — a second product and a
  // second key, not an alias of glm's Z.ai key or the zcode subscription. No OAuth, client identity or
  // measured card field came with it; it has a caps row, a factory and a scripted transport test.
  // 70 from cycle 7: `mimo-free`, a plain API-key router whose published endpoint is the whole chat
  // path. No client impersonation, OAuth, model listing or measured card field came with it; it has a
  // caps row, an openAiRouter factory and a scripted transport test.
  assert.equal(all.length, 71, `the catalog now has ${all.length} cards`);
  // Eighteen cards claim OAuth and the gateway serves eighteen start routes. `clinepass` used to be
  // the odd one out when it shared Cline's connection; it has its own route now. `claude-code` and
  // `codex` sign in through `server.ts` routes this scan reads too.
  assert.equal(oauthCapableProviders().size, 18, 'the gateway serves an OAuth start route for eighteen providers');
  const oauthClaiming = all.filter((card) => card.auth === 'OAuth' || card.authModes?.includes('oauth'));
  assert.equal(oauthClaiming.length, 18, 'eighteen cards claim an OAuth sign-in: sixteen named OAuth, and Nous Research and the two OpenCode cards which offer it beside a key');
  console.log(`    cards: ${all.length}   claiming OAuth: ${oauthClaiming.length}   gateway OAuth routes: ${oauthCapableProviders().size}   claiming a measurement: 0`);
});

test('the Gemini Web driver checks the sign-in wall before the composer, because the composer check alone lied', () => {
  // **Measured, on this machine, with a bogus cookie.** Gemini's signed-out page carries hidden
  // contenteditable nodes, so `waitForSelector('.ql-editor, [contenteditable="true"]')` resolves truthy while
  // `locator('.ql-editor').count()` is 0 and a sign-in link is present:
  //
  //   ql-editor: 0   [contenteditable=true]: 0   sign-in link: 1   waitForSelector -> resolved truthy
  //
  // A check built on `waitForSelector` therefore reported a dead session as **connected** — the worst answer
  // this button can give, because the user saves a dead connection and finds out when a turn fails. The fix is
  // the sign-in wall first, and a composer that is counted *and* visible. This is asserted in source because it
  // is browser behaviour a node test cannot drive.
  const driver = readFileSync(join(GATEWAY, 'providers', 'geminiWeb.ts'), 'utf8');
  assert.match(driver, /signedOutLink/, 'the driver no longer looks for the sign-in wall at all');
  assert.match(driver, /isVisible\(\)/, 'the composer check no longer requires visibility, so a hidden element counts again');
  assert.doesNotMatch(driver, /waitForSelector\(GEMINI_WEB\.composer/, 'the composer is checked with waitForSelector, which resolves on a hidden node');
  // Both the check and the turn must look for the wall before the composer. Checked per function, because a
// single window spanning both would pass on the first path alone.
  const verifyBody = driver.slice(driver.indexOf('async verify('), driver.indexOf('async ask('));
  const askBody = driver.slice(driver.indexOf('async ask('));
  for (const [name, body] of [['verify', verifyBody], ['ask', askBody]]) {
    const wall = body.indexOf('signedOutLink');
    const composer = body.indexOf('GEMINI_WEB.composer');
    assert.ok(wall !== -1 && composer !== -1, `${name} no longer checks both the wall and the composer`);
    assert.ok(wall < composer, `${name} checks the composer before the sign-in wall, so a signed-out page can read as connected`);
  }
});

test('kimi stays the metered platform product and names kimi-code as the separate coding subscription', () => {
  // 9router's `kimi` id points at api.kimi.com/coding with an OAuth device flow. This project keeps two
  // products under two ids; repointing this card would merge a metered platform key with a subscription
  // grant. The guard is on the words the user reads and on the host the saved key is sent to.
  const cardsById = new Map(cards().map((card) => [card.id, card]));
  const kimi = cardsById.get('kimi');
  const code = cardsById.get('kimi-code');
  assert.ok(kimi && code, 'both Kimi products need a card');
  assert.match(kimi.description, /kimi-code/i, 'the kimi card must say the coding subscription is a separate product');
  assert.match(kimi.description, /metered|platform/i, 'the kimi card must say which product its key buys');
  assert.equal(kimi.auth, 'API key');
  assert.equal(kimi.endpoint, 'https://api.moonshot.ai/v1', 'the platform key must not be sent to the coding host');
  assert.equal(code.auth, 'OAuth', 'kimi-code remains the separate device-flow subscription');
  assert.equal(code.endpoint, 'https://api.kimi.com', 'the coding subscription has its own host');
  assert.ok(oauthCapableProviders().has('kimi-code'), 'the kimi-code sign-in route must exist');
});

test('the xAI card names the lanes this build really serves and does not claim the unserved ones', () => {
  // The cycle-4 provider comparison found a lane mismatch: the card said only "API-key service" while
  // this build really serves chat, streaming and async video jobs and 9router additionally advertises
  // OAuth, Responses, image config and search-via-chat. The honest fix is a sentence on the card, not a
  // simulated lane or a route nothing serves.
  const card = cards().find((entry) => entry.id === 'xai');
  assert.ok(card, 'the xai card is missing');
  const served = `${card.description ?? ''} ${card.riskNotice ?? ''}`.toLowerCase();
  for (const lane of ['chat', 'streaming', 'video']) {
    assert.ok(served.includes(lane), `the xai card does not name the ${lane} lane this build really serves`);
  }
  const notice = card.riskNotice ?? '';
  assert.match(notice, /not served/i, 'the unserved lanes must be stated as unserved, not left to inference');
  for (const lane of ['sign-in/OAuth', 'Responses API lane', 'image generation', 'search-via-chat']) {
    assert.ok(notice.includes(lane), `the xai card does not say that ${lane} is not served`);
  }
  assert.equal(card.auth, 'API key', 'xAI has no sign-in flow behind this card');
  assert.ok(!card.authModes?.includes('oauth'), 'xAI must not claim an OAuth mode on the card');
  assert.doesNotMatch(card.description, /oauth|responses|image generation|search-via-chat/i, 'the description must not advertise a lane the gateway does not route');
  assert.ok(!oauthCapableProviders().has('xai'), 'no /v1/oauth/xai/start exists, so the card must not imply one');
  assert.equal(card.endpoint, 'https://api.x.ai/v1', 'the card must name the host the adapter really uses');
});

test('glm is a paid Z.ai coding key, not the ZCode subscription or a CLI OAuth grant', () => {
  // The 9router registry entry for this id is dual-auth: an OpenAI chat key, a Claude-header lane
  // and a ZCode CLI OAuth flow. Only the first is honest to port here; the others are a different
  // product and, for the headers, an impersonation of the vendor's own client.
  const card = cards().find((entry) => entry.id === 'glm');
  assert.ok(card, 'the glm card is missing');
  const text = `${card.description ?? ''} ${card.riskNotice ?? ''}`.toLowerCase();
  assert.match(text, /paid|billed/, 'the card must say the coding-plan key costs money');
  assert.match(text, /zcode/, 'the card must name the Start Plan subscription it is not');
  assert.match(text, /not.*oauth|no.*oauth|not.*cli/, 'the card must say the CLI sign-in is not included');
  assert.equal(card.auth, 'API key');
  assert.ok(!card.authModes?.includes('oauth'), 'no OAuth route exists for glm');
  assert.equal(card.group, 'api-key', 'the key is collected by the keyed dialog');
  assert.equal(card.endpoint, 'https://api.z.ai/api/coding/paas/v4', 'the card must name the base the adapter appends /chat/completions to');
  assert.doesNotMatch(card.endpoint, /anthropic|claude/i, 'the Claude-header lane was not ported');
  assert.ok(!oauthCapableProviders().has('glm'), 'no /v1/oauth/glm/start exists');
});

test('glm-cn is the mainland BigModel key, a separate product from glm and zcode with no measured claims', () => {
  // The 9router registry entry is a plain `apikey` router: a base URL ending in /chat/completions,
  // no OAuth and no client-impersonation headers. Only the honest OpenAI-compatible slice is ported.
  const card = cards().find((entry) => entry.id === 'glm-cn');
  assert.ok(card, 'the glm-cn card is missing');
  const text = `${card.description ?? ''} ${card.riskNotice ?? ''}`.toLowerCase();
  assert.match(text, /bigmodel/, 'the card must name the host the key is sent to');
  assert.match(text, /glm/, 'the card must name the Z.ai key it is not');
  assert.match(text, /zcode/, 'the card must name the Start Plan subscription it is not');
  assert.match(text, /check cannot prove|no key validation/, 'the card must say Check cannot prove a pasted key');
  assert.equal(card.auth, 'API key');
  assert.ok(!card.authModes?.includes('oauth'), 'no OAuth route exists for glm-cn');
  assert.equal(card.group, 'api-key', 'the key is collected by the keyed dialog');
  assert.equal(card.endpoint, 'https://open.bigmodel.cn/api/coding/paas/v4', 'the card must name the base the adapter appends /chat/completions to');
  assert.notEqual(card.endpoint, cards().find((entry) => entry.id === 'glm')?.endpoint, 'glm-cn must not borrow glm\'s Z.ai endpoint');
  assert.equal(card.connectionProviderId, undefined, 'glm-cn keeps its own credential, not glm\'s');
  assert.ok(!oauthCapableProviders().has('glm-cn'), 'no /v1/oauth/glm-cn/start exists');
  for (const [field, placeholder] of Object.entries(PLACEHOLDERS)) {
    assert.equal(card[field], placeholder, `glm-cn claims a ${field} nobody measured`);
  }
  assert.deepEqual(card.modelList, [], 'glm-cn claims no model list');
});

test('every catalog card has a row in the generated provider defect register', () => {
  // The register is generated from the cards and the external registry; a card added without
  // regenerating leaves a row missing, which is the only way a new id can enter the product silently.
  const register = readFileSync(join(ROOT, 'docs', 'architecture', 'provider-defects.md'), 'utf8');
  const rows = new Set([...register.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]));
  const missing = providerCatalog.map((card) => card.id).filter((id) => !rows.has(id));
  assert.deepEqual(missing, [], `cards without a defect-register row: ${missing.join(', ')}`);
});
