import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The bundled provider marks, checked rather than assumed.
 *
 * ## The defect this exists to prevent
 *
 * `public/providers/` holds the provider logos the dashboard renders. For eighteen consecutive
 * releases every commit in this work was staged with:
 *
 * ```bash
 * git add -A -- . ':(exclude)public/providers'
 * ```
 *
 * The justification was that the directory was build output. It is not. The only thing that reads
 * it is the `logoPolarity()` plugin in `vite.config.ts`, and that plugin **writes**
 * `src/lib/logoPolarity.generated.ts` — the assets themselves are pure input, and the only thing
 * that ever wrote into the directory was a human, once.
 *
 * So the exclusion was not a build-artifact exclusion. It was quietly dropping **141 required
 * assets from every release**, and nothing failed, because a missing logo is a 404 in a browser and
 * a missing file is not an error anywhere in a build.
 *
 * Two of them are referenced directly by `src/data/providers.ts`:
 *
 * ```
 * deepseek.svg   MISSING in git — the app will 404 on this logo
 * qwen.svg       MISSING in git — the app will 404 on this logo
 * ```
 *
 * A fresh clone of the released repository renders a broken image for DeepSeek and Qwen. The
 * developer who pushed the tag had both files sitting in their working tree the whole time, which
 * is why it was never noticed.
 *
 * ## The second-order failure, which is worse
 *
 * `src/lib/logoPolarity.generated.ts` is committed — it must be, because the plugin only regenerates
 * it once a build starts. It classifies every asset in the directory as needing a light or a dark
 * tile, and the whole point of the generated file is that it cannot go stale: the comment in
 * `vite.config.ts` says so, and says *why* — "a stale entry fails silently — an invisible logo, not
 * an error".
 *
 * With 141 of 294 assets absent from the repository, **96 of the 214 assets that committed file
 * names were not in the clone**. On a fresh checkout the tile rule was applied to files that did not
 * exist, while the files that did render received no rule at all. That is the exact silent failure
 * the generator was written to prevent, caused by the generator's own inputs not being committed.
 *
 * ## What is asserted, and what is not
 *
 * The filesystem checks catch a renamed or mistyped reference. The git check catches the one that
 * matters here: a file that is present in the author's tree and absent from the repository. That is
 * the failure this guard was written for, and it is invisible to every other test in the repo, so it
 * is asserted here rather than left to memory.
 *
 * A guard that cannot run must say so. If `git` is unavailable the tracking check reports that it
 * skipped instead of quietly passing, because a test that silently degrades to green is worse than
 * no test: it is a claim of coverage that does not exist.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY = join(ROOT, 'public', 'providers');
const CATALOG = join(ROOT, 'src', 'data', 'providers.ts');
const POLARITY = join(ROOT, 'src', 'lib', 'logoPolarity.generated.ts');

/**
 * Strips comments before matching.
 *
 * Not a nicety. `providers.ts` documents itself with paths in prose, and a guard that cannot tell a
 * comment from code reports a path that no card can ever render. Several guards in this repo were
 * disabled rather than fixed for exactly this reason; the failure is the same one, and the fix is
 * the same fix.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every `/providers/…` asset the catalog actually renders. */
function referencedAssets() {
  const source = stripComments(readFileSync(CATALOG, 'utf8'));
  return [...new Set([...source.matchAll(/['"](\/providers\/[^'"]+)['"]/g)].map((match) => match[1]))];
}

/** Every asset the committed brightness map names. */
function classifiedAssets() {
  const source = stripComments(readFileSync(POLARITY, 'utf8'));
  return [...new Set([...source.matchAll(/["']([^"']+\.(?:svg|png))["']/g)].map((match) => match[1]))];
}

/** Asset paths tracked by git, or `null` when git cannot answer. */
function trackedAssets() {
  const all = trackedPaths();
  return all && new Set([...all].filter((path) => path.startsWith('public/providers/')).map((path) => path.slice('public/providers/'.length)));
}

