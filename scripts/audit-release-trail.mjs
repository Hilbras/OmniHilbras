#!/usr/bin/env node
/**
 * The release trail — a pushed tag, a GitHub release, and a version on npm — checked in one command.
 *
 * `AGENTS.md` has required all three since 1.32.1, and until 1.85.1 the only way to check them was a
 * `for` loop pasted into the document. The rule was followed for a while and then not: `v1.60.0` and
 * `v1.72.0` were tagged and never published, and `v1.60.0` had no release either, for thirty releases.
 * Nothing failed, because a check that lives in prose runs exactly as often as somebody reads it.
 *
 * ## Why this is not part of `pnpm verify`
 *
 * `verify` runs on every push and is offline. Requiring it to reach the registry would make the release
 * gate fail whenever npm hiccups, which is a worse trade than a separate check. So the work is split by
 * what each half can prove:
 *
 * - **Offline, in `pnpm verify`:** every tag is an ancestor of `main`, and every tag's own
 *   `package.json` states the version the tag names. `tests/release-trail.test.js`.
 * - **Online, here:** every tag has a GitHub release and a version on npm.
 *   `.github/workflows/release-audit.yml` runs this on a schedule and on demand.
 *
 * ## No version is exempt by default
 *
 * There is no "tags before X are not checked" floor. Every gap is either a failure or an entry in
 * `knownGaps` below, with its reason written down — because a floor is a boundary nobody can see when
 * they are reading the output, and the whole failure this replaces was a rule whose exceptions lived
 * in someone's memory.
 *
 * ## Two network calls, not one per tag
 *
 * `npm view … versions` answers for every published version at once and needs no credentials, and
 * `gh release list` answers for every release at once with the `GH_TOKEN` Actions already provides.
 * An audit that made 312 requests would be an audit somebody disables.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE = '@hilbras/omnihilbras';

/** A tag can be missing from either or both of the two published surfaces. */
export const CHANNELS = ['npm', 'release'];

/**
 * Gaps that are known, understood, and closed to new business.
 *
 * Every entry is a release that broke a rule and cannot be repaired now, with the reason. The list
 * exists so that a *new* gap fails this command while the old ones are on the record rather than in a
 * commit message — and `tests/release-trail.test.js` pins the version count and the shape, so adding
 * an exemption is a deliberate edit that shows up in review rather than something that accumulates.
 *
 * The npm half of `1.60.0` and `1.72.0` is unrepairable in principle rather than in practice: npm
 * publishes forward, and both versions are more than a hundred commits behind the tree. Publishing
 * stale code to close a bookkeeping gap would be the worse outcome.
 */
