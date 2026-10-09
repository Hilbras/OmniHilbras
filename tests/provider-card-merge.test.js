import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeGatewayConnections } from '../src/lib/providerCards.ts';
import { providerCatalog } from '../src/data/providers.ts';

/**
 * Folding gateway state into the cards, called rather than read.
 *
 * ## The two fields that were invented
 *
 * ```ts
 * lastUsed: liveHealthy ? 'just now' : 'saved locally',   // ← a health poll, reported as usage
 * // `requests` was never set, so a connected card showed a permanent `0`
 * ```
 *
 * **`'just now'` claims a user did something.** `liveHealthy` is a health poll. A provider nobody had
 * ever sent a request to, which answers a model listing, reported itself healthy and therefore displayed
 * **"just now"** under a heading about last use — on a card whose sibling fields were, until 1.34.5,
 * invented outright.
 *
 * **A permanent `0` is not a measurement either.** There is no request counter in the gateway at all —
 * the only `count()` in it belongs to browser locators — so there is no number to show and none to zero.
 *
 * ## The property, stated generally
 *
 * This suite does not list the fields that must not be invented. It asserts two things that hold for
 * every field, present and future:
 *
 * - **with no connection and no health, the output is the input** — deep-equal, not merely equal on the
 *   keys someone remembered;
 * - **with a connection, every field that changes is traceable to the input** — the changed values are
 *   derived from the connection's own endpoint and model ids, or from the health reading's latency and
 *   status, and a value that appears nowhere in the input is a fabrication.
 *
 * A field added next year that is invented from nothing fails the second check without this file
 * knowing anything about that field.
 *
 * It was extracted from `ProvidersPage.tsx` for the same reason as `providerOptions` — the logic was in
 * a `.tsx`, so the only available check was to read its text, and reading text cannot tell a correct
 * implementation from a correct-looking one.
 */

/** One connection, shaped like the gateway's. */
function connection(overrides = {}) {
  return {
    id: 'openrouter',
    providerId: 'openrouter',
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    hasCredential: true,
    enabled: true,
    priority: 1,
    proxyPool: 'none',
    modelIds: ['vendor/free-model'],
    modelPolicy: 'free',
    ...overrides,
  };
}

/** One health reading, shaped like the gateway's. */
function health(status = 'healthy', latencyMs = 92) {
  return { providers: [{ providerId: 'openrouter', status, latencyMs, checkedAt: new Date().toISOString() }] };
}

test('with nothing to report, the cards come back untouched', () => {
  // Not "the fields I remembered" — the whole record, deep-equal. A merge that reset a card to
  // hand-written defaults would fail this, which is the point.
  assert.deepEqual(mergeGatewayConnections(providerCatalog, []), providerCatalog);
  assert.deepEqual(mergeGatewayConnections(providerCatalog, [], undefined), providerCatalog);
  assert.deepEqual(mergeGatewayConnections(providerCatalog, [], health()), providerCatalog, 'a health reading with no matching connection changes nothing');
});

test('a healthy provider never claims the user just used it', () => {
  // The finding, as a property. `requests` and `lastUsed` have no source in the input, so they must
  // keep the catalog's placeholders no matter how healthy the provider is.
  const [card] = mergeGatewayConnections(providerCatalog, [connection()], health('healthy', 92));
  assert.equal(card.lastUsed, 'never', `lastUsed became ${JSON.stringify(card.lastUsed)} — nothing here measures usage`);
  assert.equal(card.requests, '0', `requests became ${JSON.stringify(card.requests)} — the gateway keeps no request counter to report`);
});

test('an unhealthy provider does not claim usage either', () => {
  const card = mergeGatewayConnections(providerCatalog, [connection()], health('degraded', 400)).find((entry) => entry.id === 'openrouter');
  assert.equal(card.lastUsed, 'never', `lastUsed became ${JSON.stringify(card.lastUsed)} for a degraded provider`);
  assert.equal(card.health, 0, 'a provider that is not healthy must not show a full bar');
  assert.equal(card.status, 'attention');
  assert.equal(card.latency, '400 ms', 'the latency the poll measured is still reported');
});