/** Every tracked path in the repository, or `null` when git cannot answer. */
function trackedPaths() {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });
    return new Set(out.trim().split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

test('every provider mark the catalog renders exists on disk', () => {
  const missing = referencedAssets().filter((asset) => !existsSync(join(ROOT, 'public', asset.slice(1))));
  assert.deepEqual(missing, [], `the dashboard renders these paths and nothing serves them: ${missing.join(', ')}`);
});

test('THE ONE THAT MATTERS — every rendered mark is committed, not just present locally', () => {
  const tracked = trackedAssets();
  if (!tracked) {
    console.log('    skipped: git is unavailable here, so nothing was checked. Not a pass.');
    return;
  }
  const uncommitted = referencedAssets().map((asset) => asset.replace('/providers/', '')).filter((name) => !tracked.has(name));
  assert.deepEqual(
    uncommitted,
    [],
    `these render in your working tree and 404 in a clone: ${uncommitted.join(', ')}. ` +
      'Stage the assets — `git add public/providers` — rather than excluding them as build output.',
  );
});

test('the committed brightness map names assets the repository actually has', () => {
  const tracked = trackedAssets();
  if (!tracked) {
    console.log('    skipped: git is unavailable here, so nothing was checked. Not a pass.');
    return;
  }
  const ghosts = classifiedAssets().filter((name) => !tracked.has(name));
  assert.deepEqual(
    ghosts,
    [],
    `the generated tile rule is applied to ${ghosts.length} assets that a clone does not have, ` +
      'so the files that do render get no rule. That is the silent failure the generator exists to prevent.',
  );
});

test('a cloned checkout gets a brightness map at all', () => {
  // The plugin regenerates this on `buildStart`, so an untracked file is invisible locally — the
  // build writes it before anything reads it — and missing entirely in a clone, where the import
  // fails. The failure is local-only in appearance and remote-only in reality.
  const tracked = trackedPaths();
  if (!tracked) return;
  assert.ok(
    existsSync(POLARITY) && tracked.has('src/lib/logoPolarity.generated.ts'),
    'src/lib/logoPolarity.generated.ts must be committed; it is generated at buildStart, so nothing local would reveal its absence',
  );
});

test('a bundled SVG is a document the browser executes, so it must carry nothing executable', () => {
  // 141 files entered the repository at once. A vendored logo is markup, and markup runs. This is
  // the check that says so, rather than trusting that a drop from a vendor directory was clean.
  const offenders = readdirSync(DIRECTORY)
    .filter((file) => file.endsWith('.svg'))
    .filter((file) => /<script|\son\w+\s*=|javascript:|xlink:href\s*=\s*["']https?:|href\s*=\s*["']https?:/i.test(readFileSync(join(DIRECTORY, file), 'utf8')));
  assert.deepEqual(offenders, [], `SVGs that execute or fetch: ${offenders.join(', ')}`);
});

test('no asset is an empty file wearing a logo\'s name', () => {
  // A 0-byte PNG is a browser's broken-image icon, which is indistinguishable from a design choice
  // at a glance and indistinguishable from a mistake in a diff.
  const empty = readdirSync(DIRECTORY).filter((file) => existsSync(join(DIRECTORY, file)) && readFileSync(join(DIRECTORY, file)).length === 0);
  assert.deepEqual(empty, [], `empty marks: ${empty.join(', ')}`);
});

test('THE COUNT, asserted so it cannot drift quietly', () => {
  // The number is the finding. Asserted rather than recorded so a future drop that forgets an
  // asset has to update the count, and so a reader sees 141 rather than counting again.
  const tracked = trackedAssets();
  if (!tracked) return;
  const onDisk = readdirSync(DIRECTORY).length;
  assert.equal(tracked.size, onDisk, `${tracked.size} assets are committed but ${onDisk} are on disk, so ${onDisk - tracked.size} render locally and 404 in a clone`);
  assert.ok(tracked.size >= 294, 'every bundled mark is in the repository');
  console.log(`    bundled provider marks, all committed: ${tracked.size} of ${onDisk} on disk`);
});
