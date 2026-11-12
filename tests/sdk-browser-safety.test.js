import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The SDK must be loadable in a browser, because the dashboard imports it.
 *
 * ## What shipped, and what it looked like
 *
 * 1.42.0 added what is now `providers/zen/zen-free-tier.ts` — `adapters/zen-free-tier.ts` at the time,
 * before the SDK was split into one folder per provider — which imported `randomBytes` from
 * `node:crypto` and used `Buffer`. The dashboard imports the SDK barrel — `ProviderDetailPage.tsx` imports
 * `applyModelFilters`, `webSessionProviders.ts` imports a constant — so Vite bundled the new module for
 * the browser and the dev server logged:
 *
 * ```
 * [Unhandled error] Module "node:crypto" has been externalized for browser compatibility.
 * Cannot access "node:crypto.randomBytes" in client code.
 * ```
 *
 * **The dashboard rendered a blank page.** Every test passed: `pnpm verify` green, 889 tests, CI green,
 * the SDK typechecked, the gateway built. Nothing in the toolchain treats a browser as a consumer of
 * this package, because it never had to be one until an adapter the browser imports reached for
 * Node's crypto.
 *
 * The same file also carried a **literal NUL byte** in a template string — invisible in review, and it
 * made the file read as binary to `grep`. Fixed alongside.
 *
 * ## The property
 *
 * **No module reachable from the SDK's browser-facing entry may import `node:` builtins or use
 * `Buffer`.** Not "must not do it carelessly" — the dashboard loads whatever the barrel exports, so a
 * Node-only import anywhere in the graph is a blank page, not a degraded feature.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SDK_SRC = join(ROOT, 'Kernel/SDK');

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/**
 * The modules the browser actually gets: whatever `src/index.ts` re-exports, followed one level of
 * local `export * from './x.js'` links.
 *
 * Followed rather than assumed, because the failure was exactly an assumption: the new adapter was
 * written as if only the gateway would import it, and the dashboard imports the barrel. Reading the
 * barrel is what makes "reachable from a .tsx" a fact instead of a guess.
 */
