import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROVIDER_MANIFESTS } from '../Kernel/SDK/_shared/src/provider-manifests.ts';
import { PROVIDER_TOOLS } from '../Kernel/Tools/src/caps.ts';
import { PROVIDER_REGISTRY } from '../Kernel/Tools/src/providerRegistry.ts';
import { providerCatalog } from '../src/data/providers.ts';

/**
 * One description per provider, with three projections.
 *
 * The dashboard card, the tool capability row and the gateway registry row used to be three tables.
 * `tests/tools-caps.test.js` and `tests/provider-registry.test.js` compared them, which is how a card
 * without a row was caught — but comparison is not one source. This guard asserts the stronger
 * property: every projection is derived from `PROVIDER_MANIFESTS`, field for field, and no consumer
 * file carries a second literal table again.
 *
 * It reads the manifest and the projections directly (Node can import the `.ts` modules through the
 * root config), so a change to one without the other fails here before a build.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const byId = new Map(PROVIDER_MANIFESTS.map((manifest) => [manifest.id, manifest]));

test('the manifest covers every catalogue card, and only catalogue cards become cards', () => {
  assert.equal(providerCatalog.length, 71, 'the catalogue count changed');
  assert.equal(PROVIDER_MANIFESTS.length, 72, 'the manifest should hold 71 cards plus openai-compatible');
  assert.equal(PROVIDER_MANIFESTS.filter((manifest) => manifest.catalog).length, 71);
  for (const card of providerCatalog) {
    const manifest = byId.get(card.id);
    assert.ok(manifest, `${card.id} is a card with no manifest`);
    assert.equal(manifest.catalog, true, `${card.id} is not marked as a catalogue card`);
    assert.equal(card.name, manifest.name, `${card.id} name differs from the manifest`);
    assert.equal(card.description, manifest.description, `${card.id} description differs from the manifest`);
    assert.equal(card.auth, manifest.auth, `${card.id} auth label differs from the manifest`);
    assert.equal(card.endpoint, manifest.endpoint ?? '', `${card.id} endpoint differs from the manifest`);
    assert.deepEqual(card.modelList, [...manifest.modelList], `${card.id} model list differs from the manifest`);
  }
  assert.equal(byId.get('openai-compatible')?.catalog, false, 'the shared OpenAI base is a capability row, not a card');
});

test('every tool capability row is the manifest row, not a second table', () => {
  for (const [id, row] of Object.entries(PROVIDER_TOOLS)) {
    const manifest = byId.get(id);
    assert.ok(manifest, `capability row ${id} has no manifest`);
    assert.equal(row.tools, manifest.tools, `${id} tools differs`);
    assert.deepEqual([...row.toolChoice], [...manifest.toolChoice], `${id} toolChoice differs`);
    assert.equal(row.web, manifest.web, `${id} web differs`);
  }
  assert.equal(Object.keys(PROVIDER_TOOLS).length, PROVIDER_MANIFESTS.length, 'a manifest id has no capability row');
});

test('every registry row is the manifest row, not a second table', () => {
  for (const [id, row] of Object.entries(PROVIDER_REGISTRY)) {
    const manifest = byId.get(id);
    assert.ok(manifest, `registry row ${id} has no manifest`);
    assert.equal(row.baseUrl, manifest.baseUrl, `${id} base URL differs`);
    assert.equal(row.modelsUrl, manifest.modelsUrl, `${id} models URL differs`);
    assert.equal(row.usageUrl, manifest.usageUrl, `${id} usage URL differs`);
    assert.equal(row.auth, manifest.registryAuth, `${id} registry auth differs`);
    assert.deepEqual([...row.formats], [...(manifest.formats ?? [])], `${id} wire formats differ`);
  }
  const registryIds = new Set(Object.keys(PROVIDER_REGISTRY));
  const missing = PROVIDER_MANIFESTS.filter((manifest) => manifest.catalog && manifest.registryAuth && !registryIds.has(manifest.id));
  assert.deepEqual(missing.map((manifest) => manifest.id), [], 'catalogue cards with a registry field and no projected row');
});

test('the consumers carry no second literal table', () => {
  const caps = read('Kernel/Tools/src/caps.ts');
  assert.doesNotMatch(caps, /const OPENAI_WIRE/, 'the capability table has a second provider list again');
  assert.doesNotMatch(caps, /const PROVIDER_TOOLS: .* = \{/, 'the capability table is a literal again');
  const registry = read('Kernel/Tools/src/providerRegistry.ts');
  assert.doesNotMatch(registry, /baseUrl:\s*"https?:\/\//, 'the registry has a literal base URL again');
  const providers = read('src/data/providers.ts');
  assert.doesNotMatch(providers, /^\s{4}id: '/m, 'the dashboard catalogue is a literal again');
});
