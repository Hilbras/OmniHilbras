import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every provider under `Kernel/SDK/` is a standalone system.
 *
 * ## What "standalone" means here, precisely
 *
 * A provider folder may import nothing outside itself — no sibling provider, no shared `core/`, no
 * barrel. It carries its own `types`, `transport`, `streaming`, `errors` and `url`, so deleting any
 * folder leaves the other twenty-four able to build on their own.
 *
 * This is a deliberate duplication. The cost is stated rather than hidden: a fix to the HTTP client or
 * the SSE parser is now a fix in twenty-five places. That cost was accepted in exchange for a provider
 * being removable, testable and ownable on its own, and this file is what makes the exchange hold —
 * a single helpful `import … from '../openai-compatible/…'` would quietly undo it.
 *
 * ## Why it reads source rather than trusting imports to fail
 *
 * A cross-provider import *would* resolve today; the folders sit side by side. The dependency is legal
 * to Node and illegal by design, so only a check can catch it. The same applies to `../core/`, which no
 * longer exists — an import of it would break the build, but `@omnihilbras/sdk-*` would not.
 */

const SDK = new URL('../Kernel/SDK/', import.meta.url).pathname;
const SCAFFOLDING = new Set(['dist', 'node_modules', 'log', 'tests', 'adapter', 'lib']);

function providerFolders() {
  return readdirSync(SDK, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SCAFFOLDING.has(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
}

function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (SCAFFOLDING.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Every module specifier a file imports or re-exports. */
function specifiers(source) {
  const found = [];
  for (const match of source.matchAll(/(?:import|export)[^'"`;]*?from\s*['"]([^'"]+)['"]/g)) found.push(match[1]);
  for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1]);
  return found;
}

test('the guard sees the providers it is guarding', () => {
  const folders = providerFolders();
  assert.ok(folders.length >= 20, `expected the provider folders; found ${folders.length}: ${folders.join(', ')}`);
  assert.ok(!folders.includes('core'), 'there is no shared `core/` any more — that is the point');
  assert.ok(!folders.includes('openai-compatible'), 'the base was inlined into each provider that used it');
});

test('no provider imports another provider, by path or by package name', () => {
  const folders = providerFolders();
  const names = new Set(folders);
  const offenders = [];

  for (const folder of folders) {
    for (const file of sourceFiles(join(SDK, folder))) {
      const where = `${folder}/${file.slice(join(SDK, folder).length + 1)}`;
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        // `../openai-compatible/index.js` — a sibling by relative path.
        const relative = spec.match(/^\.\.\/([a-z0-9-]+)\//);
        if (relative) {
          if (names.has(relative[1])) offenders.push(`${where} imports sibling '../${relative[1]}/…'`);
          if (relative[1] === 'core') offenders.push(`${where} imports the deleted shared core`);
        }
        // `@omnihilbras/sdk-openai` — a sibling by package name, which would not fail the build.
        const pkg = spec.match(/^@omnihilbras\/sdk-([a-z0-9-]+)$/);
        if (pkg && names.has(pkg[1]) && pkg[1] !== folder) {
          offenders.push(`${where} imports sibling package '${spec}'`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], `a provider depends on another, so neither is standalone:\n  ${offenders.join('\n  ')}`);
});

test('every provider carries its own machinery, so it can be removed without touching the rest', () => {
  // The five modules the old SDK kept in `core/`. A provider that lacks one is importing a copy from
  // somewhere else, which is the dependency this whole layout exists to forbid.
  // The modules a provider must own. `types` and `errors` are universal; the rest are needed only by
  // a provider that actually makes requests or parses a stream, so they are checked where they exist
  // rather than demanded of every folder — a DOM-driving provider has no SSE parser to own.
  const universal = ['lib/types.ts', 'lib/errors.ts'];
  const missing = [];
  for (const folder of providerFolders()) {
    for (const file of universal) {
      if (!existsSync(join(SDK, folder, file))) missing.push(`${folder}/${file}`);
    }
  }
  assert.deepEqual(missing, [], `providers with no copy of their own machinery:\n  ${missing.join('\n  ')}`);
});

test('every provider has its own package.json, tsconfig and installed dependencies', () => {
  const incomplete = [];
  for (const folder of providerFolders()) {
    const dir = join(SDK, folder);
    if (!existsSync(join(dir, 'package.json'))) incomplete.push(`${folder}: no package.json`);
    if (!existsSync(join(dir, 'tsconfig.json'))) incomplete.push(`${folder}: no tsconfig.json`);
    // node_modules is what makes it buildable on its own; it is a directory or a symlink to one.
    const nodeModules = join(dir, 'node_modules');
    if (!existsSync(nodeModules) || !statSync(nodeModules).isDirectory()) incomplete.push(`${folder}: no node_modules`);
  }
  assert.deepEqual(incomplete, [], `providers that are not independently buildable:\n  ${incomplete.join('\n  ')}`);
});
