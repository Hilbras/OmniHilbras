import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The `omnihilbras` shortcut, on every path that can install one.
 *
 * Four ways this command can exist, and each needs its own wiring asserted — because the failure mode is
 * silent: a build that produces an installer which looks fine and installs no command. Most of this test is
 * therefore about the *configuration*, and the parts that can be executed here are executed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('package.json'));

test('the published CLI package declares the shortcut and ships the files it needs', () => {
  const cli = JSON.parse(read('cli/package.json'));

  assert.equal(cli.private, false, 'a private manifest cannot be installed, so it can install nothing');
  assert.equal(cli.bin?.omnihilbras, './bin/omnihilbras.js', 'the bin entry is the shortcut');

  // The bin is what npm puts on PATH, so it has to exist, be executable, and be an ESM module — the
  // package declares `"type": "module"` and a shebang-less file would be run as CommonJS.
  const binPath = path.join(root, 'cli', 'bin', 'omnihilbras.js');
  assert.equal(fs.existsSync(binPath), true, 'the bin file exists');
  assert.match(fs.readFileSync(binPath, 'utf8'), /^#!\/usr\/bin\/env node/, 'and has a shebang');
  assert.equal(fs.statSync(binPath).mode & 0o111, 0o111, 'and is executable');

  // Everything the bin imports must be in `files`, or the install produces a command that cannot run.
  // `server` is staged by `prepack` and is not in git, so its committed source is checked here instead.
  assert.deepEqual(cli.files.sort(), ['README.md', 'bin', 'commands', 'index.mjs', 'lib', 'server'].sort());
  for (const directory of ['bin', 'commands', 'lib', 'server-src']) {
    assert.equal(fs.existsSync(path.join(root, 'cli', directory)), true, `cli/${directory} is packaged and exists`);
  }
  assert.equal(cli.scripts.prepack, 'node ../scripts/build-cli-server.mjs', 'npm pack stages the bundled server');
  assert.ok(cli.optionalDependencies?.['playwright-core'], 'the browser runtime is optional, not a startup requirement');
  assert.equal(cli.engines.node, '>=20.0.0', 'the runtime requirement is declared, not assumed');
});

test('the CLI package version is one the release actually checks', () => {
  // A globally installed package reports its own manifest's version. If the release bumps everything else
  // and not this, `omnihilbras --version` contradicts the release it came from — which is why
  // `scripts/check-version.mjs` has to know about this manifest.
  const cli = JSON.parse(read('cli/package.json'));
  assert.equal(cli.version, manifest.version, 'cli/package.json tracks the workspace version');
  assert.match(read('scripts/check-version.mjs'), /cli\/package\.json/, 'and the version check enforces it');
});

test('the Windows installer adds and removes PATH, and the script it calls ships inside the app', () => {
  const include = manifest.build.nsis.include;
  assert.equal(include, 'scripts/installer/windows/installer.nsh', 'nsis.include is wired');
  const nsh = read(include);

  assert.match(nsh, /!macro customInstall/, 'NSIS calls customInstall');
  assert.match(nsh, /!macro customUnInstall/, 'and customUnInstall');
  assert.match(nsh, /-Action Install/, 'install runs the script in install mode');
  assert.match(nsh, /-Action Uninstall/, 'and uninstall in uninstall mode');

  // The installer runs *after* the app is copied into place, so the script has to be inside the app.
  const resources = manifest.build.extraResources ?? [];
  const installerResources = resources.find((entry) => entry.to === 'installer');
  assert.ok(installerResources, 'the installer scripts are packaged as extra resources');
  assert.equal(installerResources.from, 'scripts/installer/windows');
  assert.match(nsh, /\$INSTDIR\\resources\\installer\\shortcut\.ps1/, 'and NSIS looks for it where extraResources puts it');

  const script = read('scripts/installer/windows/shortcut.ps1');
  assert.match(script, /HKCU:\\Environment/, 'the user PATH, which needs no elevation');
  assert.match(script, /DoNotExpandEnvironmentNames/, 'reading PATH without expanding %VARIABLES% into literals');
  assert.match(script, /-ieq \$target/, 'comparing whole segments case-insensitively');
});

test('the macOS shim exists, is valid shell, and refuses to take someone else’s link', () => {
  const shim = 'scripts/installer/macos/shortcut.sh';
  // A shell syntax check is the one part of the macOS path that can be verified off a Mac.
  execFileSync('sh', ['-n', path.join(root, shim)]);
  const script = read(shim);

  assert.match(script, /--install/, 'it can install');
  assert.match(script, /--uninstall/, 'and uninstall');
  // The Linux deb's generated script deletes a non-alternatives link it finds at /usr/bin/omnihilbras,
  // which silently removes an npm-installed client. This one refuses instead.
  assert.match(script, /Refusing to replace/, 'it will not overwrite a link it did not create');
  assert.match(script, /Not removing/, 'and will not remove one it did not create');
});

test('the Windows uninstaller also clears PATH, so no dead command is left behind', () => {
  const uninstaller = read('scripts/uninstall/windows.ps1');
  assert.match(uninstaller, /Removing from PATH/, 'it reports the step');
  assert.match(uninstaller, /HKCU:\\Environment/, 'and edits the user PATH');
  assert.match(uninstaller, /DoNotExpandEnvironmentNames/, 'without freezing %VARIABLES%');
});

test('the Linux shortcut is what electron-builder already installs', () => {
  // Recorded as a guard as much as a claim: the `.deb` gets `/usr/bin/omnihilbras` from electron-builder's
  // generated after-install script, which registers it as an update-alternative. If a future change sets
  // `deb.afterInstall`, that generated script is *replaced* — and this test should be updated deliberately
  // rather than the shortcut disappearing quietly.
  assert.equal(manifest.build.deb, undefined, 'the deb target keeps the generated after-install script');
  assert.equal(manifest.build.linux.executableName, 'omnihilbras', 'and that is the name it puts on PATH');
});
