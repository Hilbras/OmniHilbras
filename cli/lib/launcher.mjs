/**
 * The checkout launcher a published client can delegate to.
 *
 * ## Why delegation exists
 *
 * `@hilbras/omnihilbras` on npm is the **client**: verbs, no server. A checkout's
 * `bin/omnihilbras.js` is the **launcher**: bare invocation starts the gateway and dashboard.
 * A person who has both should not have to remember which one is on `PATH`, and a reinstall of the
 * npm package used to replace the launcher with the client and make `omnihilbras` stop starting
 * anything.
 *
 * So `setup` records the checkout's launcher here, and the client reads it. Bare `omnihilbras` then
 * runs the launcher, while every verb stays the client's. The record is a path, not a credential.
 *
 * ## Why the file is under the config directory
 *
 * It is the same directory the gateway and the client already use, it is created `0700`, and the file
 * is `0600`. Nothing here is secret, but a path a command executes deserves the same handling as the
 * rest of the user's local configuration.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory } from './config.mjs';

const RECORD_NAME = 'launcher.json';

export function launcherRecordPath(env = process.env) {
  return path.join(configDirectory(env), RECORD_NAME);
}

/** The recorded launcher, if it still exists. A moved checkout reads as "not registered". */
export function readRegisteredLauncher(env = process.env) {
  try {
    const stored = JSON.parse(fs.readFileSync(launcherRecordPath(env), 'utf8'));
    const candidate = typeof stored?.path === 'string' ? stored.path : '';
    return candidate && fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records a launcher path.
 *
 * Returns the absolute path written. Refuses a path that is not a file, so a typo cannot make every
 * later `omnihilbras` fail with ENOENT; the caller reports the refusal instead.
 */
export function registerLauncher(launcherPath, env = process.env) {
  const resolved = path.resolve(launcherPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Not a launcher: ${resolved}`);
  }
  const file = launcherRecordPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ path: resolved, recordedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  return resolved;
}

/**
 * Finds the checkout launcher.
 *
 * Order matters:
 *
 * 1. `OMNIHILBRAS_LAUNCHER`, for a caller that is deliberately pointing at one.
 * 2. The path `setup` recorded.
 * 3. A checkout enclosing the current directory — `pnpm-workspace.yaml` **and** `bin/omnihilbras.js`,
 *    so a random directory with a file of that name is not executed.
 *
 * The published client itself is never returned: a delegation that calls back into the client would
 * recurse forever. Its own path is compared before the result is used.
 */
export function findLauncher({ env = process.env, cwd = process.cwd() } = {}) {
  const explicit = env.OMNIHILBRAS_LAUNCHER?.trim();
  if (explicit && fs.existsSync(explicit)) return { path: path.resolve(explicit), source: 'environment' };

  const registered = readRegisteredLauncher(env);
  if (registered) return { path: registered, source: 'setup' };

  let directory = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(directory, 'bin', 'omnihilbras.js');
    if (fs.existsSync(candidate) && fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'))) {
      return { path: candidate, source: 'checkout' };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/** The published client's own entry point, used to refuse delegating to itself. */
export function clientEntryPath(metaUrl = import.meta.url) {
  return fileURLToPath(metaUrl);
}

/**
 * Runs the launcher with the terminal attached, and returns the exit code a shell should see.
 *
 * `stdio: 'inherit'` is deliberate: the launcher owns the spinner, the URLs and Ctrl-C. A wrapper
 * that captured its output would hide all three, and a wrapper that swallowed SIGINT would leave
 * both servers running after the person thought they had stopped them.
 */
export function runLauncher(launcherPath, argv = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcherPath, ...argv], { stdio: 'inherit' });
    child.on('error', (error) => {
      process.stderr.write(`Could not start the checkout launcher: ${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code, signal) => resolve(signal ? 130 : code ?? 1));
  });
}
