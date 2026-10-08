import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// A number in prose is a claim, and a claim in prose rots.
//
// `tasks/plan.md` learned this the expensive way: it read "the plan is complete" for nineteen
// releases while the mitigation it listed as done had never been implemented. The fix there was a
// *missing* thing failing. This guard is for the opposite case — a thing that was true once, written
// down, and then drifted.
//
// The rule: **a count that can be measured must not be written as a bare number.** Either state it
// without the number ("the capture guard counts 12"), or state where the number comes from so a reader
// can check it. What is forbidden is a number that no test recomputes, because that is exactly the kind
// that goes stale while the plan reads as finished.
//
// Numbers that ARE recomputed by a running test are allowed here — `fixture-coverage.test.js` prints
// "pinned real captures: 4 of 14 adapters", so the plan may quote it. This guard checks the *quoted*
// number against what the guard prints, which is what stops the two drifting apart.

const ROOT = new URL('..', import.meta.url);
const ROOT_URL = fileURLToPath(ROOT);
const read = (file) => readFileSync(new URL(file, ROOT), 'utf8');

/** Adapters the capture guard considers, which is the 16 behind the 18 files. */
function consideredAdapters() {
  const dir = new URL('packages/omnihilbras-sdk/src/adapters/', ROOT);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .map((file) => file.replace(/\.ts$/, ''))
    .filter((id) => !['deepseek-pow', 'chatgpt-first-party', 'qwen-web'].includes(id));
}

/**
 * The same arithmetic `fixture-coverage.test.js` performs, recomputed rather than shelled out.
 *
 * The first version spawned `node --test` as a subprocess, and Node refuses — "run() is being called
 * recursively within a test file" — so the guard failed on itself while looking like it was checking
 * the plan. Computing from the same directory listing the guard reads is both simpler and *stricter*:
 * the plan's number now fails if a fixture is added, whether or not the other guard is run.
 *
 * The other guard still asserts `pinned === accounted`, so the two sets cannot drift apart.
 */
function captureCounts() {
  const fixtures = readdirSync(new URL('packages/omnihilbras-sdk/test/fixtures/', ROOT))
    .filter((file) => !file.startsWith('.') && !file.endsWith('.md'));
  return { pinned: fixtures.length, considered: consideredAdapters().length };
}

const plan = read('tasks/plan.md');
const spec = read('docs/SPEC-SDK.md');
const readme = read('README.md');
const architecture = read('docs/architecture/README.md');

test('the adapter count in the SPEC is the real file count', () => {
  const dir = new URL('packages/omnihilbras-sdk/src/adapters/', ROOT);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).length;
  const claimed = spec.match(/\*\*(\d+) files\*\* in `packages\/omnihilbras-sdk\/src\/adapters\/`/);

  assert.ok(claimed, 'the SPEC must state the adapter file count, and name the directory it counted');
  assert.equal(
    Number(claimed[1]),
    files,
    `the SPEC claims ${claimed[1]} adapter files; there are ${files}. ` +
      'If an adapter was added, this number is the one a reader will not think to check.',
  );
});

test('the SPEC reconciles its file count with the capture guard\'s count', () => {
  // The SPEC says 16 files, the capture guard says 14 adapters. Both are right — three files are not
  // protocol adapters — and both are quoted in plan.md as live numbers. Left unreconciled they read as a
  // contradiction, and the fix someone applies under time pressure is to "correct" the wrong one.
  const files = readdirSync(new URL('packages/omnihilbras-sdk/src/adapters/', ROOT))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).length;
  const considered = consideredAdapters().length;
  const excluded = files - considered;

  assert.ok(
    excluded > 0,
    'the guard must exclude something, or "the capture guard counts N" is the same number as the file count ' +
      'and the reconciliation below is vacuous',
  );
  assert.ok(
    spec.includes('are not protocol adapters'),
    'the SPEC must say why its file count exceeds the capture guard\'s count',
  );
  assert.ok(
    spec.includes(`capture guard counts ${considered}`),
    `the SPEC must quote the guard's own count (${considered}) so the two numbers are visibly the same claim`,
  );
  assert.ok(excluded > 0);
});

test('the plan\'s quoted capture count is what the guard prints today', () => {
  // This is the one that rotted once. The plan read "the plan is complete" for nineteen releases while
  // its listed mitigation was never implemented; the count beside it had quietly stopped matching.
  const { pinned, considered } = captureCounts();
  const claimed = plan.match(/\*\*(\d+) of (\d+) adapters\*\*/);

  assert.ok(claimed, 'the plan must state how many adapters have a pinned capture');
  assert.equal(Number(claimed[1]), pinned, `the plan claims ${claimed[1]} pinned captures; the guard finds ${pinned}`);
  assert.equal(Number(claimed[2]), considered, `the plan claims ${claimed[2]} considered adapters; the guard considers ${considered}`);
});

