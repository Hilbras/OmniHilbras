import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A document that claims something untrue is worse than one that says nothing, because it is read.
 *
 * ## What this exists for
 *
 * `docs/SPEC-SDK.md` carried a **Success Criteria** list in which **nine of ten boxes were unticked**,
 * for nineteen releases, while `tasks/plan.md` read 50/50 complete in the same repository. Every one of
 * the nine turned out to be true — verified by measurement in 1.51.0 — but nothing had looked. The plan
 * was finished; the criteria it was finished *against* were never revisited, and a finished plan reads
 * as a finished project.
 *
 * The same file's risk table said **"1 of 11 adapters"** pinned when it was **4 of 12**, and had said so
 * since 1.32.0. A count in prose is a count that rots; the same count printed by
 * `fixture-coverage.test.js` cannot.
 *
 * ## The rules
 *
 * 1. **No unticked box in a document that describes finished work.** `- [ ]` means "not done", and a
 *    finished document has none. Where something is genuinely not done it belongs in prose that says so.
 * 2. **A count in prose must not contradict the test that measures the same thing.** The specific case
 *    here is adapters and captures: `fixture-coverage.test.js` prints the real figure, so any number
 *    written in a document must be re-derived or removed.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = (name) => readFileSync(join(ROOT, name), 'utf8');

test('no document describes finished work with an unticked box', () => {
  const offenders = [];
  for (const name of ['docs/SPEC-SDK.md', 'README.md', 'tasks/plan.md', 'AGENTS.md']) {
    doc(name).split('\n').forEach((line, index) => {
      if (/^\s*[-*]\s*\[ \]/.test(line)) offenders.push(`${name}:${index + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], `unticked boxes in a finished document:\n${offenders.join('\n')}`);
});

test('the SPEC\'s Success Criteria all carry how they are proved', () => {
  // A ticked box is a claim. Each one says what was measured, so the next reader can re-check it
  // rather than take it on trust — which is the difference between a checklist and a superstition.
  const spec = doc('docs/SPEC-SDK.md');
  const start = spec.indexOf('## Success Criteria');
  assert.ok(start > 0, 'the Success Criteria section must exist');
  const end = spec.indexOf('## Protocol References', start);
  const section = spec.slice(start, end === -1 ? undefined : end);

  // Each criterion may wrap across lines, so a criterion is the ticked line **plus** its indented
  // continuations. Slicing to 70 characters, as the first version did, cut the continuation off before
  // the em-dash that records the proof — so nine correct lines were reported as unexplained.
  const blocks = section.split(/\n(?=- \[[ x]\])/);
  const ticked = blocks.filter((block) => /^- \[x\]/.test(block.trim()));
  assert.ok(ticked.length >= 10, `expected the criteria to still be listed, found ${ticked.length}`);

  const unexplained = ticked.filter((block) => !block.includes('—')).map((block) => block.split('\n')[0].trim());
  assert.deepEqual(
    unexplained,
    [],
    `these criteria are ticked with no record of how they were verified:\n${unexplained.join('\n')}`,
  );
});

test('the plan\'s adapter counts agree with the fixture guard that measures them', () => {
  // Prose counts rot silently. The guard prints the real figure, so a document that disagrees with it is
  // asserting something false — which is what "1 of 11 adapters" did for nineteen releases.
  const guard = doc('packages/omnihilbras-sdk/test/fixture-coverage.test.js');
  const plan = doc('tasks/plan.md');

  // The real number, counted here rather than parsed from the guard's source: every adapter module, and
  // every fixture in the directory. That is what the document must agree with.
  const adapterDir = join(ROOT, 'packages/omnihilbras-sdk/src/adapters');
  const fixtureDir = join(ROOT, 'packages/omnihilbras-sdk/test/fixtures');
  // The guard excludes three adapter ids that carry no completion path of their own.
  const EXCLUDED = ['deepseek-pow', 'chatgpt-first-party', 'qwen-web'];
  const adapters = readdirSync(adapterDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .map((file) => file.replace(/\.ts$/, ''))
    .filter((id) => !EXCLUDED.includes(id));
  const captures = readdirSync(fixtureDir);
  const measured = `${captures.length} of ${adapters.length} adapters`;

  const counts = [...plan.matchAll(/\*\*(\d+) of (\d+) adapters\*\*/g)];
  assert.ok(counts.length > 0, 'the plan should state the measured capture count at all');
  for (const [full, pinned, total] of counts) {
    // **Agreement, not plausibility.** My first version only checked `1 <= pinned <= total`, which a
    // stale "1 of 11 adapters" satisfies perfectly — planting it back passed all four tests. A check
    // that cannot fail on the exact text it was written for is not a check.
    assert.equal(
      Number(pinned),
      captures.length,
      `the plan claims ${pinned} pinned captures but the fixtures directory holds ${captures.length}`,
      `the plan says \`${full}\` but the tree holds ${measured}. ` +
        'Run the fixture guard and copy what it prints.',
    );
    assert.equal(
      Number(total),
      adapters.length,
      `the plan claims ${total} adapters but the tree holds ${adapters.length}`,
    );
  }

  // And the reason the count is trustworthy: the guard prints it rather than hard-coding it.
  assert.match(
    guard,
    /pinned real captures: \$\{pinned\}/,
    'the fixture guard must print the measured count, so a document can be checked against it',
  );
});

test('no document advertises a version other than the one in package.json', () => {
  // The README advertised 0.2.0 while the project was at 1.12.2, which is why `pnpm version:check`
  // exists. This is the same class of failure one layer up: a number in prose that nothing reconciles.
  const manifest = JSON.parse(doc('package.json'));
  const version = manifest.version;
  for (const name of ['README.md']) {
    const stated = doc(name).match(/\*\*Current version: (\d+\.\d+\.\d+)\*\*/);
    assert.ok(stated, `${name} must state its version`);
    assert.equal(stated[1], version, `${name} says ${stated[1]} but package.json is ${version}`);
  }
});
