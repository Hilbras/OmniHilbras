/**
 * The server bundled inside the published CLI.
 *
 * `scripts/build-cli-server.mjs` stages `cli/server/gateway.mjs`, `static.mjs`, the dashboard and the
 * locales. A published install therefore has a server, and bare `omnihilbras` starts it with no
 * checkout. A git checkout that has not staged the bundle yet falls back to the launcher delegation,
 * which is why both paths exist.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** `OMNIHILBRAS_BUNDLED_SERVER` exists so a test can point at a stand-in without staging 9 MB. */
export function bundledServerPath(env = process.env) {
  const override = env.OMNIHILBRAS_BUNDLED_SERVER?.trim();
  if (override) return path.resolve(override);
  return path.resolve(here, '..', 'server', 'main.mjs');
}

export function hasBundledServer(env = process.env) {
  try {
    return fs.statSync(bundledServerPath(env)).isFile();
  } catch {
    return false;
  }
}

/**
 * Runs the bundled launcher with the terminal attached.
 *
 * The launcher owns the menu, the spinner and Ctrl-C. Capturing its stdio would break all three, and
 * intercepting SIGINT would leave the gateway and dashboard running after the person stopped the menu.
 */
export function runBundledServer(argv = [], env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundledServerPath(env), ...argv], { stdio: 'inherit', env });
    child.on('error', (error) => {
      process.stderr.write(`Could not start the bundled server: ${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code, signal) => resolve(signal ? 130 : code ?? 1));
  });
}
