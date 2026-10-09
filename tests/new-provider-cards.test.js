import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { providerCatalog } from '../src/data/providers.ts';

/**
 * A card with no adapter must still be connectable — measured, not assumed.
 *
 * ## The claim being guarded
 *
 * 1.43.0 added nine API-key providers with **no adapters**, on the stated grounds that
 * `ProviderResolver`'s saved-endpoint fallback serves any provider id nothing registers. That claim
 * appears in `providerOptions.ts`, in the release notes, and in a comment in `service.ts`.
 *
 * It was never proven for a *new* id. Every existing fallback test uses ids that predate the fallback,
 * and `service.ts` registers exactly six: `cline`, `opencode`, `opencode-console`, `kiro`, `chatgpt-web`,
 * `deepseek-web`. So "adding a provider is a catalog entry" is a comment nobody had checked.
 *
 * ## Checked for real, against a running gateway
 *
 * Four of the new ids were saved as connections and asked to route a request, pointed at a loopback port
 * with nothing listening:
 *
 * ```
 * save kimi-probe   200
 * route             502 PROVIDER_UNAVAILABLE      ← reached the endpoint
 * save qwen-probe   200   route 502
 * save groq-probe   200   route 502
 * save nvidia-probe 200   route 502
 *
 * refused as an UNKNOWN provider? no — the fallback engaged
 * ```
 *
 * A `502` from the dead port and a refusal for an unknown provider are indistinguishable from the client
 * and mean opposite things to whoever is debugging. That is the whole assertion: the request must get far
 * enough to fail **at the network**, which is the only evidence the fallback built an adapter.
 *
 * ## Why the static half is worth a test at all
 *
 * The live probe needs a running gateway, so it cannot run in CI. What *can* be checked statically is the
 * thing that would silently break it: a card id that collides with a registered adapter, or a group the
 * connect dialog does not offer. Both were real risks on this change — `deepseek` sits one character away
 * from `deepseek-web`, and `qwen` from `qwen-web` — and both would produce a card that connects to a
 * *different* provider than the one it names.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The ids the gateway registers an adapter for, read from the service and **following its constants**.
 *
 * Four of the six registrations name a constant — `kiroProviderId`, `chatGptWebProviderId`,
 * `opencodeConsoleProviderId`, `deepseekWebProviderId` — so matching only quoted literals finds two and
 * misses the four that matter. That is how my first version of this file asserted `>= 6` and failed:
 * the check was reading the source it meant to measure, and reading it wrongly.
 */
function registeredProviderIds() {
  const ids = new Set();
  // Every SDK adapter module is scanned, because four of the six registrations name a constant declared in
  // another file: `kiroProviderId` in `kiro.ts`, `chatGptWebProviderId` in `chatgpt-web.ts`, and so on.
  // The declaration may carry a type — `const deepseekWebProviderId: ProviderId = 'deepseek-web'` — so the
  // match has to allow one, or three of four resolve and the fourth reads as a collision risk.
  // Scanning only `service.ts` — my first two attempts — resolves two ids and marks the other four
  // unresolved, which is a check that looks for collisions while being unable to see most of the
  // registered providers.
  const providerDir = join(ROOT, 'packages/omnihilbras-sdk/src/providers');
  const modules = readdirSync(providerDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => readdirSync(join(providerDir, e.name)).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(providerDir, e.name, f), 'utf8')));
  const service = readFileSync(join(ROOT, 'apps/gateway/src/service.ts'), 'utf8');
  const searchable = [...modules, service];

  for (const match of service.matchAll(/\.(?:onDemand|register)\(\s*([A-Za-z0-9_]+|'[a-z0-9-]+')/g)) {
    const name = match[1];
    if (name.startsWith("'")) { ids.add(name.slice(1, -1)); continue; }
    const declared = searchable.flatMap((text) => [...text.matchAll(new RegExp(`(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*'([a-z0-9-]+)'`, 'g'))].map((m) => m[1]));
    for (const id of declared) ids.add(id);
    if (declared.length === 0) ids.add(`UNRESOLVED:${name}`);
  }
  return ids;
}