function barrelExports() {
  // There is no single SDK barrel any more: the SDK is twenty-two provider packages, each with its own
  // `adapter/index.ts`. The dashboard reaches them through `Kernel/API`, so this walk starts at the
  // adapter the browser actually loads types from.
  // Every provider's adapter is an entry point now: there is no single barrel, so walking one adapter
  // measured one provider. The dashboard loads whichever provider a request resolves to.
  const entries = readdirSync(SDK_SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !['dist', 'node_modules', 'tests', 'log'].includes(entry.name))
    .map((entry) => join(SDK_SRC, entry.name, 'adapter', 'index.ts'))
    .filter((file) => existsSync(file));
  const seen = new Set(entries);
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    const source = readFileSync(file, 'utf8');
    // The character class must include `/`, or a nested import like `./providers/anthropic/index.js`
    // never matches and the resolver stops dead at the modules the barrel names without a directory.
    // It read `[\w.-]+`, so every adapter was invisible to it — see the header note. At the time the
    // barrel's paths were `./adapters/<name>.js`; the defect was the same one either way, which is why
    // this is written against the character class rather than against a list of paths.
    // `(\.\.?\/)` — both relative forms. The adapter now lives in `adapter/` and reaches its own copies
    // in `lib/`, so a walker that only followed `./` reached exactly one module and reported "the resolver
    // only reached 1 SDK modules", which is the same blind spot this function was fixed for once before.
    for (const match of source.matchAll(/(?:export\s+(?:\*|\{[^}]*\})\s+from|import\s+[^;]*from)\s+['"](\.\.?\/[\w.\/-]+)\.js['"]/g)) {
      const target = join(dirname(file), `${match[1]}.ts`);
      if (existsSync(target) && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...seen];
}

/** Comments are stripped: a doc comment naming `node:crypto` is prose about the rule, not a violation. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('no SDK module imports a Node builtin, or the dashboard renders a blank page', () => {
  const offenders = [];
  for (const file of sourceFiles(SDK_SRC)) {
    const source = code(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/from\s+['"](node:[a-z/]+)['"]/g)) {
      offenders.push(`${file.replace(ROOT + '/', '')}: imports ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `${offenders.join('\n')}\nThe dashboard imports the SDK barrel, so Vite bundles these for the browser.`);
});

test('no SDK module uses Buffer at module scope, which breaks the bundle before it renders', () => {
  // `Buffer` fails differently from a `node:` import: a `node:` import is externalized and blows up while
  // the module graph is built, so the page never mounts. `Buffer` is an *undefined identifier* — the bundle
  // builds fine and throws only when the line runs. That makes it safe in a function the browser never
  // calls, and catastrophic in one it does.
  //
  // So the rule is about WHERE, not whether. A module-scope `Buffer` — a top-level constant computed at
  // import time — reaches the browser the moment the barrel is loaded, and that is the blank page again.
  //
  // ## Why this test reaches files it could not see before
  //
  // The resolver's character class was `[\w.-]+`, so a nested import like
  // `./providers/anthropic/index.js` never matched and the walk stopped after the modules the barrel
  // names without a directory. Every adapter was invisible to it — including the three that use
  // `Buffer`. The exemption that justified narrowing the rule ("no `.tsx` imports cline") was written
  // from a graph that silently excluded the very modules it was reasoning about.
  //
  // The floor below is a floor rather than a count, deliberately: the walk reaches well past it, so
  // adding or removing a module does not break this test, while a return to the old character class —
  // which reached about ten — does.
  const reachable = barrelExports();
  assert.ok(
    reachable.length >= 24,
    `the resolver only reached ${reachable.length} SDK modules; it is probably not following subdirectory imports again`,
  );

  const offenders = [];
  for (const file of reachable) {
    // Module scope is everything before the first `export`/`function`/`class` declaration, which is where
    // a top-level `const x = Buffer.from(...)` would live.
    const source = code(readFileSync(file, 'utf8'));
    const lines = source.split('\n');
    let depth = 0;
    for (const [index, line] of lines.entries()) {
      // Module scope is "brace depth is zero". My first attempt tracked a boolean set by any declaration
      // line, and `const CLINE_MARKER = Buffer.from(...)` set it on the very line being checked — so a
      // planted module-scope Buffer passed. Verified by planting, which is the only reason this is fixed.
      const usesBuffer = /\bBuffer\b/.test(line);
      if (usesBuffer && depth === 0) {
        offenders.push(`${file.replace(ROOT + '/', '')}:${index + 1}: ${line.trim().slice(0, 80)}`);
      }
      for (const char of line) {
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
      }
    }
  }
  assert.deepEqual(offenders, [], `module-scope Buffer — the dashboard imports the barrel, so this runs at page load:\n${offenders.join('\n')}`);
});

test('every remaining Buffer use is inside a function, never at module scope', () => {
  // Records the measured fact rather than a policy, so a future adapter that uses `Buffer` in a
  // gateway-only path is a documented, reviewed decision instead of an accident.
  //
  // Measured 1.45.0: `cline.ts`, `kiro.ts` and `deepseek-web.ts` each use `Buffer` inside an exported
  // function. The built browser bundle contains **zero** occurrences of the token `Buffer` across all
  // three chunks, and the four `process.` hits are React's own dev shim behind `typeof process === 'object'`.
  // Tree-shaking drops the unreferenced adapters; the module-scope test above is what stops a future one
  // from being *used* rather than merely present.
  const reachable = barrelExports();
  const users = reachable.filter((file) => /\bBuffer\b/.test(code(readFileSync(file, 'utf8'))));
  assert.deepEqual(
    users.map((f) => f.replace(ROOT + '/', '')).sort(),
    // Re-measured after the rebuild. `clinepass/lib/cline.ts` is a new entry because clinepass now carries
  // its own copy of Cline's adapter (the isolation that replaced shared inheritance) — the same Buffer use,
  // in a second file. Named rather than wildcarded, so the next addition is noticed.
  ['Kernel/SDK/cline/adapter/index.ts', 'Kernel/SDK/clinepass/lib/cline.ts', 'Kernel/SDK/deepseek-web/adapter/index.ts', 'Kernel/SDK/kiro/adapter/index.ts', 'Kernel/SDK/openai/lib/openai-compatible.ts'],
    'the set of Buffer users changed — re-measure the bundle before accepting this list',
  );
});

test('no SDK source file contains a NUL byte or other control character', () => {
  // The 1.42.0 file had one inside a template string. It survived every test, every typecheck and every
  // build, and made the file read as binary to `grep` — so a reviewer reading it was not reading it.
  const offenders = [];
  for (const file of sourceFiles(SDK_SRC)) {
    const bytes = readFileSync(file);
    if (bytes.includes(0)) offenders.push(`${file.replace(ROOT + '/', '')}: contains a NUL byte`);
    if (bytes.includes(13)) offenders.push(`${file.replace(ROOT + '/', '')}: contains a CR`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the dashboard really does import the SDK barrel, so the rule above is not hypothetical', () => {
  // Without this, the check above would look like a precaution. It is not: two files in `src/` import a
  // value from `@hilbras/omnihilbras`, which is exactly what pulls every adapter into the browser graph.
  const app = readdirSync(join(ROOT, 'src'), { withFileTypes: true });
  const files = app.flatMap((entry) => {
    const full = join(ROOT, 'src', entry.name);
    if (entry.isDirectory()) {
      return readdirSync(full).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => join(full, f));
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
  // The dashboard no longer reaches the SDK directly: its one permitted surface is
  // `@omnihilbras/kernel-api/public`, which is types and pure helpers. That IS the browser-safety property
  // this file was written to protect — rule one is now enforced by the import boundary rather than by
  // noticing which SDK module leaks a Node builtin. So the assertion is that the boundary holds.
  const SDK_IMPORTS = /from\s+['"]@hilbras\/omnihilbras['"]|from\s+['"]@omnihilbras\/sdk-[^'"]+['"]/;
  const importers = files.filter((file) => SDK_IMPORTS.test(readFileSync(file, 'utf8')));
  assert.equal(
    importers.length,
    0,
    `the dashboard imports the SDK directly, which bypasses the API boundary:\n  ${importers.join('\n  ')}`,
  );
});

test('the module that caused it says why it avoids node:crypto', () => {
  // A rule with no reason attached is a superstition, and this one was learned from a blank page. The
  // comment is what stops the next person from "simplifying" it back to `node:crypto`.
  const source = readFileSync(join(SDK_SRC, 'zen/lib/zen-free-tier.ts'), 'utf8');
  assert.match(source, /node:crypto/, 'the reason the import is avoided is written down');
  assert.match(source, /getRandomValues/, 'and the replacement actually used');
});
