import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROVIDER_TOOLS, WEB_PROVIDERS, toolProviderIds } from '../Kernel/Tools/dist/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../Kernel/API/dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../Kernel/API/dist/src/core/index.js';

/**
 * The table against the catalogue.
 *
 * `Kernel/Tools/src/caps.ts` is a record of decisions, and a decision nobody has to make is a decision that gets
 * skipped. This test makes it impossible to add a provider card without saying whether that provider serves tools and
 * whether it can be told to force a call.
 *
 * The direction matters as much as the coverage: a row that no catalogue card and no registration names is a row that
 * will never be reached, and it makes the table look more complete than it is.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Providers the gateway serves that are not catalogue cards: the configurable base and the Zen alias. */
const NOT_A_CARD = new Set(['openai-compatible']);

/**
 * Ids the gateway actually registers, read from a live service rather than a grep of `service.ts`.
 *
 * `ProviderResolver.onDemandIds()` is the registry's own record of what it will resolve; a registration added in a
 * file the source-text guard does not recognise still appears here. TypeScript's `private` is a compile-time
 * annotation, so `service.providers` is the same object the constructor built.
 */
function gatewayIds() {
  const registry = new ProviderRegistry();
  const service = new GatewayService(registry, new InMemorySecretStore({}), new InMemoryConnectionStore(), new InMemoryApiKeyStore(), {});
  return [...new Set([...registry.list().map((adapter) => adapter.id), ...service.providers.onDemandIds()])];
}

function catalogIds() {
  const source = readFileSync(join(ROOT, 'src/data/providers.ts'), 'utf8');
  return [...source.matchAll(/^\s{4}id: '([^']+)'/gm)].map((match) => match[1]);
}

test('every catalogue and gateway provider has a row in the tool table', () => {
  const rows = new Set(toolProviderIds());
  const missing = [...new Set([...catalogIds(), ...gatewayIds()])].filter((id) => !rows.has(id));
  assert.deepEqual(missing, [], `providers with no tool decision: ${missing.join(', ')}`);
});

test('every row names a provider that exists', () => {
  const cards = new Set(catalogIds());
  const stale = toolProviderIds().filter((id) => !cards.has(id) && !NOT_A_CARD.has(id));
  assert.deepEqual(stale, [], `rows for providers nobody serves: ${stale.join(', ')}`);
});

test('every web card is marked as a web session with no tools', () => {
  const cards = new Set(catalogIds());
  for (const id of WEB_PROVIDERS) {
    assert.ok(cards.has(id), `${id} is listed as a web provider but is not a card`);
    assert.equal(PROVIDER_TOOLS[id].web, true);
    assert.equal(PROVIDER_TOOLS[id].tools, false);
  }
  // And the reverse: a card whose id ends in `-web` must be in the web list, so a new web provider cannot be added as
  // "just another API" and quietly inherit a tool contract that does not apply to it.
  const webShaped = [...cards].filter((id) => id.endsWith('-web'));
  for (const id of webShaped) {
    assert.ok(WEB_PROVIDERS.includes(id), `${id} looks like a web session but is not in WEB_PROVIDERS`);
  }
});

test('no row claims a tool_choice without serving tools, and none serves tools without a choice', () => {
  for (const [id, caps] of Object.entries(PROVIDER_TOOLS)) {
    if (caps.tools) assert.ok(caps.toolChoice.length > 0, `${id} serves tools but lists no tool_choice`);
    else assert.deepEqual(caps.toolChoice, [], `${id} serves no tools but lists ${caps.toolChoice.join('/')}`);
    if (caps.web) assert.equal(caps.tools, false, `${id} is a web session that claims to serve tools`);
  }
});
