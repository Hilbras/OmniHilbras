import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The desktop updater reads a channel manifest (`latest.yml`, `latest-linux.yml`, `latest-mac.yml`) from the
 * release. Publishing only the four binaries makes every installed app fail its check with
 * `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` — the user sees nothing, because the sidebar hid error states.
 * These assertions make the feed part of the build contract rather than a comment in the workflow.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(root, '.github/workflows/desktop.yml'), 'utf8');
const main = readFileSync(join(root, 'desktop/main.mjs'), 'utf8');
const indicator = readFileSync(join(root, 'src/components/UpdateIndicator.tsx'), 'utf8');

test('every desktop platform publishes the channel manifest electron-updater needs', () => {
  assert.match(workflow, /release\/\*\.deb\s*\n\s*release\/\*\.AppImage\s*\n\s*release\/latest-linux\.yml/,
    'Linux must upload latest-linux.yml beside the packages');
  assert.match(workflow, /release\/\*\.exe\s*\n\s*release\/latest\.yml/,
    'Windows must upload latest.yml beside the installer');
  assert.match(workflow, /release\/\*\.dmg\s*\n\s*release\/\*\.zip\s*\n\s*release\/latest-mac\.yml/,
    'macOS must upload latest-mac.yml beside the dmg');
  assert.match(workflow, /if-no-files-found: error/, 'a missing manifest must fail the build, not silently ship');
});

test('the app never offers an install it cannot perform', () => {
  assert.match(main, /function canSelfUpdate\(\)/, 'one capability decision');
  assert.match(main, /if \(process\.platform === 'darwin'\) return Boolean\(pendingZipFile\)/,
    'a dmg-only feed cannot self-update on macOS');
  assert.match(main, /pendingZipFile = process\.platform === 'darwin'/, 'the feed is searched for a zip');
  assert.match(main, /const canInstall = canSelfUpdate\(\) \|\| debUpdate/, 'a .deb is offered as a system install instead');
  assert.match(indicator, /state\.canInstall &&/, 'the sidebar gates its actions on that decision');
  assert.match(indicator, /state\.installMethod === 'deb' \? 'Open installer'/, 'a .deb is not sold as an in-place restart');
});

test('a long-running app actually rechecks, and failures are visible', () => {
  assert.match(main, /setInterval\(\(\) => \{ void checkForUpdates\(\); \}, 6 \* 60 \* 60 \* 1000\)/,
    'the promised timer exists');
  assert.match(main, /status: 'error'/, 'errors are logged into update state');
  assert.match(indicator, /Errors stay in Settings/, 'but a failed check does not become a permanent badge');
  assert.match(main, /trustReason: trust\.reason/, 'the actual reason survives the trust merge');
});

test('an inactive updater cannot leave the state stuck at checking', () => {
  assert.match(main, /const result = await active\.checkForUpdates\(\)/, 'the check result is inspected');
  assert.match(main, /if \(!result\) \{[\s\S]*?status: 'error', reason \}\)\;/, 'a null result becomes an explicit error');
  assert.match(main, /This build cannot check for updates/, 'the reason says what the user can do');
  assert.match(main, /await checkForUpdates\(\);\n\s*console\.log\(`SMOKE/, 'the smoke run drives a check');
  const smoke = readFileSync(join(root, 'scripts/app-smoke.mjs'), 'utf8');
  assert.match(smoke, /updateStatus === 'checking'/, 'a stuck check fails the smoke run');
});

test('a failed download is reported instead of hanging at 85 percent', () => {
  assert.match(main, /async function downloadUpdate\(\) \{\s*try \{/, 'download errors are caught');
  assert.match(main, /Update download failed:/, 'and logged');
  assert.match(main, /setUpdateState\(\{ status: 'error', reason \}\)/, 'and pushed to the UI');
  assert.match(indicator, /actionError/, 'the popup has somewhere to show it');
  assert.match(indicator, /void download\(\)\.catch/, 'a rejected download is handled in the popup');
  assert.match(indicator, /void install\(\)\.then/, 'so is a declined consent');
  assert.match(indicator, /void install\(\)\.then[\s\S]*?\.catch/, 'and a rejected install');
});

test('macOS publishes a zip so MacUpdater has the asset it needs', () => {
  assert.match(workflow, /target: --mac dmg zip/, 'the build makes both formats');
  assert.match(workflow, /release\/\*\.zip/, 'and the release publishes the zip');
});