test('no document states a test count as a bare number', () => {
  // A test total is the single most rot-prone number in a repository: it only ever goes up, so a quoted
  // figure is wrong the moment anyone adds a test. The architecture doc carried "419 tests" for releases
  // after the suite passed 939.
  //
  // The fix is not to restate the number. It is to not state it: `pnpm verify` prints the live counts,
  // and a reader who needs them has one command.
  const offenders = [];
  for (const [name, text] of [
    ['README.md', readme],
    ['docs/SPEC-SDK.md', spec],
    ['docs/architecture/README.md', architecture],
    ['tasks/plan.md', plan],
    // Added 1.63.0: the community files are read first by every new contributor and by every security
    // reporter, so a stale figure in SECURITY.md is worse than one in the architecture notes.
    ['SECURITY.md', read('SECURITY.md')],
    ['CONTRIBUTING.md', read('CONTRIBUTING.md')],
  ]) {
    for (const [index, line] of text.split('\n').entries()) {
      // A count inside a code fence or a dated release note is history, not a live claim.
      if (/^\s*(#+\s*)?(v?1\.\d+|Task \d+|Release)/i.test(line)) continue;
      const match = line.match(/\b(\d{3,4})\s+tests?\b/);
      if (match) offenders.push(`${name}:${index + 1}  "${match[0]}" — run \`pnpm verify\` for the live count`);
    }
  }
  assert.deepEqual(offenders, [], `documents quote a test count that nothing recomputes:\n  ${offenders.join('\n  ')}`);
});

test('no document claims an adapter count without naming what it counted', () => {
  // "14 adapters" and "16 files" are both currently correct and both were wrong at some point in the
  // same sentence. The bare number is the problem; the fix is that a reader can tell which set is meant.
  const offenders = [];
  for (const [name, text] of [['docs/SPEC-SDK.md', spec], ['tasks/plan.md', plan]]) {
    for (const [index, line] of text.split('\n').entries()) {
      for (const match of line.matchAll(/\b(\d+)\s+adapters\b/gi)) {
        const rest = line.trim();
        const namesItsSet = /files|guard|considered|not protocol/i.test(rest);
        if (!namesItsSet && !/of \d+ adapters/.test(rest)) {
          offenders.push(`${name}:${index + 1}  "${rest.slice(0, 90)}"`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `an adapter count with no stated denominator:\n  ${offenders.join('\n  ')}`);
});

test('every dashboard route the README lists is one the router serves', () => {
  // The README listed `/dashboard/overview` for several releases after that page was deleted as a mockup with
  // no data source. A documented route that 404s reads as a bug in the app, and a reader has no way to tell
  // it apart from one that was never built.
  //
  // The same class as the gateway-route guard, one level up: that one checks `docs/SPEC-SDK.md` against the
  // served paths, and this checks `README.md` against `src/lib/routes.ts`.
  //
  // **`routes.ts`, not the filenames.** The first version derived routes from `src/pages/*.tsx` and rejected
  // `/dashboard/keys` — a real route — because the page file is `ApiKeysPage.tsx`. A guard that fails on
  // correct documentation gets disabled, so it reads the router's own constant instead, which is what every
  // `Link` in the app reads too.
  const routesSource = read('src/lib/routes.ts');
  // Comments stripped first: `routes.ts` *documents* the absence of an overview route in prose, so a
  // substring check on the raw source finds the word and reports a route that does not exist. The
  // gateway-route guard strips comments for exactly this reason.
  const code = routesSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const block = code.slice(code.indexOf('export const dashboardRoutes'), code.indexOf('} as const'));
  const served = [...block.matchAll(/^\s*(\w+):\s*'([^']+)'/gm)].map((match) => ({ name: match[1], path: match[2] }));

  assert.ok(served.length > 0, 'no dashboard routes parsed; the guard would pass vacuously');
  assert.ok(
    !block.includes('overview'),
    'an overview route is back in the router. The page it pointed at was a mockup with no data source; if ' +
      'this is real work now, say so in routes.ts rather than restoring the route by accident.',
  );

  const claimed = [...readme.matchAll(/`\/dashboard(\/[a-z-]+)?`/g)]
    .map((match) => (match[1] ?? '').replace(/^\//, '') || 'providers')
    .filter((route) => route.length > 0);

  assert.ok(claimed.length > 0, 'the README should list its dashboard routes');

  const known = new Set(served.map((route) => route.path.replace(/^\//, '')));
  // `/dashboard` with no suffix is the mount point and redirects to providers.
  known.add('providers');

  const phantoms = [...new Set(claimed)].filter((route) => !known.has(route));
  assert.deepEqual(
    phantoms,
    [],
    `the README lists ${phantoms.map((route) => `/dashboard/${route}`).join(', ')}, which the router does not ` +
      `serve. Routes it does: ${[...known].map((route) => `/dashboard/${route}`).join(', ')}`,
  );
});