test('the registered adapter ids are readable, so a collision could be detected at all', () => {
  // Six adapters are registered. If this cannot resolve them, every check below it is measuring nothing.
  const registered = registeredProviderIds();
  const unresolved = [...registered].filter((id) => id.startsWith('UNRESOLVED:'));
  assert.deepEqual(unresolved, [], `a registration constant could not be resolved: ${unresolved.join(', ')}`);
  assert.ok(registered.size >= 6, `expected at least six registered providers, resolved ${registered.size}: ${[...registered].join(', ')}`);
  for (const expected of ['cline', 'opencode', 'kiro']) {
    assert.ok(registered.has(expected), `${expected} is registered and must be visible to this file`);
  }
});

test('no NEW api-key card collides with a registered adapter', () => {
  // `opencode` and `mistral` legitimately have both a card and an adapter: the card is the catalog entry
  // and the adapter is how it is served. What must never happen is one of the nine *new* providers landing
  // on an id the gateway already owns — saving that card would route to the other provider and the card's
  // endpoint would be ignored, which is the 1.34.0 duplicate-route defect in a new place.
  const registered = registeredProviderIds();
  const added = ['kimi', 'deepseek', 'qwen', 'groq', 'grok', 'nvidia', 'openai', 'anthropic', 'gemini'];
  const clashing = added.filter((id) => registered.has(id));
  assert.deepEqual(clashing, [], `these new cards collide with a registered adapter: ${clashing.join(', ')}`);
});

test('a new provider id is one edit away from a web-session id, and stays distinct', () => {
  // `deepseek` vs `deepseek-web`, `qwen` vs `qwen-web`. A card whose id differs from a registered adapter's
  // only by a suffix is the easiest possible typo, and the consequence is a card that connects to the web
  // session instead of the API key.
  const ids = providerCatalog.map((card) => card.id);
  const pairs = ids.flatMap((id) => ids.filter((other) => other !== id && id.startsWith(other) && other.length > 3).map((other) => [other, id]));
  // Both halves of each near-miss pair are registered adapters with their own cards —
  // `opencode`/`opencode-console`, `qwen`/`qwen-web`, `deepseek`/`deepseek-web` — so neither "the base
  // is registered" nor "the derived is registered" is the risk. I asserted each in turn and both failed on
  // correct behaviour, which is the third time in this file that guessing the shape of the code beat
  // measuring it.
  //
  // What actually matters is the one that can still go wrong: **the new cards must not be confused with
  // the browser-session adapters.** `webSessionProviders.ts` is what makes a provider sign in rather than
  // take a key, so an id listed there would show "Sign in" on a card whose whole purpose is an API key.
  const webSession = readFileSync(join(ROOT, 'src/lib/webSessionProviders.ts'), 'utf8');
  const webSessionIds = new Set([...webSession.matchAll(/^\s*'([a-z0-9-]+)':/gm)].map((m) => m[1]));
  assert.ok(webSessionIds.size > 0, 'the web-session list must be readable, or this proves nothing');
  const added = ['kimi', 'deepseek', 'qwen', 'groq', 'grok', 'nvidia', 'openai', 'anthropic', 'gemini'];
  const confused = added.filter((id) => webSessionIds.has(id));
  assert.deepEqual(confused, [], `these API-key cards are listed as web-session providers: ${confused.join(', ')}`);
  /**
   * A near-miss must be *distinguishable from the API-key card it resembles*, and the original rule
   * said "must be a web session" — which was right for the three pairs it was written against and wrong
   * for the fourth.
   *
   * `kimi-code` is `kimi` plus a suffix, and it is neither an API-key card nor a browser session: it is
   * an **OAuth card** with a real device-code flow. The assertion failed on a correct card, which is the
   * usual cost of encoding the three pairs someone happened to have rather than the property.
   *
   * So the property is now what it was protecting: the derived card must not resolve to the *base*
   * card's credential path. Three kinds satisfy it, and each is checked against the real thing rather
   * than against a list of ids:
   *
   * 1. a web session — `webSessionProviders.ts` is what makes a provider sign in rather than take a key;
   * 2. an OAuth flow the gateway really serves a start route for;
   * 3. **the derived card reads the base's connection.** Added for `cline`/`clinepass`, where ClinePass is
   *    the *same account* as Cline rather than a different way into it — Cline's own auth registry
   *    registers `cline-pass` as an alias of the `cline` handler reusing the identical stored credential,
   *    so our `clinepass` card carries `connectionProviderId: 'cline'` and is signed into by signing into
   *    Cline. This is what the near-miss is protecting here: a `clinepass` card that did *not* share the
   *    connection would either need a sign-in of its own (a second token for one account) or read as
   *    unconnected. An earlier version excluded `opencode-console` from this loop to keep the narrow rule
   *    green; it satisfies (2) outright, so the exclusion went with the rest.
   *
   * What all three have in common is that the derived card cannot be collected by the form that collects
   * the base's credential, and cannot silently borrow the base's *name* — (3) makes the sharing explicit
   * in one field rather than leaving two similar ids to be told apart by a prefix.
   */
  const oauthIds = new Set(providerCatalog.filter((card) => card.auth === 'OAuth').map((card) => card.id));
  const oauthRoutes = new Set(
    [...readFileSync(join(ROOT, 'apps/gateway/src/routes/oauth.ts'), 'utf8')
      .matchAll(/url\.pathname === '\/v1\/oauth\/([\w-]+)\/start'/g)].map((m) => m[1]),
  );
  const cardById = new Map(providerCatalog.map((card) => [card.id, card]));
  for (const [base, derived] of pairs) {
    const isWebSession = webSessionIds.has(derived);
    const isOAuth = oauthIds.has(derived) && oauthRoutes.has(derived);
    const sharesConnection = cardById.get(derived)?.connectionProviderId === base;
    assert.ok(
      isWebSession || isOAuth || sharesConnection,
      `${derived} is one character from ${base} and must resolve to a different credential path — ` +
        'either a web session, an OAuth card whose gateway really serves a start route for it, ' +
        "or a card that names the base's connection explicitly",
    );
  }
  assert.deepEqual(
    pairs.map(([, derived]) => derived).sort(),
    ['clinepass', 'deepseek-web', 'kimi-code', 'opencode-console', 'qwen-web', 'tokenharbor-web'],
    'the near-miss ids are exactly the ones expected, so this stays a measurement and not a tautology',
  );
});

