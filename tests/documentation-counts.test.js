import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { providerIds } from '../apps/gateway/test/support/providerIds.js';

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

/** Adapters the capture guard considers, measured from the provider directory. */
function consideredAdapters() {
  const dir = new URL('packages/omnihilbras-sdk/src/providers/', ROOT);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'openai-compatible')
    .map((entry) => entry.name)
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
  const dir = new URL('packages/omnihilbras-sdk/src/providers/', ROOT);
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .reduce((count, entry) => count + readdirSync(new URL(`${entry.name}/`, dir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).length, 0);
  const claimed = spec.match(/\*\*(\d+) files\*\* in `packages\/omnihilbras-sdk\/src\/providers\/`/);

  assert.ok(claimed, 'the SPEC must state the adapter file count, and name the directory it counted');
  assert.equal(
    Number(claimed[1]),
    files,
    `the SPEC claims ${claimed[1]} adapter files; there are ${files}. ` +
      'If an adapter was added, this number is the one a reader will not think to check.',
  );
});

test('the SPEC reconciles its file count with the capture guard\'s count', () => {
  // The SDK file count and capture-guard adapter count refer to different sets; both values are verified
  // below against the directories that define them, then reconciled in the SPEC.
  const providersDir = new URL('packages/omnihilbras-sdk/src/providers/', ROOT);
  const files = readdirSync(providersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .reduce((count, entry) => count + readdirSync(new URL(`${entry.name}/`, providersDir)).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).length, 0);
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
  // File totals and capture-guard adapter totals describe different sets; the useful rule is that every
  // count says which one it measures.
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

  const claimed = [...readme.matchAll(/`\/dashboard(\/[A-Za-z0-9:/-]+)?`/g)]
    .map((match) => (match[1] ?? '').replace(/^\//, '') || 'providers')
    .filter((route) => route.length > 0);

  assert.ok(claimed.length > 0, 'the README should list its dashboard routes');

  const known = new Set(served.map((route) => route.path.replace(/^\//, '')));
  // `/dashboard` with no suffix is the mount point and redirects to providers.
  known.add('providers');
  // The provider paths are built by helper functions rather than a literal in `dashboardRoutes`, so the loop
  // above cannot see them. They are added here, and the helpers are asserted to exist: **the old regex only
  // matched a single lowercase segment, so `/dashboard/providers/:providerId` was documented for releases and
  // never checked at all** — a documented route the guard could not see is the gap this whole test exists for.
  for (const helper of ['providerRoute', 'providerUsageRoute']) {
    assert.match(code, new RegExp(`export function ${helper}\\(`), `routes.ts no longer exports ${helper}, so the provider paths it builds are undocumented`);
  }
  known.add('providers/:providerId');
  known.add('providers/:providerId/usage');

  const phantoms = [...new Set(claimed)].filter((route) => !known.has(route));
  assert.deepEqual(
    phantoms,
    [],
    `the README lists ${phantoms.map((route) => `/dashboard/${route}`).join(', ')}, which the router does not ` +
      `serve. Routes it does: ${[...known].map((route) => `/dashboard/${route}`).join(', ')}`,
  );
});

/**
 * How many of the ids the SDK ships a file names.
 *
 * This is the definition `shared-execution-has-no-provider-names.test.js` applies to the shared
 * algorithm, generalised from "is this zero" to "how many": a provider is named when its id occurs as
 * a whole word inside a string literal, in executable text with comments stripped. The vocabulary is
 * the SDK's own provider directories, so a new provider extends the check without editing it.
 */
function providerIdsNamed(relative) {
  const code = read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const literals = [...code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((match) => match[2]).join('\n');
  return providerIds().filter((id) => new RegExp(`(?<![A-Za-z0-9])${id}(?![A-Za-z0-9])`).test(literals)).length;
}

test('the architecture doc measures the numbers its measured-state table states', () => {
  // The table's own caption — "Counts are from the tree, not from intention" — was read as a
  // measurement for releases while every line count in it had drifted: `service.ts` was quoted at 1103
  // and measured 1755. A caption is a claim, and this is the check that makes it one.
  //
  // Neither column was recomputed by anything until 1.85.1. The second column could not have been
  // reproduced by hand either: the numbers in it disagreed with each other's rules, which is what a
  // count with no stated denominator looks like.
  const rows = [...architecture.matchAll(/^\|\s*`([^`]+\.ts)`\s*\|\s*(\d+)\s*\|\s*\**(\d+)\**\s*\|/gm)].map(
    (match) => ({ path: match[1], lines: Number(match[2]), ids: Number(match[3]) }),
  );

  assert.ok(
    rows.length >= 10,
    `the measured-state table should list the gateway core; ${rows.length} rows were parsed, so the guard would pass vacuously`,
  );

  const wrong = [];
  for (const row of rows) {
    const actualLines = read(row.path).split('\n').length - 1;
    if (actualLines !== row.lines) wrong.push(`${row.path}: the doc says ${row.lines} lines, the file has ${actualLines}`);
    const actualIds = providerIdsNamed(row.path);
    if (actualIds !== row.ids) {
      wrong.push(`${row.path}: the doc says ${row.ids} provider ids named, ${actualIds} are named`);
    }
  }

  assert.deepEqual(wrong, [], `the measured-state table no longer measures the tree:\n  ${wrong.join('\n  ')}`);
});

test('every path the Layers diagram names is where the diagram says it is', () => {
  // The diagram kept drawing the SDK as a flat `src/` with an `adapters/` directory for nine releases
  // after the restructure made it `core/` + `providers/`, listed a gateway `transport.ts` that has
  // never existed — the gateway takes the SDK's `HttpTransport` interface rather than keeping a second
  // one — and filed the SDK's own `zen/zen-free-tier.ts` under `apps/gateway/src/`. Nothing compared
  // the map to the tree, and this file is where a reader starts.
  //
  // It checks placement, not completeness: a diagram is allowed to be selective, which is why the
  // assertion is "every path named exists", not "every file is named".
  const layers = architecture.slice(architecture.indexOf('## Layers'));
  const opened = layers.indexOf('```text');
  const block = layers.slice(opened, layers.indexOf('```', opened + 7));

  let base = null;
  let subdir = '';
  const missing = [];
  let checked = 0;

  for (const line of block.split('\n')) {
    const header = line.match(/^(apps\/gateway\/src\/|packages\/omnihilbras-sdk\/src\/|src\/)(?:\s|$)/);
    if (header) {
      base = header[1];
      subdir = '';
      continue;
    }
    if (base === null) continue;

    // Only the two indents the diagram uses for entries. A continuation line is indented far enough
    // that a `^( {2}| {4})` without the lookahead would match it and read its first word as a filename.
    const entry = line.match(/^( {2}| {4})(?=\S)(\S+)/);
    if (!entry) continue;
    const token = entry[2];
    const indent = entry[1].length;

    if (token.endsWith('/')) {
      const dir = indent === 2 ? base + token : base + subdir + token;
      checked += 1;
      if (!existsSync(join(ROOT_URL, dir))) missing.push(dir);
      // `core/` and `providers/` nest the entries that follow them; `routes/` does not, because the
      // gateway section is flat and `routes/` sits in the middle of it.
      if (indent === 2 && base === 'packages/omnihilbras-sdk/src/') subdir = token;
      continue;
    }
    if (!/^[\w./-]+$/.test(token)) continue;
    const file = base + subdir + (token.endsWith('.ts') ? token : `${token}.ts`);
    checked += 1;
    if (!existsSync(join(ROOT_URL, file))) missing.push(file);
  }

  assert.ok(checked >= 15, `the diagram should name the gateway core; only ${checked} entries were checked`);
  assert.deepEqual(missing, [], `the Layers diagram names paths that are not there:\n  ${missing.join('\n  ')}`);
});
