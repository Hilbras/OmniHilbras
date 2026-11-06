import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The front-end reaches the Kernel through `Kernel/API`, and through nothing else.
 *
 * ## The rule, and why it needs a test rather than a convention
 *
 * Before this file existed, six files under `src/` imported `@hilbras/omnihilbras` — the SDK package —
 * for a slug formatter, a model filter and two constants. Every one of those was a pure helper, so
 * nothing *appeared* wrong: the dashboard worked, the build passed, and the coupling was invisible.
 *
 * It was still a dependency on provider code. Deleting or rewriting a provider could have broken a page
 * that has no business knowing providers exist, and the failure would have surfaced as a blank dashboard
 * rather than as a missing import in a file nobody thought was related.
 *
 * The permitted surface is `@omnihilbras/kernel-api/public`: types describing what the API already sends,
 * and pure helpers that must agree with the API. Provider logic — adapters, transports, SSE parsers,
 * sign-in sessions — is reachable only over HTTP.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

/** The one package specifier the dashboard may import from the Kernel. */
const PERMITTED = '@omnihilbras/kernel-api/public';

/** Packages that would mean the front-end had reached past the API. */
const FORBIDDEN_PREFIXES = ['@hilbras/omnihilbras', '@omnihilbras/sdk-'];

function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Every module specifier in a file, from imports, re-exports and dynamic imports. */
function specifiers(source) {
  const found = [];
  // `[^;]` not `[^'"]`: a clause may carry a string literal inside `import { type X } from '...'`, and
  // forbidding quotes there made the first version of this scanner skip every such import.
  for (const match of source.matchAll(/(?:import|export)[^;]*?from\s*['"]([^'"]+)['"]/g)) found.push(match[1]);
  for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(match[1]);
  return found;
}

test('the guard is looking at the dashboard it claims to check', () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 30, `expected the dashboard sources; found ${files.length}`);
  // And at least one file must import the permitted surface, or the check below proves nothing.
  const usingApi = files.filter((file) => readFileSync(file, 'utf8').includes(PERMITTED));
  assert.ok(usingApi.length > 0, 'no file imports the permitted surface, so this guard passes vacuously');
});

test('no dashboard file imports a provider package or the old SDK', () => {
  const offenders = [];
  for (const file of sourceFiles(SRC)) {
    const where = relative(ROOT, file);
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      // `startsWith(prefix)` alone, not `${prefix}/`: the SDK packages are `@omnihilbras/sdk-openai`, so a
      // slash-joined check never matched and the first version of this guard passed on a planted import.
      if (FORBIDDEN_PREFIXES.some((prefix) => spec === prefix || spec.startsWith(prefix))) {
        offenders.push(`${where} imports '${spec}'`);
      }
      // A relative path that climbs into the Kernel is the same violation spelled differently.
      if (/^(\.\.\/)+Kernel\//.test(spec)) offenders.push(`${where} imports '${spec}' by relative path`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `the dashboard must reach the Kernel only through ${PERMITTED}:\n  ${offenders.join('\n  ')}`,
  );
});

test('the permitted surface carries no provider logic', () => {
  // The point of allowing an import at all is that it is inert: types and formatters, no adapter, no
  // HTTP, no sign-in. If `public/` ever grows a transport, this guard would be permitting exactly what
  // it was written to forbid.
  const surface = readFileSync(join(ROOT, 'Kernel/API/src/public/index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  for (const banned of [/transport/i, /fetch\(/i, /stream\(/i, /signIn/i, /Adapter/]) {
    assert.ok(!banned.test(surface), `the public surface must stay inert, but mentions ${banned}`);
  }
});