export const knownGaps = [
  {
    versions: ['0.3.0', '0.3.1', '0.3.2', '0.3.3', '0.3.4', '0.3.5', '0.4.0', '0.4.1', '0.4.2', '0.4.3', '0.4.4', '0.5.0'],
    missing: ['npm'],
    why: 'Tagged 2026-09-26 and 2026-09-27, before the "ship every phase" rule existed and while the package was still unpublished. Never on npm, and nothing to publish now.',
  },
  {
    versions: ['0.6.1', '0.6.2', '0.6.3', '0.6.4', '0.6.5', '0.7.0'],
    missing: ['release'],
    why: 'The same era, before step 5 existed at all. GitHub releases begin at v0.8.0, which is where the rule starts being followed rather than merely intended.',
  },
  {
    versions: ['1.8.2'],
    missing: ['npm', 'release'],
    why: 'Tagged 2026-09-29, the day before the rule was written down (ac7f487), and superseded by v1.9.0 the same day. Neither step happened.',
  },
  {
    versions: ['1.60.0'],
    missing: ['npm'],
    why: 'Tagged 2026-10-04 for the Phase 6 plan commit. Its GitHub release was created retroactively on 2026-10-16 by the audit that found it; the npm half is unrecoverable, as above.',
  },
  {
    versions: ['1.72.0'],
    missing: ['npm'],
    why: 'Tagged 2026-10-06 for the Claude Code commit. The release exists; the publish was skipped, and thirty releases passed before anything noticed.',
  },
  {
    versions: ['3.70.0'],
    missing: ['npm'],
    why: 'Tagged and released on 2026-11-19 but never published: `npm view` still stops at 3.69.0. The npm half is unrecoverable for the reason the rule exists — 3.71.0 supersedes it, and publishing 3.70.0 from its own tag would put superseded code on the registry to close a bookkeeping gap. Recorded rather than repaired.',
  },
  {
    versions: ['3.96.0'],
    missing: ['npm'],
    why: 'Tagged and released with the cycle-1 parity commit (bcd6222d) but never published: `npm view @hilbras/omnihilbras@3.96.0 version` returned E404 in the cycle-5 audit while 3.97.0 resolves. Unrecoverable for the same reason as 3.70.0 — 3.97.0 supersedes it, and publishing stale code from the old tag to close a bookkeeping gap is the worse outcome. Recorded rather than republished.',
  },
  {
    versions: ['3.98.0'],
    missing: ['npm'],
    why: 'Tagged and released with the 3.98.0 manifest bump (67fc9319) while the parity cycles were accumulating work in the tree; the 3.98.0 ceremony was never published. The npm half is unrecoverable because 3.98.1 supersedes it with the tool-schema fix, and publishing stale code from its own tag to close a bookkeeping gap is the worse outcome. Recorded in the 3.98.1 release rather than republished.',
  },
  {
    versions: ['3.0.0', '3.0.1', '3.0.2', '3.0.3', '3.0.4', '3.0.5', '3.1.0', '3.2.0', '3.3.1', '3.4.0', '3.5.0', '3.5.1', '3.6.0', '3.7.0', '3.7.1', '3.8.0', '3.9.0', '3.9.1', '3.9.2', '3.10.0', '3.10.1', '3.10.2', '3.10.3', '3.10.4', '3.11.0', '3.11.1', '3.12.0', '3.12.1', '3.12.2', '3.13.0', '3.14.0', '3.15.0', '3.16.0', '3.17.0', '3.18.0', '3.19.0', '3.20.0', '3.21.0', '3.22.0', '3.23.0', '3.24.0', '3.25.0', '3.26.0', '3.26.1', '3.26.2', '3.26.3', '3.26.4', '3.26.5', '3.26.6', '3.31.0', '3.32.0', '3.33.0', '3.34.0', '3.35.0', '3.36.0', '3.36.1', '3.37.0', '3.37.1', '3.37.2', '3.37.3', '3.37.4', '3.38.0', '3.38.1', '3.39.0', '3.39.1', '3.39.2', '3.40.0', '3.40.1', '3.40.2', '3.40.3', '3.40.4', '3.40.5', '3.41.0', '3.41.1', '3.42.0', '3.43.0', '3.43.1', '3.43.2', '3.43.3', '3.44.0', '3.44.1', '3.45.0', '3.45.1', '3.46.0', '3.47.0', '3.48.0', '3.48.1', '3.49.0'],
    missing: ['npm'],
    why: 'The era when publishing was suspended: the Kernel restructure dissolved the single SDK manifest into private per-provider packages, and `Kernel/API` was made private, so for all of 3.0.0–3.49.0 there was **no publishable manifest at all** — before 3.48.0 not even the CLI package existed. Publishing resumed in 3.50.0, when `cli/` became the one non-private manifest. These cannot be closed and should not be: republishing any of them would put superseded code on the registry, which is worse than a bookkeeping gap, and the CLI the earlier ones would carry is not the CLI that ships now. Recorded rather than repaired, and pinned by `tests/release-trail.test.js` so the exemption is visible in review.',
  },
];

const gapFor = (version, channel) =>
  knownGaps.find((entry) => entry.versions.includes(version) && entry.missing.includes(channel));

