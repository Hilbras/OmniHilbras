/**
 * The `omnihilbras` shortcut: putting this project's own command on `PATH` from `setup`.
 *
 * ## Which binary the shortcut points at, and why it matters
 *
 * There are two entry points in this repository and they do different things:
 *
 * | Target | Verbs (`status`, `providers`, …) | Starts the servers |
 * | --- | --- | --- |
 * | `bin/omnihilbras.js` — the private root package | yes | **yes** (`omnihilbras` with no verb runs the gateway and the dashboard) |
 * | `cli/bin/omnihilbras.js` — the publishable package | yes | no: there is no checkout for it to run |
 *
 * So the shortcut prefers the **checkout's** binary when there is one, because that is the entry point
 * that gives both halves of what a person means by "the omnihilbras command". The published package is
 * the fallback, and when that is what gets linked the result is reported honestly: verbs, no servers.
 *
 * ## Why it is a symlink to a file in the repository, and not a copy
 *
 * A copy is a second version of the CLI that goes stale the moment the checkout is updated, and then
 * `omnihilbras --version` disagrees with the repository. A symlink to the working tree cannot drift. The
 * cost is real and is reported rather than hidden: the command stops working if the checkout is moved or
 * deleted, which is why `doctor` checks the link's target and says so when it dangles.
 *
 * ## The rule it shares with the macOS installer script
 *
 * **It never overwrites a command belonging to something else.** A real case on the machine this was
 * written on: an older `@hilbras/omnihilbras@2.9.18` is installed globally with its own `omnihilbras` on
 * `PATH`. Replacing that silently would break an installation the person still has, so a foreign command
 * is reported with the command that removes it, and nothing is touched.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Where a user-scope command can live without asking for a password. */
export function shortcutDirectory({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    // `%LOCALAPPDATA%\Programs\omnihilbras\bin`, the convention an NSIS install of this app already uses,
    // so a user running both does not end up with two directories on PATH.
    const local = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    return path.join(local, 'Programs', 'omnihilbras', 'bin');
  }
  // Linux and macOS: `~/.local/bin` is the standard user bin directory and needs no elevation. It is also
  // not on every distribution's default PATH, which is why membership is checked and reported.
  return env.XDG_BIN_HOME?.trim() || path.join(home, '.local', 'bin');
}

/**
 * The binary the shortcut should run.
 *
 * The checkout's launcher when it is there — it is the only one that can also start the servers — and the
 * publishable client otherwise.
 */
export function shortcutTarget() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const checkoutBin = path.resolve(here, '..', '..', 'bin', 'omnihilbras.js');
  if (fs.existsSync(checkoutBin)) return { path: checkoutBin, kind: 'launcher' };
  const packageBin = path.resolve(here, '..', 'bin', 'omnihilbras.js');
  if (fs.existsSync(packageBin)) return { path: packageBin, kind: 'client' };
  return undefined;
}

function readLink(target) {
  try {
    return fs.readlinkSync(target);
  } catch {
    return undefined;
  }
}

/**
 * Every `omnihilbras` elsewhere on `PATH`.
 *
 * Needed because "not on PATH" was a false statement on the machine this was written on: the shortcut
 * directory was empty, while an older globally installed `@hilbras/omnihilbras` had put a working
 * `omnihilbras` in `~/.local/nodejs/bin`. Reporting the first fact as though it were the second is exactly
 * the kind of claim about the machine that this project keeps having to walk back, so the scan exists and
 * the message says which command would actually run.
 */
function foreignOnPath({ env = process.env, platform = process.platform, commandPath } = {}) {
  const separator = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? ['omnihilbras.cmd', 'omnihilbras.exe', 'omnihilbras.ps1', 'omnihilbras'] : ['omnihilbras'];
  const found = [];
  for (const entry of (env.PATH ?? '').split(separator).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (candidate === commandPath) continue;
      try {
        fs.accessSync(candidate);
        found.push(candidate);
      } catch {
        // Not there: the only reason to look at a directory is to find out.
      }
    }
  }
  return found;
}

function isOnPath(directory, { env = process.env, platform = process.platform } = {}) {
  const separator = platform === 'win32' ? ';' : ':';
  const entries = (env.PATH ?? '').split(separator).filter(Boolean);
  const normalized = directory.replace(/[/\\]+$/, '');
  return entries.some((entry) => entry.replace(/[/\\]+$/, '') === normalized);
}