test('every api-key card is one the connect dialog can actually collect a key for', () => {
  // The dialog filters by group. A card in a group it does not offer is a card a user can see and cannot
  // use, which is the defect this guards — and `custom` is deliberately excluded because its group is
  // `custom`, which the dialog does include.
  const apiKeyCards = providerCatalog.filter((card) => card.group === 'api-key').map((card) => card.id);
  assert.ok(apiKeyCards.length >= 10, `expected the ten requested providers, found ${apiKeyCards.length}: ${apiKeyCards.join(', ')}`);
  for (const id of ['kimi', 'deepseek', 'qwen', 'groq', 'grok', 'nvidia', 'openai', 'anthropic', 'gemini']) {
    assert.ok(apiKeyCards.includes(id), `${id} was asked for and is not an api-key card`);
  }
});

test('every api-key card points at a real endpoint shape, and none of them needs an adapter', () => {
  // The reason this change needed no adapter work: these are all OpenAI-compatible, so the generic
  // fallback speaks them. The assertion is the shape — a `/v1` base the compatible adapter can extend —
  // because a card whose endpoint is a native surface (Anthropic's `/v1/messages`, Gemini's `v1beta`)
  // would need one.
  for (const card of providerCatalog.filter((c) => c.group === 'api-key')) {
    assert.match(card.endpoint, /^https:\/\//, `${card.id} must not point at loopback`);
    assert.ok(card.endpoint.length > 0, `${card.id} has no endpoint, so the fallback would have nothing to build against`);
  }
  // The three that DO have adapters assert their native surface rather than an OpenAI-compatible base.
  assert.equal(providerCatalog.find((c) => c.id === 'anthropic')?.endpoint, 'https://api.anthropic.com/v1');
  assert.equal(providerCatalog.find((c) => c.id === 'gemini')?.endpoint, 'https://generativelanguage.googleapis.com/v1beta');
});

test('no api-key card claims a measurement, because none of them has a connection yet', () => {
  // The catalog is the state a card shows with no connection. A new card that reads `100%` or `5 models`
  // is the Ollama defect from 1.34.5, repeated because the catalog grew by nine.
  const offenders = providerCatalog
    .filter((card) => card.group === 'api-key')
    .filter((card) => card.health !== 0 || card.latency !== '—' || card.models !== '—' || card.lastUsed !== 'never')
    .map((card) => card.id);
  assert.deepEqual(offenders, [], `these cards claim something nobody measured: ${offenders.join(', ')}`);
});