function localTags() {
  return execFileSync('git', ['tag', '--list', 'v*', '--sort=v:refname'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * One request for every published version. A public package, so no credentials are involved.
 *
 * **`--prefer-online` is load-bearing, and it was measured rather than assumed.** The npm client caches
 * registry metadata, so a plain `npm view` can answer from a document that predates a publish: `v1.86.0`
 * was published at 06:48 and confirmed live by the registry API, and thirteen consecutive
 * `npm view @hilbras/omnihilbras@1.86.0 version` polls still said it did not exist. A check that reads a
 * cache reports a gap that is not there — the failure mode this command exists to prevent, with the sign
 * flipped, and one that would train a reader to ignore it. The flag costs one uncached request.
 */
function npmVersions() {
  const json = execFileSync('npm', ['view', PACKAGE, 'versions', '--json', '--prefer-online'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(json);
  return new Set(Array.isArray(parsed) ? parsed : [parsed]);
}

/**
 * One request for every release, using the token Actions already provides.
 *
 * The old fixed `--limit 400` worked only while the project had fewer than 400 releases: the 401st would be
 * reported missing from GitHub even with a published release sitting there. The limit is now derived from the
 * local tag list with headroom, so a new tag cannot outgrow it without this line growing too.
 */
function releasedTags(tagCount) {
  const limit = Math.max(400, tagCount + 100);
  const out = execFileSync('gh', ['release', 'list', '--limit', String(limit), '--json', 'tagName', '-q', '.[].tagName'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Set(out.split('\n').map((line) => line.trim()).filter(Boolean));
}

/**
 * The audit itself, split from the process so that a test can call it with synthetic inputs.
 *
 * `recorded` and `unrecorded` are kept apart rather than merged: a known gap is not a finding, and
 * collapsing the two would make the exit code mean nothing.
 */
export function auditReleaseTrail({ tags, published, released }) {
  const recorded = [];
  const unrecorded = [];

  for (const tag of tags) {
    const version = tag.replace(/^v/, '');
    for (const channel of CHANNELS) {
      const present = channel === 'npm' ? published.has(version) : released.has(tag);
      if (present) continue;
      const gap = { version, tag, channel };
      (gapFor(version, channel) ? recorded : unrecorded).push(gap);
    }
  }

  return { checked: tags.length, recorded, unrecorded };
}

function main() {
  let tags;
  let published;
  let released;

  try {
    tags = localTags();
  } catch {
    console.error('  release audit: no git tags available — run this from a checkout.');
    process.exit(2);
  }

  try {
    published = npmVersions();
    released = releasedTags(tags.length);
  } catch (error) {
    // Distinguished from a gap on purpose: an unreachable registry is not evidence that a release is
    // missing, and reporting it as one would teach the reader to ignore this command.
    console.error(`  release audit: could not reach the registry or the GitHub API — ${error.message.split('\n')[0]}`);
    console.error('  Nothing is known about the releases, and this is not a pass.');
    process.exit(2);
  }

  const { checked, recorded, unrecorded } = auditReleaseTrail({ tags, published, released });

  console.log(`\n  release audit — ${checked} tag(s)`);
  console.log(`  npm versions: ${published.size}   github releases: ${released.size}\n`);

  const grouped = new Map();
  for (const gap of recorded) {
    const entry = gapFor(gap.version, gap.channel);
    if (!grouped.has(entry)) grouped.set(entry, new Set());
    // A set, because a tag missing from both channels is one release with two gaps, not two releases.
    grouped.get(entry).add(gap.tag);
  }
  for (const [entry, tags] of grouped) {
    console.log(`  recorded  ${[...tags].join(', ')} — missing ${entry.missing.join(' and ')}`);
    console.log(`            ${entry.why}\n`);
  }

  if (unrecorded.length > 0) {
    console.error('  release trail is broken:');
    for (const gap of unrecorded) {
      const how =
        gap.channel === 'npm'
          ? `no npm version (npm view ${PACKAGE}@${gap.version} version)`
          : 'no github release (gh release create)';
      console.error(`    ${gap.tag} has ${how}`);
    }
    console.error('\n  Steps 4-6 of AGENTS.md: a tag is not a release until all three exist.');
    console.error('  If a gap is deliberate and unrecoverable, record it in `knownGaps` with the reason.\n');
    process.exit(1);
  }

  const recordedVersions = knownGaps.reduce((sum, entry) => sum + entry.versions.length, 0);
  console.log(`  release trail has no unrecorded gaps: every tag is on npm and has a release, except the recorded ones`);
  console.log(`  (${knownGaps.length} recorded gap(s) covering ${recordedVersions} version(s), none of them new)\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) main();