import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inspectShortcut, installShortcut, removeShortcut, shortcutDirectory, shortcutTarget } from '../cli/lib/shortcut.mjs';

/**
 * The `omnihilbras` shortcut that `setup` offers to install.
 *
 * Real files in a temporary home, driven through the same functions `setup` calls — because the failure
 * modes here are filesystem states (a dangling link, a foreign file in the way, a directory not on PATH)
 * and a mock would only test the mock.
 */

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fakeHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'shortcut-home-'));
  const bin = path.join(home, '.local', 'bin');
  await mkdir(bin, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, XDG_BIN_HOME: bin, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  return { home, bin, env, platform: 'linux' };
}

test('the shortcut points at the checkout, which is the entry point that also starts the servers', () => {
  const target = shortcutTarget();
  assert.ok(target, 'a target was found');
  // This is the whole reason the checkout's binary is preferred: `cli/bin/omnihilbras.js` is the published
  // client and cannot start servers.
  assert.equal(target.kind, 'launcher');
  assert.equal(target.path, path.join(root, 'bin', 'omnihilbras.js'));
});

test('installing creates a working command, and verifies it by running it', async (t) => {
  const machine = await fakeHome(t);
  const result = await installShortcut(machine);

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.commandPath, path.join(machine.bin, 'omnihilbras'));
  assert.equal(fs.lstatSync(result.commandPath).isSymbolicLink(), true, 'it is a link, not a copy that would go stale');
  assert.equal(fs.readlinkSync(result.commandPath), path.join(root, 'bin', 'omnihilbras.js'));
  assert.equal(result.onPath, true, 'and its directory is on PATH');

  // The claim "it works" is a run of the command, not an `exists()` check.
  assert.match(String(result.version), /^\d+\.\d+\.\d+/, 'its own --version answered');

  // And independently, as a shell would run it.
  const { stdout } = await run(result.commandPath, ['help'], { env: machine.env });
  assert.match(stdout, /gateway's client/, 'the verbs come with it');
  assert.match(stdout, /start the gateway and the dashboard|Verbs/, 'and the help still describes both halves');
});

test('a command belonging to something else is refused, not replaced', async (t) => {
  const machine = await fakeHome(t);
  // The real case: an older globally installed @hilbras/omnihilbras already put `omnihilbras` here.
  const foreign = path.join(machine.bin, 'omnihilbras');
  await writeFile(foreign, '#!/bin/sh\necho 2.9.18\n');
  await chmod(foreign, 0o755);

  const result = await installShortcut(machine);
  assert.equal(result.ok, false);
  assert.equal(result.foreign, true);
  assert.match(result.reason, /already exists and is not this checkout/);
  assert.match(result.hint, /npm rm -g @hilbras\/omnihilbras/, 'and it says how to remove the old one');

  // Untouched: replacing it would break an installation the person still has.
  assert.equal(fs.lstatSync(foreign).isSymbolicLink(), false, 'the foreign command is still a plain file');
  const { stdout } = await run(foreign, [], { env: machine.env });
  assert.equal(stdout.trim(), '2.9.18', 'and still answers as itself');
});

test('installing twice is idempotent rather than a second copy', async (t) => {
  const machine = await fakeHome(t);
  await installShortcut(machine);
  const again = await installShortcut(machine);
  assert.equal(again.ok, true, again.reason);
  assert.equal(fs.readlinkSync(again.commandPath), path.join(root, 'bin', 'omnihilbras.js'));
});

test('a link whose target is gone is reported as dangling', async (t) => {
  const machine = await fakeHome(t);
  const commandPath = path.join(machine.bin, 'omnihilbras');
  // What a moved or deleted checkout leaves behind: the command exists and does nothing.
  fs.symlinkSync(path.join(machine.home, 'gone', 'omnihilbras.js'), commandPath);
  const state = inspectShortcut(machine);
  assert.equal(state.present, true);
  assert.equal(state.dangling, true, 'and it is named rather than left to be discovered');
});

test('removal takes only our own command', async (t) => {
  const machine = await fakeHome(t);
  await installShortcut(machine);
  const removed = removeShortcut(machine);
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(path.join(machine.bin, 'omnihilbras')), false);

  // A foreign one survives, and says so.
  const foreign = path.join(machine.bin, 'omnihilbras');
  await writeFile(foreign, '#!/bin/sh\necho other\n');
  await chmod(foreign, 0o755);
  const refused = removeShortcut(machine);
  assert.equal(refused.removed, false);
  assert.match(refused.reason, /is not this checkout's/);
  assert.equal(fs.existsSync(foreign), true);
});

test('the traditional reason it would not be found is reported, not assumed away', async (t) => {
  const machine = await fakeHome(t);
  /**
   * A shell that has not picked the directory up: `~/.local/bin` is not on every default PATH.
   *
   * The directory is removed from PATH while `node` stays reachable — the first version of this test
   * stripped PATH to `/usr/bin:/bin`, which also hid `node`, so the *verification* failed for a reason
   * that had nothing to do with what was being tested and the assertion read as a broken shortcut.
   */
  const withoutBin = (machine.env.PATH ?? '').split(path.delimiter).filter((entry) => entry && entry !== machine.bin).join(path.delimiter);
  const result = await installShortcut({ ...machine, env: { ...machine.env, PATH: withoutBin } });

  assert.equal(result.ok, true, 'the link is still made and it runs');
  assert.equal(result.onPath, false, 'and the fact that it is not on PATH is reported');
  assert.match(String(result.hint), /Add .* to PATH/);
});

test('it names the command that would actually run when ours is absent', async (t) => {
  const machine = await fakeHome(t);
  // An older installation elsewhere on PATH — the situation on the machine this was written on, where
  // "not on PATH" was simply false.
  const elsewhere = path.join(machine.home, 'nodejs', 'bin');
  await mkdir(elsewhere, { recursive: true });
  await writeFile(path.join(elsewhere, 'omnihilbras'), '#!/bin/sh\necho 2.9.18\n');
  await chmod(path.join(elsewhere, 'omnihilbras'), 0o755);
  const env = { ...machine.env, PATH: `${elsewhere}${path.delimiter}${machine.env.PATH}` };

  const state = inspectShortcut({ ...machine, env });
  assert.equal(state.present, false, 'our shortcut is not there');
  assert.equal(state.foreign.includes(path.join(elsewhere, 'omnihilbras')), true, 'and the other one is found');
});

test('the directory is the user-scope one, by platform, so no password is needed', () => {
  assert.equal(shortcutDirectory({ platform: 'linux', env: {}, home: '/home/x' }), '/home/x/.local/bin');
  assert.equal(shortcutDirectory({ platform: 'darwin', env: {}, home: '/Users/x' }), '/Users/x/.local/bin');
  assert.equal(
    shortcutDirectory({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, home: 'C:\\Users\\x' }),
    path.join('C:\\Users\\x\\AppData\\Local', 'Programs', 'omnihilbras', 'bin'),
  );
});
