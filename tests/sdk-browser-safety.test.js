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
 * 1.42.0 added `adapters/zen-free-tier.ts`, which imported `randomBytes` from `node:crypto` and used
 * `Buffer`. The dashboard imports the SDK barrel — `ProviderDetailPage.tsx` imports
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
const SDK_SRC = join(ROOT, 'packages/omnihilbras-sdk/src');

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
  const barrel = join(SDK_SRC, 'index.ts');
  const seen = new Set([barrel]);
  const queue = [barrel];
  while (queue.length > 0) {
    const file = queue.pop();
    const source = readFileSync(file, 'utf8');
    // The character class must include `/`, or `./adapters/anthropic.js` never matches and the
    // resolver stops dead at the ten modules the barrel names without a directory. It read
    // `['\w.-]+`, so every one of the fourteen adapters was invisible to it — see the header note.
    for (const match of source.matchAll(/(?:export\s+(?:\*|\{[^}]*\})\s+from|import\s+[^;]*from)\s+['"]\.\/([\w.\/-]+)\.js['"]/g)) {
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
  // ## Why this test now reaches fourteen files it could not see before
  //
  // The resolver's character class was `[\w.-]+`, so `./adapters/anthropic.js` never matched and the walk
  // stopped after ten modules. Every adapter was invisible to it — including the three that use `Buffer`.
  // The exemption that justified narrowing the rule ("no `.tsx` imports cline") was written from a graph
  // that silently excluded the very modules it was reasoning about.
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
    ['packages/omnihilbras-sdk/src/adapters/cline.ts', 'packages/omnihilbras-sdk/src/adapters/deepseek-web.ts', 'packages/omnihilbras-sdk/src/adapters/kiro.ts'],
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
  const importers = files.filter((file) => {
    const source = readFileSync(file, 'utf8');
    return /import\s+(?!type\b)[^;]*from\s+['"]@hilbras\/omnihilbras['"]/.test(source);
  });
  assert.ok(importers.length > 0, 'nothing imports the SDK as a value — so the browser-safety rule would be moot');
});

test('the module that caused it says why it avoids node:crypto', () => {
  // A rule with no reason attached is a superstition, and this one was learned from a blank page. The
  // comment is what stops the next person from "simplifying" it back to `node:crypto`.
  const source = readFileSync(join(SDK_SRC, 'adapters/zen-free-tier.ts'), 'utf8');
  assert.match(source, /node:crypto/, 'the reason the import is avoided is written down');
  assert.match(source, /getRandomValues/, 'and the replacement actually used');
});
