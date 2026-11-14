/**
 * What is on this machine.
 *
 * Every check the CLI performs before it starts anything, and every installation it should know about —
 * in one module, because the two are the same question asked twice: *what have I got, and what is
 * missing or stale?*
 *
 * The reference implementation answered a version of this by **killing** what it found: its launcher
 * scanned `ps` for anything matching its own name plus `next-server` and killed it, and separately killed
 * whatever held a port it wanted. That is how an unrelated process dies. This module only ever *reports*;
 * removal is a separate, confirmed, explicit act (`scripts/uninstall/`), and the launcher continues to
 * use its own process-group file for the servers it started.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const EXEC_TIMEOUT_MS = 4_000;

/** The Node version this project is built and tested against (see `.nvmrc`). */
export const REQUIRED_NODE_MAJOR = 20;

/** Every package name this project has ever been published under, newest first. */
export const PACKAGE_NAMES = ['@hilbras/omnihilbras', 'omnihilbras'];

/** The command names the packages install. */
export const BIN_NAMES = ['omnihilbras'];

export const DASHBOARD_PORT = 20137;
export const GATEWAY_PORT = 20138;

function exists(candidate) {
  try {
    fs.accessSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/** `version` for a binary, or undefined when it is not installed. Never throws: absence is a fact. */
export async function commandVersion(command, args = ['--version']) {
  try {
    const { stdout } = await run(command, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true });
    return stdout.trim().split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function detectRuntime(env = process.env) {
  const major = Number(process.versions.node.split('.')[0]);
  const [npm, pnpm, git] = await Promise.all([
    commandVersion('npm'),
    commandVersion('pnpm'),
    commandVersion('git'),
  ]);
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    nodeSatisfies: Number.isFinite(major) && major >= REQUIRED_NODE_MAJOR,
    requiredNodeMajor: REQUIRED_NODE_MAJOR,
    npm,
    pnpm,
    git,
    home: os.homedir(),
    // Reported so a check can say "you are running this from a checkout" rather than guessing from a path.
    fromCheckout: env.OMNIHILBRAS_CHECKOUT === '1' || exists(path.join(process.cwd(), 'pnpm-workspace.yaml')),
  };
}

/**
 * Every place an Omnihilbras install, its data or its autostart entry can be, by platform.
 *
 * `data` is separated from `app` on purpose: uninstalling must be able to leave the vault alone, because
 * a vault holds credentials and a program directory does not.
 */
export function installationPaths({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const configBase = env.XDG_CONFIG_HOME?.trim() || (platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config'));
  const stateBase = env.XDG_STATE_HOME?.trim() || (platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.local', 'state'));
  const dataBase = env.XDG_DATA_HOME?.trim() || (platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.local', 'share'));

  const app = [];
  const data = [path.join(home, '.omnihilbras'), path.join(configBase, 'omnihilbras'), path.join(stateBase, 'omnihilbras'), path.join(dataBase, 'omnihilbras')];

  if (platform === 'darwin') {
    app.push('/Applications/OmniHilbras.app', path.join(home, 'Applications', 'OmniHilbras.app'));
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming');
    app.push(path.join(local, 'Programs', 'OmniHilbras'), path.join(local, 'OmniHilbras'), path.join(roaming, 'OmniHilbras'));
  } else {
    app.push('/opt/OmniHilbras', '/usr/lib/omnihilbras', path.join(home, '.local', 'opt', 'OmniHilbras'));
  }

  const autostart = [];
  if (platform === 'darwin') {
    autostart.push(path.join(home, 'Library', 'LaunchAgents', 'com.omnihilbras.app.plist'));
  } else if (platform === 'win32') {
    const roaming = env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming');
    autostart.push(path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'OmniHilbras.vbs'));
  } else {
    autostart.push(path.join(configBase, 'autostart', 'omnihilbras.desktop'), path.join(home, '.config', 'autostart', 'omnihilbras.desktop'));
  }

  return { app, data, autostart };
}

/** Which of those paths actually exist. Existence is the only claim made — nothing is read or moved. */
export function detectPaths(override) {
  const groups = installationPaths(override);
  const found = (list) => list.filter((candidate) => exists(candidate));
  return { app: found(groups.app), data: found(groups.data), autostart: found(groups.autostart) };
}

/**
 * Globally installed copies of any name this project has shipped under.
 *
 * Read through `npm ls -g --json` rather than by looking at `npm root -g` and guessing, because the
 * question is "what does npm think is installed", and a directory left behind by a failed install is a
 * different problem from a registered package — the uninstaller removes both, but they are not the same
 * finding and should not be reported as one.
 */
export async function detectGlobalPackages() {
  const found = [];
  try {
    const { stdout } = await run('npm', ['ls', '-g', '--json', '--depth=0'], { timeout: 12_000, windowsHide: true });
    const parsed = JSON.parse(stdout || '{}');
    const dependencies = { ...(parsed.dependencies ?? {}) };
    for (const name of PACKAGE_NAMES) {
      const entry = dependencies[name];
      if (entry?.version) found.push({ kind: 'npm-global', name, version: entry.version, path: entry.resolved ?? undefined });
    }
  } catch (error) {
    // `npm ls -g` exits non-zero when the tree has problems, and still prints the tree. Try the stdout
    // before giving up on it: a broken global tree is exactly when this check matters most.
    try {
      const parsed = JSON.parse(error.stdout ?? '{}');
      for (const name of PACKAGE_NAMES) {
        const entry = parsed.dependencies?.[name];
        if (entry?.version) found.push({ kind: 'npm-global', name, version: entry.version });
      }
    } catch {
      // No npm, or output that is not JSON. Absence of the answer is reported as absence of the answer.
    }
  }
  return found;
}

/**
 * Binaries named `omnihilbras` anywhere on `PATH`, with what they point at.
 *
 * A copy on `PATH` that npm does not know about is the leftover a reinstall leaves behind, and it is the
 * one that keeps answering after the package is gone — so it is reported separately from the package.
 */
export async function detectPathBinaries({ env = process.env, platform = process.platform } = {}) {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = platform === 'win32' ? BIN_NAMES.flatMap((name) => [`${name}.cmd`, `${name}.ps1`, `${name}.exe`, name]) : [...BIN_NAMES];
  const found = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (!exists(candidate)) continue;
      let target;
      try {
        target = fs.realpathSync(candidate);
      } catch {
        target = undefined;
      }
      found.push({ kind: 'path-binary', path: candidate, ...(target && target !== candidate ? { target } : {}) });
    }
  }
  return found;
}

/**
 * Tool checks, each with the command that fixes it.
 *
 * `fix` is a command line, never an action: nothing in this module runs it. Whether to run it is a
 * decision the person makes, in `setup`, after seeing it.
 */
export async function detectGaps(runtime) {
  const facts = runtime ?? (await detectRuntime());
  const gaps = [];
  if (!facts.nodeSatisfies) {
    gaps.push({
      id: 'node',
      severity: 'blocking',
      title: `Node ${facts.node} is older than the required v${facts.requiredNodeMajor}`,
      detail: 'The gateway targets a Node version this project is built and tested against.',
      fix: facts.platform === 'win32' ? 'winget install OpenJS.NodeJS.LTS' : 'install Node 20+ from https://nodejs.org or your package manager',
    });
  }
  if (!facts.npm) {
    gaps.push({ id: 'npm', severity: 'blocking', title: 'npm was not found', detail: 'npm ships with Node; a missing npm usually means a broken Node install.', fix: 'reinstall Node 20+ from https://nodejs.org' });
  }
  if (!facts.pnpm) {
    gaps.push({
      id: 'pnpm',
      severity: 'needed-from-source',
      title: 'pnpm was not found',
      detail: 'Required to build and run this project from a checkout. A packaged install does not need it.',
      fix: 'corepack enable && corepack prepare pnpm@latest --activate',
    });
  }
  if (!facts.git) {
    gaps.push({ id: 'git', severity: 'needed-from-source', title: 'git was not found', detail: 'Required to fetch the source and to update from it.', fix: facts.platform === 'win32' ? 'winget install Git.Git' : 'install git from your package manager' });
  }
  return gaps;
}

/** One report: everything, gathered in parallel, with nothing changed. */
export async function inspect({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const runtime = await detectRuntime(env);
  const [gaps, globalPackages, pathBinaries] = await Promise.all([
    detectGaps(runtime),
    detectGlobalPackages(),
    detectPathBinaries({ env, platform }),
  ]);
  const paths = detectPaths({ env, home, platform });
  return {
    runtime,
    gaps,
    installs: {
      globalPackages,
      pathBinaries,
      appPaths: paths.app,
      dataPaths: paths.data,
      autostart: paths.autostart,
    },
    // A count rather than a pile of nested emptiness, so a caller can decide in one comparison whether
    // anything on this machine would be removed.
    otherVersionCount: globalPackages.length + pathBinaries.length + paths.app.length,
  };
}
