import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';

/**
 * Vendored-lib drift guard (Phase 2 of the full-system upgrade).
 *
 * AGENTS.md names the boundary: "the shared machinery each package needs is vendored into
 * `Kernel/SDK/<name>/lib/` — a fix to a vendored file is a fix to every copy or it is drift." Some vendored
 * files are *meant* to differ per provider (`types.ts` has 7 shapes, `transport.ts` has 3) — a guard that
 * demanded those be identical would be wrong and would get disabled. This pins only the files that are
 * byte-identical today and have no reason to vary: `errors.ts` (one error vocabulary) and `url.ts` (one
 * loopback/private-destination check). A fix to one that misses the others now fails in two seconds, in
 * `pnpm test:repo`, before a build.
 *
 * The Cline/ClinePass adapter twins have their own, implementation-level guard (`cline-twin-drift.test.js`).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = join(ROOT, 'Kernel', 'SDK');

const sdkDirs = readdirSync(SDK, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => join(SDK, entry.name));

function copies(fileName) {
  const found = [];
  for (const dir of sdkDirs) {
    const path = join(dir, 'lib', fileName);
    try {
      found.push({ path: relative(ROOT, path), digest: createHash('sha256').update(readFileSync(path)).digest('hex') });
    } catch {
      // Not every SDK vendors every file; absence is fine.
    }
  }
  return found;
}

for (const fileName of ['errors.ts', 'url.ts']) {
  test(`every vendored ${fileName} copy is identical (one shared definition)`, () => {
    const files = copies(fileName);
    assert.ok(files.length >= 20, `expected the shared ${fileName} to be vendored widely, found ${files.length} copies`);
    const byDigest = new Map();
    for (const file of files) {
      if (!byDigest.has(file.digest)) byDigest.set(file.digest, []);
      byDigest.get(file.digest).push(file.path);
    }
    assert.equal(byDigest.size, 1, `${fileName} has drifted into ${byDigest.size} versions:\n${[...byDigest.values()].map((paths) => paths.join(', ')).join('\n---\n')}`);
  });
}

test('the guard names the intentionally-varying files it does NOT pin', () => {
  // A future reader must see that types.ts/transport.ts varying is deliberate, not an oversight in this guard.
  const types = copies('types.ts');
  const transport = copies('transport.ts');
  assert.ok(types.length > 0 && transport.length > 0, 'the varying files are still vendored');
  const variants = (files) => new Set(files.map((file) => file.digest)).size;
  // Document the current shape without asserting an exact count (providers come and go). More than one digest
  // is expected and acceptable; pinning them would be the mistake this test records.
  assert.ok(variants(types) >= 1 && variants(transport) >= 1);
});
