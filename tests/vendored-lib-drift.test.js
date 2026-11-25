import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * The shared provider core is one package, not 56 copies.
 *
 * Phase A of the V4 platform plan moved `errors`, `url`, `streaming`, `bounded-map`, `model-normalize`
 * and the dead `index` re-export out of every `Kernel/SDK/<provider>/lib/` and into
 * `Kernel/SDK/_shared`. This guard is the replacement for the old "every copy is identical" test: a
 * copy that comes back is the drift, whether or not it happens to be byte-identical today.
 *
 * `types.ts`, `transport.ts` and `openai-compatible.ts` intentionally remain local until alpha.2,
 * where their variants are reconciled into one superset. This test names them so a reader does not
 * mistake their absence from the list for an oversight.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = join(ROOT, 'Kernel', 'SDK');
const SHARED = join(SDK, '_shared');

const sdkDirs = readdirSync(SDK, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => join(SDK, entry.name));

const moved = ['errors', 'url', 'streaming', 'bounded-map', 'model-normalize', 'index', 'types', 'transport', 'openai-compatible', 'responses-lane'];

test('no SDK package vendors a module the shared core owns', () => {
  const offenders = [];
  for (const dir of sdkDirs) {
    for (const name of moved) {
      const path = join(dir, 'lib', `${name}.ts`);
      if (existsSync(path)) offenders.push(relative(ROOT, path));
    }
  }
  assert.deepEqual(offenders, [], `these packages reintroduced a shared module instead of importing @omnihilbras/sdk-shared:\n${offenders.join('\n')}`);
});

test('the shared package carries the canonical modules and exports them', () => {
  const manifest = JSON.parse(readFileSync(join(SHARED, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@omnihilbras/sdk-shared');
  for (const name of ['errors', 'url', 'streaming', 'bounded-map', 'model-normalize', 'types', 'index']) {
    assert.ok(existsSync(join(SHARED, 'src', `${name}.ts`)), `the canonical ${name}.ts is missing`);
  }
  for (const name of ['errors', 'url', 'streaming', 'bounded-map', 'model-normalize', 'types']) {
    assert.ok(manifest.exports?.[`./${name}`], `package.json does not export ./${name}`);
  }
});

test('every provider package depends on the shared core', () => {
  const missing = [];
  for (const dir of sdkDirs) {
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.dependencies?.['@omnihilbras/sdk-shared'] !== 'workspace:*') missing.push(relative(ROOT, manifestPath));
  }
  assert.deepEqual(missing, [], `these packages do not depend on @omnihilbras/sdk-shared:\n${missing.join('\n')}`);
});

test('no source imports a removed local shared module', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const text = readFileSync(path, 'utf8');
      for (const name of moved) {
        if (new RegExp(`from '(?:\\.\\.?/)+lib/${name}\\.js'`).test(text) || new RegExp(`from '\\./${name}\\.js'`).test(text)) {
          offenders.push(`${relative(ROOT, path)} -> ${name}`);
        }
      }
    }
  };
  for (const dir of sdkDirs) walk(dir);
  assert.deepEqual(offenders, [], `these imports still point at a deleted vendored module:\n${offenders.join('\n')}`);
});

test('the only remaining lib files are provider-specific', () => {
  // The shared core owns every module with no reason to vary. What is left is the machinery of one
  // provider or a pair that share a wire, and each name here is a deliberate exception.
  const allowed = new Set([
    'anthropic.ts', 'cline.ts', 'constants.ts', 'deepseek-pow.ts', 'encoding.ts', 'identity.ts',
    'pricing.ts', 'responses-tools.ts', 'startPlanTemplate.ts', 'zen-adapter.ts', 'zen-free-tier.ts',
  ]);
  const unexpected = [];
  for (const dir of sdkDirs) {
    const lib = join(dir, 'lib');
    if (!existsSync(lib)) continue;
    for (const file of readdirSync(lib)) {
      if (file.endsWith('.ts') && !file.endsWith('.d.ts') && !allowed.has(file)) unexpected.push(relative(ROOT, join(lib, file)));
    }
  }
  assert.deepEqual(unexpected, [], `these lib files are neither shared-core modules nor named provider-specific exceptions:\n${unexpected.join('\n')}`);
});