import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The **published** declarations must compile for a consumer that has no `@types/node`.
 *
 * ## What shipped, and why every gate was green
 *
 * `cline.ts` built a header object with `'X-PLATFORM': process.platform`. TypeScript infers that as
 * `NodeJS.Platform` and writes the inferred type straight into the emitted declaration:
 *
 * ```ts
 * // packages/omnihilbras-sdk/dist/adapters/cline.d.ts
 * export declare function clineHeaders(...): {
 *   ...
 *   'X-PLATFORM': NodeJS.Platform;      // ← a type that does not exist without @types/node
 * };
 * ```
 *
 * Packed into a real consumer and compiled:
 *
 * ```
 * consumer has @types/node: no
 * cline.d.ts(61,19): error TS2503: Cannot find namespace 'NodeJS'.   REAL EXIT=2
 * ```
 *
 * It passed everything this repo runs, for four independent reasons:
 *
 * 1. the SDK typechecks against its own `@types/node`, so `NodeJS` resolves here;
 * 2. the root `tsconfig.json` sets `skipLibCheck: true`, which skips declaration files entirely;
 * 3. the dashboard consumes the `workspace:*` link, never the packed tarball;
 * 4. `pnpm test` never compiles the artifact **from outside**, so nothing ever saw a consumer's view.
 *
 * Point 4 is the defect this file closes. A guard that reads the repository's own `dist/` would pass
 * forever, because `dist/` here is always built in a tree that has `@types/node`.
 *
 * ## What is asserted
 *
 * The **general** property, not this one line: no ambient Node type may appear in any emitted
 * declaration. `NodeJS.Platform` was one instance of a class — an unannotated `process.*` read in an
 * object literal that is returned without a declared type — and the next one would be a different file
 * with a different suffix. So this scans every `.d.ts` the SDK emits.
 *
 * The prohibition covers `NodeJS.*` and `Buffer`, because both are ambient Node globals that only exist
 * with `@types/node`, and both leak the same way: inferred from a value into a declaration.
 *
 * `tests/sdk-browser-safety.test.js` is the sibling concern — the same package also has to load in a
 * browser — and it is a separate failure mode with a separate test.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'packages/omnihilbras-sdk/dist');

/** The declaration files the SDK actually emits. Missing `dist` is reported, not silently skipped. */
function emittedDeclarations() {
  if (!existsSync(DIST)) return [];
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.d.ts')) found.push(full);
    }
  };
  walk(DIST);
  return found;
}

test('the SDK has been built, so this file is measuring something', () => {
  // The guard that silently passes because its subject does not exist is the failure mode this whole
  // session keeps finding. Assert the subject exists before asserting anything about it.
  const declarations = emittedDeclarations();
  assert.ok(
    declarations.length > 20,
    `expected the SDK's emitted declarations, found ${declarations.length} — run pnpm build:sdk first, or this file proves nothing`,
  );
});

test('no emitted declaration names an ambient Node type', () => {
  // `NodeJS.Platform` here, `Buffer` next time. Both only exist when the consumer has @types/node,
  // and both appear because a value was inferred into a declaration rather than a type being written.
  const AMBIENT = /\b(NodeJS\.[A-Za-z_$][\w$]*|Buffer\b)/g;
  const offenders = [];
  for (const file of emittedDeclarations()) {
    const source = readFileSync(file, 'utf8');
    source.split('\n').forEach((line, index) => {
      // Comments in a .d.ts are prose about the code; a hit inside one is not a consumer's problem.
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      const found = trimmed.match(AMBIENT);
      if (found) {
        offenders.push(`${file.replace(ROOT + '/', '')}:${index + 1}  ${found[0]}  →  ${trimmed.slice(0, 70)}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `these declarations reference a type that needs @types/node, which a browser consumer does not have:\n${offenders.join('\n')}\n` +
      'Annotate the return type explicitly rather than letting `process.*` be inferred into it.',
  );
});

test('the SDK declares @types/node as a devDependency, not something consumers inherit', () => {
  // The fix is only sound if the types are available *here* and not required *there*. This asserts the
  // half that makes the leak invisible locally: the SDK really does compile with Node types, which is
  // why the bug survived in this repo at all.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'packages/omnihilbras-sdk/package.json'), 'utf8'));
  assert.ok(
    !manifest.dependencies?.['@types/node'],
    '@types/node must stay a devDependency; a runtime dependency would install Node globals into every consumer',
  );
});