/** What is already there: nothing, ours, or somebody else's. */
export function inspectShortcut(options = {}) {
  const { platform = process.platform, env = process.env } = options;
  const directory = shortcutDirectory(options);
  const command = platform === 'win32' ? 'omnihilbras.cmd' : 'omnihilbras';
  const commandPath = path.join(directory, command);
  const target = shortcutTarget();

  let present = false;
  let isLink = false;
  try {
    // `lstatSync`, deliberately: `accessSync` follows the link, so a shortcut pointing at a checkout that
    // has since been moved reads as *absent* — and then nothing reports the broken command that is sitting
    // on PATH doing nothing.
    const stats = fs.lstatSync(commandPath);
    present = true;
    isLink = stats.isSymbolicLink();
  } catch {
    present = false;
  }

  const link = isLink ? readLink(commandPath) : undefined;
  const pointsAtUs = Boolean(present && target && (link === target.path || (platform === 'win32' && fs.existsSync(commandPath))));
  return {
    directory,
    commandPath,
    present,
    link,
    target,
    pointsAtUs: pointsAtUs && Boolean(target),
    onPath: isOnPath(directory, { env, platform }),
    // A link whose target no longer exists: the checkout was moved or deleted after the shortcut was made.
    dangling: Boolean(present && link && !fs.existsSync(link)),
    // What a shell would actually run when this checkout's shortcut is absent — possibly the older
    // installation, which is worth naming rather than leaving to be discovered.
    foreign: foreignOnPath({ env, platform, commandPath }),
  };
}

/**
 * Creates the shortcut, and **verifies it by running it**.
 *
 * The verification is the point. A file that exists and is executable can still fail — a shebang that
 * resolves to nothing, a link to a target without the execute bit, a wrapper with the wrong interpreter —
 * and reporting "installed" on the strength of `exists()` is the kind of claim this project keeps having to
 * walk back. So the shortcut is executed and its `--version` output is returned with the result.
 */
export async function installShortcut(options = {}) {
  const { env = process.env, platform = process.platform } = options;
  const state = inspectShortcut(options);
  if (!state.target) {
    return { ok: false, reason: 'Neither this checkout nor the CLI package could be found, so there is nothing to link to.' };
  }
  if (state.present && !state.pointsAtUs) {
    return {
      ok: false,
      reason: `${state.commandPath} already exists and is not this checkout.`,
      hint: `Remove it yourself if you want this one instead${state.link ? ` (it points at ${state.link})` : ''}. If it is an older install of this project, \`npm rm -g @hilbras/omnihilbras\` removes it.`,
      foreign: true,
    };
  }

  fs.mkdirSync(state.directory, { recursive: true });

  if (platform === 'win32') {
    // A `.cmd` wrapper rather than a symlink: Windows symlinks need either elevation or developer mode, and
    // asking for either to place a command is the wrong trade.
    const script = `@echo off\r\n"${process.execPath}" "${state.target.path}" %*\r\n`;
    fs.writeFileSync(state.commandPath, script, 'utf8');
  } else {
    // A symlink, and the execute bit on the *target* is what makes it runnable.
    try {
      fs.chmodSync(state.target.path, 0o755);
    } catch {
      // A read-only checkout is not a reason to fail; the target may already be executable.
    }
    if (state.present) fs.rmSync(state.commandPath, { force: true });
    fs.symlinkSync(state.target.path, state.commandPath);
  }

  const verification = await verifyShortcut(inspectShortcut(options), { env });
  return {
    ok: verification.ok,
    commandPath: state.commandPath,
    directory: state.directory,
    kind: state.target.kind,
    onPath: state.onPath,
    ...(verification.ok ? {} : { reason: verification.reason }),
    ...(state.onPath ? {} : { hint: `Add ${state.directory} to PATH: it is not on one yet, so the command will not be found until a new shell picks it up.` }),
    version: verification.version,
  };
}

/** Runs the shortcut and reads its version — the only claim worth making about "it works". */
export async function verifyShortcut(state = inspectShortcut(), { env = process.env } = {}) {
  if (!state.present) return { ok: false, reason: 'the shortcut is not there' };
  try {
    const { stdout } = await run(state.commandPath, ['--version'], { timeout: 20_000, env, windowsHide: true, shell: process.platform === 'win32' });
    const version = stdout.trim().split('\n').pop()?.trim();
    return version ? { ok: true, version } : { ok: false, reason: 'it ran but printed no version' };
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { ok: false, reason: `running it failed: ${detail}` };
  }
}

/** Removes the shortcut, and only if it is ours. */
export function removeShortcut(options = {}) {
  const state = inspectShortcut(options);
  if (!state.present) return { ok: true, removed: false, reason: 'there was nothing to remove' };
  if (!state.pointsAtUs) return { ok: false, removed: false, reason: `${state.commandPath} is not this checkout's, so it was left alone.` };
  fs.rmSync(state.commandPath, { force: true });
  return { ok: true, removed: true, commandPath: state.commandPath };
}
