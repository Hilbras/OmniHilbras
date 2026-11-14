import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The supply-chain rules, as checks rather than as prose.
 *
 * Three of these were findings in the audit: every action ran from a moving major tag inside jobs that
 * held `contents: write`; the release was attached by the build matrix itself, so any leg could publish;
 * and the Docker image resolved `pnpm@latest` while CI pinned a version. A rule written in a document
 * runs exactly as often as somebody reads it, which is why these are assertions.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const workflowsDir = join(root, '.github', 'workflows');
const workflowFiles = readdirSync(workflowsDir).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'));

test('every action is pinned to a commit, not to a moving tag', () => {
  for (const file of workflowFiles) {
    const text = readFileSync(join(workflowsDir, file), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(line);
      if (!match) continue;
      const ref = match[1];
      assert.match(
        ref,
        /@[0-9a-f]{40}$/,
        `${file}: "${ref}" is not pinned to a 40-character commit SHA. A tag can be re-pointed at any commit by whoever owns that repository.`,
      );
    }
  }
});

test('write permission exists only on the publishing job', () => {
  const desktop = readFileSync(join(workflowsDir, 'desktop.yml'), 'utf8');
  const lines = desktop.split('\n');
  // Anchored to the end of the line, so a comment that mentions the permission is not counted as one.
  const writeLines = lines.filter((line) => /^\s+contents:\s*write\s*$/.test(line));
  assert.equal(writeLines.length, 1, `exactly one job may ask for contents: write (found ${writeLines.length})`);

  // …and it must be the publish job, not the workflow header and not a build leg.
  const index = lines.findIndex((line) => /^\s+contents:\s*write\s*$/.test(line));
  const publishJob = lines.findIndex((line) => /^  publish:/.test(line));
  assert.ok(publishJob !== -1 && publishJob < index, 'the write permission must belong to the publish job that follows it');

  // The workflow-level default is read-only, so a new job cannot inherit write by accident.
  assert.match(desktop, /^permissions:\n {2}contents: read$/m, 'the workflow must default to contents: read');
});

test('the release is published by a job that waits for the build, not by the build itself', () => {
  const desktop = readFileSync(join(workflowsDir, 'desktop.yml'), 'utf8');
  assert.match(desktop, /^ {2}publish:\n(?:.*\n)*? {4}needs: \[preflight, build\]/m, 'publishing must depend on the preflight and the build');
  assert.doesNotMatch(desktop, /^ {2}build:\n(?:.*\n)*? {6}uses: softprops\/action-gh-release/m, 'the build matrix must not attach the release');
});

test('a tag is checked against main before anything is published', () => {
  const desktop = readFileSync(join(workflowsDir, 'desktop.yml'), 'utf8');
  assert.match(desktop, /merge-base --is-ancestor/, 'the preflight must verify main ancestry');
  assert.match(desktop, /needs: preflight/, 'the build must wait for that check');
});

test('the pull-request job cannot lend its token to the code it runs', () => {
  const verify = readFileSync(join(workflowsDir, 'verify.yml'), 'utf8');
  // It executes tests/*.test.js, i.e. files a pull request author writes.
  assert.match(verify, /^permissions:\n {2}contents: read$/m, 'verify must declare read-only permissions');
  assert.match(verify, /persist-credentials: false/, 'the checkout token must not be left in .git/config beside untrusted code');
});

test('the container toolchain is pinned to the version CI and the lockfile record', () => {
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const installs = dockerfile.split('\n').filter((line) => /corepack prepare pnpm@/.test(line));
  assert.ok(installs.length > 0, 'the Dockerfile is expected to install pnpm');
  for (const line of installs) {
    assert.match(line, /pnpm@\d+\.\d+\.\d+/, `"${line.trim()}" resolves a moving version`);
  }
  assert.match(dockerfile, /pnpm@12\.5\.1/, 'the pinned version must match the one CI uses');
});
