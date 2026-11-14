import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * F1: the desktop updater no longer installs whatever the feed says.
 *
 * The audit's highest finding. Electron's updater compared a download against a `sha512` taken from the
 * same release's `latest-*.yml` — corruption detection, not substitution — and every build is unsigned,
 * so anyone able to publish a release could have had code executed on every install.
 *
 * Signing keys do not exist yet, so the fix that is available now is the one that stops the silence: the
 * main process reports that it cannot prove an update, and the install path refuses until a person says
 * otherwise. These assertions keep that from being quietly removed when the flow is next touched.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const main = readFileSync(join(root, 'desktop', 'main.mjs'), 'utf8');
const preload = readFileSync(join(root, 'desktop', 'preload.cjs'), 'utf8');
const banner = readFileSync(join(root, 'src', 'components', 'UpdateBanner.tsx'), 'utf8');
const bridge = readFileSync(join(root, 'src', 'lib', 'electronBridge.ts'), 'utf8');

test('the main process reports whether it can prove an update', () => {
  assert.match(main, /function updateTrust\(\)/, 'there must be one place that decides this');
  assert.match(main, /OMNIHILBRAS_UPDATE_PUBLIC_KEY/, 'and it must look for a pinned key');
  // It must not claim a proof it does not have.
  assert.match(main, /return \{ signed: false, reason: 'No release-signing key is configured/, 'an unconfigured build says so');
  assert.match(main, /\.\.\.updateTrust\(\)/, 'the state sent to the renderer carries it');
});

test('an unverified update cannot be installed without an explicit decision', () => {
  assert.match(main, /async function installUpdate\(options = \{\}\)/, 'the install path takes the decision as an argument');
  assert.match(main, /if \(!trust\.signed && options\?\.allowUnsigned !== true\)/, 'and refuses without it');
  assert.match(main, /Confirm that you want to install an unverified update/, 'with a message that says what is being asked');
  // Nothing else in the process may pass that flag on its own: the IPC handler forwards what the
  // renderer sent, and the renderer is where the confirmation lives.
  assert.match(main, /ipcMain\.handle\('update:install', \(_event, options\) => installUpdate\(options \?\? \{\}\)\)/);
});

test('the confirmation is in the interface, not only in the main process', () => {
  assert.match(bridge, /install: \(options\?: \{ allowUnsigned\?: boolean \}\) => Promise<void>/, 'the bridge carries the option');
  assert.match(bridge, /signed\?: boolean/, 'and the state carries the verdict');
  assert.match(banner, /window\.confirm\(/, 'the banner asks');
  assert.match(banner, /state\.signed === false/, 'only when the update cannot be proved');
  assert.match(banner, /allowUnsigned: true/, 'and only the confirmed path passes the flag');
});

test('the preload forwards the option rather than inventing it', () => {
  assert.match(preload, /install: \(options\) => ipcRenderer\.invoke\('update:install', options\)/);
  assert.doesNotMatch(preload, /allowUnsigned: true/, 'the renderer decides, not the bridge');
});
