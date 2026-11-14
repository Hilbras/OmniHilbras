import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../src/lib/versionCompare.mjs';

/**
 * The sidebar's update notice.
 *
 * Two kinds of assertion here, and the split is deliberate. The version comparison is **executed**,
 * because it has arithmetic in it and arithmetic is what silently goes wrong — the reference implementation
 * shipped a compare that read `1.2.3-beta` as `NaN`, and every comparison against `NaN` is false, so a
 * prerelease was quietly never announced. Everything else is asserted on the source, because this suite has
 * no DOM: what can be executed is executed, and what cannot is checked for the property rather than
 * pretended to be tested.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('the version comparison is arithmetic, not string ordering', () => {
  // The case a string comparison gets wrong: "3.10.0" < "3.9.0" alphabetically, and 3.10.0 is newer.
  assert.equal(compareVersions('3.10.0', '3.9.0'), 1);
  assert.equal(compareVersions('3.9.0', '3.10.0'), -1);
  assert.equal(compareVersions('3.48.1', '3.48.1'), 0);
  assert.equal(compareVersions('4.0.0', '3.99.99'), 1);
});

test('a prerelease is older than its release, and never NaN', () => {
  /**
   * The bug this pins, from the reference implementation:
   *
   *     "1.2.3-beta".split(".").map(Number)   // [1, 2, NaN]
   *
   * `NaN` comparisons are all false, so `latest > current` was false for every prerelease and the update
   * was never announced. Here a prerelease is ordered *below* its release, which is what semver says.
   */
  assert.equal(compareVersions('3.49.0-rc.1', '3.49.0'), -1, 'a release candidate is older than the release');
  assert.equal(compareVersions('3.49.0', '3.49.0-rc.1'), 1);
  assert.equal(compareVersions('3.49.0-rc.2', '3.49.0-rc.1'), 1, 'and two candidates are ordered by text');
  assert.equal(compareVersions('3.49.0-beta', '3.49.0-rc.1'), -1);
});

test('a leading v, and differing segment counts, are not differences', () => {
  // Release tags are published as `v3.48.1` while the manifest says `3.48.1`.
  assert.equal(compareVersions('v3.48.1', '3.48.1'), 0);
  assert.equal(compareVersions('  v3.49.0  ', '3.48.1'), 1, 'and surrounding whitespace neither');
  assert.equal(compareVersions('3.49', '3.49.0'), 0);
  assert.equal(compareVersions('3.49.0.0', '3.49.0'), 0);
});

test('the notice offers install only where installing is possible', () => {
  const hook = read('src/lib/useUpdateState.ts');
  const indicator = read('src/components/UpdateIndicator.tsx');

  // The desktop bridge owns the updater; a browser has none, so the action is `undefined` rather than a
  // function that would fail or, worse, do nothing at the click.
  assert.match(hook, /download: bridge \? download : undefined/, 'download exists only with the bridge');
  assert.match(hook, /install: bridge \? install : undefined/, 'and so does install');
  assert.match(indicator, /state\.status === 'downloaded' && install &&/, 'the install button is gated on it');
  assert.match(indicator, /state\.status === 'available' && download &&/, 'and so is download');

  // Where it cannot install, it says why and where to go instead — the same honest split the desktop
  // already makes for a `.deb`.
  assert.match(indicator, /This build cannot replace itself/, 'and the reason is stated, not implied');
  assert.match(indicator, /npm i -g @hilbras\/omnihilbras@latest/, 'the browser is given the command');
});

test('a failed check is reported as failed, never as up to date', () => {
  const hook = read('src/lib/useUpdateState.ts');
  // The reference implementation swallowed a failed check and rendered nothing, which reads as "you are
  // current" — a claim it had no basis for.
  assert.match(hook, /status: 'error', reason:/, 'a failed fetch produces an error state with its reason');
  assert.match(hook, /AbortSignal\.timeout\(RELEASE_TIMEOUT_MS\)/, 'and cannot hang: the request is bounded');
  assert.match(hook, /const state: UpdateState = \{ status: 'error'/, 'the error state is what is cached too');
});

test('the notice is re-checked, and can be dismissed for one version only', () => {
  const hook = read('src/lib/useUpdateState.ts');
  // Theirs checked once, 2.5 s after mount, and never again — a tab left open never learned about a
  // release. Two mechanisms here, and a cache so neither is a request storm.
  assert.match(hook, /window\.setInterval\(/, 'a periodic re-check exists');
  assert.match(hook, /visibilitychange/, 'and coming back to the tab re-checks too');
  assert.match(hook, /RELEASE_CACHE_MS/, 'behind a cache, so the interval is cheap');
  assert.match(hook, /Date.now\(\) - checkedAtRef.current < REFOCUS_MIN_INTERVAL_MS/, 'and focus is rate-limited');

  // Dismissal is per version, so skipping one release does not hide the next.
  assert.match(hook, /const skippedVersionKey = 'omnihilbras\.update\.skipped';/, 'the dismissed version is remembered');
  assert.match(hook, /version === skipped/, 'and compared by value, not as a boolean flag');
});

test('the notice lives in the sidebar, next to the gateway badge', () => {
  const shell = read('src/components/DashboardShell.tsx');
  const badge = shell.indexOf('aria-label={gatewayLabel}');
  const indicator = shell.indexOf('<UpdateIndicator collapsed={collapsed} />');
  const nav = shell.indexOf('aria-label="Dashboard navigation"');

  assert.ok(badge > 0, 'the gateway badge is where it was');
  // The reference implementation put its update badge immediately after the gateway badge and before the
  // nav. Asserted as an order rather than a position, so moving either one is a deliberate act.
  assert.ok(indicator > badge, 'the update notice follows the gateway badge');
  assert.ok(indicator < nav, 'and precedes the navigation');

  // One surface, not two: the floating banner that showed the same thing is gone, not left in parallel.
  assert.equal(shell.includes('UpdateBanner'), false, 'the floating banner is not rendered');
  assert.equal(fs.existsSync(path.join(root, 'src/components/UpdateBanner.tsx')), false, 'and its file is gone');
});
