#!/usr/bin/env node
/**
 * One version, stated once — and a check that says so out loud.
 *
 * The workspace version was duplicated in four places that nothing kept in step: the three
 * `package.json` files, the version the README advertises, and the string the Cline adapter
 * sends as `X-CLIENT-VERSION`. The README drifted to `0.2.0` while the project was at `1.12.2`
 * — a hundred minor versions of nobody noticing, which is exactly the failure mode a check
 * exists to prevent.
 *
 * This does not *generate* anything. It **fails**, in CI and before a release, when the copies
 * disagree — because a generator that rewrites files is itself a thing that can go wrong
 * silently, whereas a failing check cannot.
 *
 * Run with `--fix` to rewrite the README line and the Cline constant from `package.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fix = process.argv.includes('--fix');
const read = (relative) => readFileSync(join(root, relative), 'utf8');
const write = (relative, contents) => writeFileSync(join(root, relative), contents, 'utf8');

const version = JSON.parse(read('package.json')).version;
const problems = [];
const fixed = [];

/** The three published manifests must agree, because a mismatch ships a mismatched artifact. */
for (const manifest of ['packages/omnihilbras-sdk/package.json', 'apps/gateway/package.json']) {
  const found = JSON.parse(read(manifest)).version;
  if (found !== version) problems.push(`${manifest} is ${found}, expected ${version}`);
}

/**
 * The README advertises a version, and it is the first thing a visitor reads.
 *
 * Matched on the line's own shape rather than a bare number, because the README legitimately
 * contains many other version-shaped strings — the bump table's `0.2.0 → 1.0.0` examples, and
 * `127.0.0.1` in every URL. A loose regex "fixes" those and corrupts the document, which is a
 * worse failure than the one being fixed.
 */
const readme = read('README.md');
const readmePattern = /\*\*Current version: (\d+\.\d+\.\d+)\*\*/;
const readmeMatch = readmePattern.exec(readme);
if (!readmeMatch) {
  problems.push('README.md has no "**Current version: x.y.z**" line to check');
} else if (readmeMatch[1] !== version) {
  if (fix) {
    write('README.md', readme.replace(readmePattern, `**Current version: ${version}**`));
    fixed.push(`README.md → ${version}`);
  } else {
    problems.push(`README.md advertises ${readmeMatch[1]}, expected ${version}`);
  }
}

/** The version the Cline adapter reports as its client version. */
const cline = read('packages/omnihilbras-sdk/src/providers/cline/index.ts');
const clinePattern = /const omnihilbrasVersion = '(\d+\.\d+\.\d+)';/;
const clineMatch = clinePattern.exec(cline);
if (!clineMatch) {
  problems.push('cline.ts has no omnihilbrasVersion constant to check');
} else if (clineMatch[1] !== version) {
  if (fix) {
    write('packages/omnihilbras-sdk/src/providers/cline/index.ts', cline.replace(clinePattern, `const omnihilbrasVersion = '${version}';`));
    fixed.push(`cline.ts → ${version}`);
  } else {
    problems.push(`cline.ts sends ${clineMatch[1]} as its client version, expected ${version}`);
  }
}

/**
 * The tag is the release. A version with no tag, or a tag ahead of the tree, means the two
 * histories have diverged — which is the failure this whole exercise exists to prevent.
 *
 * Skipped when there is no git history (a source tarball, a CI checkout with `--depth 1`).
 */
try {
  const tags = execSync('git tag --list "v*" --sort=-v:refname', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);
  if (tags.length > 0) {
    const latest = tags[0].replace(/^v/, '');
    // The tag at or below the current version is fine while a release is being prepared, so
    // only a tag that is *ahead* is an error: that means the tree is behind its own history.
    const [major, minor] = latest.split('.').map(Number);
    const [myMajor, myMinor] = version.split('.').map(Number);
    const tagIsAhead = major > myMajor || (major === myMajor && minor > myMinor);
    if (tagIsAhead) problems.push(`latest tag is v${latest}, ahead of the tree at ${version}`);
  }
} catch {
  // No git, or no tags. Not a failure of this check.
}

if (fixed.length > 0) {
  for (const line of fixed) console.log(`  fixed ${line}`);
}

if (problems.length > 0) {
  console.error(`\n  version check failed at ${version}:`);
  for (const problem of problems) console.error(`    - ${problem}`);
  if (!fix) {
    console.error('\n  run `pnpm version:fix` to rewrite the derived copies from package.json\n');
  }
  process.exit(1);
}

console.log(`  version check passed: ${version}`);
