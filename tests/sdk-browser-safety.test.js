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
    for (const match of source.matchAll(/(?:export\s+(?:\*|\{[^}]*\})\s+from|import\s+[^;]*from)\s+['"]\.\/([\w.-]+)\.js['"]/g)) {
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

test('no SDK module uses Buffer, which is the same failure wearing a different name', () => {
  // `Buffer` is Node-only, but unlike a `node:` import it does not fail at bundle time — it throws when
  // the line runs. So the rule is scoped to the modules the dashboard actually pulls in, which is what
  // `packages/omnihilbras-sdk/src/index.ts` exports.
  //
  // Scoped deliberately: `adapters/cline.ts` uses `Buffer.from(padded, 'base64')` and has shipped for
  // many releases without breaking anything, because no `.tsx` imports it — only its id appears in a
  // gateway URL. A rule that flagged it would be wrong about a real, working module, and a check that
  // cries wolf is one that gets switched off.
  const reachable = barrelExports();
  const offenders = [];
  for (const file of reachable) {
    const source = code(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/(?<![.\w$])Buffer\s*[.@(]/g)) {
      offenders.push(`${file.replace(ROOT + '/', '')}: uses Buffer at index ${match.index}`);
    }
  }
  assert.deepEqual(offenders, [], `${offenders.join('\n')}\nEvery module the SDK barrel exports is bundled for the browser.`);
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