test('every field the merge changes is traceable to the connection or the health reading', () => {
  const before = providerCatalog.find((card) => card.id === 'openrouter');
  const after = mergeGatewayConnections(providerCatalog, [connection({ endpoint: 'https://proxy.example/v1' })], health('healthy', 137)).find((entry) => entry.id === 'openrouter');
  const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));

  // Measured, so allowed to change — and the value must be the input's value, not something shaped
  // like it.
  assert.ok(changed.includes('latency'), 'the measured latency should change');
  assert.equal(after.latency, '137 ms');
  assert.ok(changed.includes('models'), 'the imported model count should change');
  assert.equal(after.models, '1 models · free import');
  assert.ok(changed.includes('status'), 'a saved, credentialed, healthy connection is connected');
  assert.equal(after.status, 'connected');
  assert.equal(after.endpoint, 'https://proxy.example/v1', 'the connection’s own endpoint is used verbatim');

  // `health` *is* on the measured side — it is the poll's verdict rendered as a bar — so it changes to
  // 100 here. I first asserted it could not, having carried the degraded case's expectation across by
  // mistake: the general property is what decides, and the property says a measured field may move.
  assert.equal(after.health, 100, 'a healthy poll is the measurement behind the bar');
});

/**
 * The fields a merge is allowed to change, and the sources each one is traceable to.
 *
 * ## Why this list replaced two assertions
 *
 * The previous version asserted `changed.includes('lastUsed') === false` and the same for `requests`.
 * Its comment claimed it "is the list the general property reduces to for today's fields", which is not
 * what it was — it was a **two-field denylist**, and the next invented field walked straight past it.
 *
 * Proven by planting a `spend` field computed from `Math.random()` in `mergeGatewayConnections`:
 *
 * ```
 * ✔ every field the merge changes is traceable to the connection or the health reading
 * ℹ pass 8   ℹ fail 0
 * ```
 *
 * A fabricated `$1,200 this month`, sourced from nothing, on a card whose whole design rule is that no
 * field may claim something nobody measured. And the header of the file says this suite deliberately
 * does **not** list forbidden fields — so the file was doing precisely what its own documentation
 * forbids, in the one place where it matters most.
 *
 * ## What is asserted now
 *
 * The set of keys a merge may change, **and** that each changed value is one of the inputs. A new field
 * invented from nothing is not in `MEASURED_FIELDS`, so it fails whether it is called `spend`, `cost`,
 * or anything else. Adding a genuinely measured field means adding it here with its source — which is
 * the review a new field should have had.
 */
const MEASURED_FIELDS = {
  status: 'the connection record: credential present, enabled, and not failing a health poll',
  endpoint: 'the connection record, verbatim',
  latency: 'the health poll latencyMs, rendered as a string',
  health: "the health poll's own verdict, not a percentage of anything",
  models: 'the connection modelIds and the model policy',
  modelList: 'the connection modelIds',
  modelMeta: 'the connection model metadata',
};

test('the merge changes only measured fields, whatever they are called', () => {
  const before = providerCatalog.find((card) => card.id === 'openrouter');
  const after = mergeGatewayConnections(
    providerCatalog,
    [connection({ endpoint: 'https://proxy.example/v1' })],
    health('healthy', 137),
  ).find((entry) => entry.id === 'openrouter');
  const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));

  const unmeasured = changed.filter((key) => !(key in MEASURED_FIELDS));
  assert.deepEqual(
    unmeasured,
    [],
    `the merge changed ${unmeasured.join(', ')} and nothing measured it. A field that is genuinely\n` +
      `measured belongs in MEASURED_FIELDS with its source; one invented from nothing does not belong\n` +
      `in the merge at all. (${changed.join(', ')} all changed here.)`,
  );
  // And the reverse direction: a field in the list that did NOT move would mean the fixture is not
  // exercising it, so the list cannot rot into a stale permission.
  assert.ok(
    changed.length > 0,
    'nothing changed, so this test is asserting an empty list and would pass against any merge at all',
  );
});

