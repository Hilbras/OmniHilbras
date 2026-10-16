import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHANNELS, auditReleaseTrail, knownGaps } from '../scripts/audit-release-trail.mjs';

/**
 * The release trail, which `AGENTS.md` has required since 1.32.1 and which nothing checked until 1.85.1.
 *
 * The rule: a version is released when **three** things exist — a tag on `main`, a GitHub release for
 * that tag, and a version on npm. Two tags broke it and one of them broke it twice (`v1.60.0` was
 * tagged for thirty releases with no npm version and no release), and nothing failed, because the only
 * enforcement was a `for` loop pasted into `AGENTS.md`. A rule whose check is a paragraph is checked as
 * often as the paragraph is read.
 *
 * ## Why the check is in two places
 *
 * `pnpm verify` runs on every push and is offline. Two of the three facts are knowable from the
 * checkout alone — the tag is on `main`, and the tag's own `package.json` states the version the tag
 * names — so those are asserted here, in `verify`, on every push. The third needs the registry, so it
 * lives in `scripts/audit-release-trail.mjs` and runs in `.github/workflows/release-audit.yml` on a
 * schedule. Making `verify` reach the network would fail the release gate whenever npm hiccups, which
 * is a worse trade than a second workflow.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let gitAvailable = true;

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function localTags() {
  try {
    return git('tag', '--list', 'v*', '--sort=v:refname').split('\n').filter(Boolean);
  } catch {
    // A source tarball has no history to check, and that is not a defect in the release trail.
    gitAvailable = false;
    return [];
  }
}

const TAGS = localTags();

test('every tag states the version its own commit carries', () => {
  // A tag whose commit says a different version publishes an artifact that disagrees with its own
  // name — the failure `scripts/check-version.mjs` was written for, one level out: it keeps the three
  // manifests in step with each other, and this keeps the tag in step with them.
  if (!gitAvailable) return console.log('    (no git history — release-trail checks skipped)');

  const wrong = [];
  for (const tag of TAGS) {
    const version = tag.replace(/^v/, '');
    let stated;
    try {
      stated = JSON.parse(git('show', `${tag}:package.json`)).version;
    } catch {
      wrong.push(`${tag}: no package.json at that commit`);
      continue;
    }
    if (stated !== version) wrong.push(`${tag}: its package.json says ${stated}`);
  }

  assert.deepEqual(wrong, [], `a tag disagrees with the version in its own commit:\n  ${wrong.join('\n  ')}`);
});

test('every tag points at a commit on main', () => {
  // "Never tag a commit that is not on `main`" is in AGENTS.md, and a tag on a side branch is how a
  // release ends up describing code nobody has. Resolved in two calls rather than one per tag:
  // `rev-list` gives the set of commits on main, and `for-each-ref` maps every tag to its commit,
  // peeling annotated tags through `%(*objectname)`.
  if (!gitAvailable) return console.log('    (no git history — release-trail checks skipped)');

  const onMain = new Set(git('rev-list', 'origin/main').split('\n').filter(Boolean));
  const refs = git('for-each-ref', '--format=%(refname:short) %(objectname) %(*objectname)', 'refs/tags')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [tag, object, peeled] = line.split(' ');
      return { tag, commit: peeled || object };
    });

  assert.ok(onMain.size > 0, 'no commits were read from origin/main; the guard would pass vacuously');

  const offMain = refs.filter((ref) => !onMain.has(ref.commit)).map((ref) => ref.tag);
  assert.deepEqual(offMain, [], `tags pointing at commits that are not on main:\n  ${offMain.join('\n  ')}`);
});

test('the recorded gaps are explicit, and adding one is a deliberate edit', () => {
  // The list is the reason the workflow can be run daily without crying wolf. It is asserted rather
  // than trusted for the reason the repository keeps rediscovering: an exemption list that grows
  // quietly is how a check stops being one.
  const offenders = [];
  const seen = new Set();

  for (const entry of knownGaps) {
    if (!Array.isArray(entry.versions) || entry.versions.length === 0) offenders.push('an entry lists no versions');
    if (!entry.missing.every((channel) => CHANNELS.includes(channel))) {
      offenders.push(`an entry names a channel that is not one of ${CHANNELS.join(', ')}`);
    }
    if (typeof entry.why !== 'string' || entry.why.length < 60) {
      offenders.push('an entry does not say why in a sentence a reviewer could disagree with');
    }
    for (const version of entry.versions) {
      for (const channel of entry.missing) {
        const key = `${version} ${channel}`;
        if (seen.has(key)) offenders.push(`${version} is exempted from ${channel} twice`);
        seen.add(key);
      }
    }
  }

  assert.deepEqual(offenders, [], `the recorded gaps are not a set of claims a reviewer can check:\n  ${offenders.join('\n  ')}`);
  assert.ok(
    CHANNELS.every((channel) => knownGaps.some((entry) => entry.missing.includes(channel))),
    'both channels must have at least one recorded gap, or one of them is being checked for nothing',
  );
  // Pinned, so that exempting a release is an edit to this number and not a line nobody reads.
  const exempted = knownGaps.reduce((sum, entry) => sum + entry.versions.length, 0);
  assert.equal(exempted, 21, `the recorded gaps now cover ${exempted} versions, not the 21 that were audited`);
});

test('the audit tells a recorded gap from a new one', () => {
  // The split is the whole mechanism: a recorded gap is not a finding, and an unrecorded one is a
  // failure. Exercised on synthetic inputs so this test needs no network and cannot be affected by
  // what the registry happens to say today.
  const result = auditReleaseTrail({
    tags: ['v1.50.0', 'v1.60.0', 'v1.72.0', 'v1.85.0'],
    // `1.50.0` is absent from npm and is on no exemption list, so it must be reported. `1.60.0` and
    // `1.72.0` are absent for the same reason and *are* on the record, so they must not be.
    published: new Set(['1.85.0']),
    released: new Set(['v1.50.0', 'v1.60.0', 'v1.72.0', 'v1.85.0']),
  });

  assert.equal(result.checked, 4, 'every tag is checked; there is no version floor to hide behind');
  assert.deepEqual(
    result.unrecorded,
    [{ version: '1.50.0', tag: 'v1.50.0', channel: 'npm' }],
    'a gap that is not on the record must be reported as a failure',
  );
  assert.deepEqual(
    result.recorded.map((gap) => gap.tag).sort(),
    ['v1.60.0', 'v1.72.0'],
    'the two known-unpublished versions must be recorded rather than reported as new',
  );
});

test('the audit runs on a schedule, not on attention', () => {
  // This is the sentence the whole change exists for. `AGENTS.md` said "run this loop before
  // shipping" for thirty releases and the loop ran when somebody remembered it, which is how two
  // tags stayed unpublished. A workflow that runs daily cannot forget.
  const workflow = readFileSync(join(root, '.github', 'workflows', 'release-audit.yml'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  assert.match(workflow, /cron:/, 'the audit must be scheduled, or it is a ritual with a yml extension');
  assert.match(workflow, /run: node scripts\/audit-release-trail\.mjs/, 'the scheduled job must run the audit');
  assert.match(workflow, /fetch-depth: 0/, 'a shallow clone has no tags, so the audit would pass on an empty list');
  assert.ok(packageJson.scripts['release:audit'], 'the audit must be runnable by hand as `pnpm release:audit`');
});