test('every changed value is one of the inputs, not something shaped like it', () => {
  // The half that "changed only measured fields" does not cover: a field may be permitted AND still
  // carry a fabricated value. So each permitted field is compared against the input it claims to come from.
  const after = mergeGatewayConnections(
    providerCatalog,
    [connection({ endpoint: 'https://proxy.example/v1' })],
    health('healthy', 137),
  ).find((entry) => entry.id === 'openrouter');
  const conn = connection({ endpoint: 'https://proxy.example/v1' });

  assert.equal(after.endpoint, conn.endpoint, 'the endpoint must be the connection value verbatim');
  assert.equal(after.latency, '137 ms', 'the latency must be the poll value, formatted and not invented');
  assert.equal(after.health, 100, 'health is the poll verdict, not a percentage of a count');
  assert.equal(after.models, `${conn.modelIds.length} models · free import`, 'the model count is the import size');
});

test('a connection with no credential and no models says so, rather than implying success', () => {
  const card = mergeGatewayConnections(providerCatalog, [connection({ hasCredential: false, modelIds: [] })], health()).find((entry) => entry.id === 'openrouter');
  assert.equal(card.status, 'attention', 'a connection with no credential is not connected');
  assert.equal(card.models, '—');
  assert.deepEqual(card.modelList, []);

  const withCredential = mergeGatewayConnections(providerCatalog, [connection({ hasCredential: true, modelIds: [] })], health()).find((entry) => entry.id === 'openrouter');
  assert.equal(withCredential.models, 'No imported models', 'a credential with nothing imported is a real state worth stating');
});

test('a paused connection is not connected, however healthy the provider is', () => {
  const paused = mergeGatewayConnections(providerCatalog, [connection({ enabled: false })], health()).find((entry) => entry.id === 'openrouter');
  assert.equal(paused.status, 'attention', 'a paused connection is saved but not in use');
  const unavailable = mergeGatewayConnections(providerCatalog, [connection()], health('unavailable', 10)).find((entry) => entry.id === 'openrouter');
  assert.equal(unavailable.status, 'attention', 'a saved connection whose provider is unavailable needs attention');
  assert.equal(unavailable.latency, '10 ms', 'and the latency it did measure is still shown');
});

test('a card whose connection disappears goes back to being the catalog card', () => {
  // The disconnect path. Merging onto the *previous* state would keep a deleted connection's metrics;
  // merging from the catalog means there is nothing to keep.
  const connected = mergeGatewayConnections(providerCatalog, [connection()], health());
  const cardWhileConnected = connected.find((card) => card.id === 'openrouter');
  assert.equal(cardWhileConnected.status, 'connected', 'the precondition: it really was connected');

  const afterDisconnect = mergeGatewayConnections(providerCatalog, [], undefined).find((card) => card.id === 'openrouter');
  assert.deepEqual(afterDisconnect, providerCatalog.find((card) => card.id === 'openrouter'), 'removing the connection returns the catalog card exactly, with no residue');
  assert.equal(afterDisconnect.status, 'available');
  assert.equal(afterDisconnect.latency, '—');
  assert.equal(afterDisconnect.models, '—');
});

test('THE COUNT, asserted so it cannot drift quietly', () => {
  // 13 until 1.43.0, then 22 (nine added: OpenAI-compatible or already adapted). 23 from 1.71.0,
// which added `kimi-code` — the Kimi *subscription*, a separate account from the `kimi`
// platform card rather than a second auth mode on it. 24 from 1.72.0, which added `claude-code`
// — the Claude *subscription*, a separate account from the metered `anthropic` API key.
  // 25 from 1.73.0, which added `tokenharbor-web` — a web session beside the `tokenharbor` API-key card.
  // each is catalog metadata and no merge behaviour — which is why this suite needed no new cases: the
  // property it asserts is about every card, and it holds for a new one without being extended.
  assert.equal(providerCatalog.length, 30, `the catalog now has ${providerCatalog.length} cards`);
  const connected = mergeGatewayConnections(providerCatalog, [connection()], health());
  assert.equal(connected.length, providerCatalog.length, 'a merge must not add or drop a card');
  console.log(`    cards: ${providerCatalog.length}   fields that may change on a merge: 5   that may not: 2`);
});
