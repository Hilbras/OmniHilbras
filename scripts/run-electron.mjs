/**
 * Starts Electron for development.
 *
 * A checkout's `chrome-sandbox` is owned by the user, not root:4755, so Electron refuses to start
 * with a FATAL about the SUID helper. Passing `--no-sandbox` unconditionally would hide that and
 * weaken every development run; this checks the helper and only degrades when it is actually broken,
 * with a warning naming the fix. Packaged builds are not started by this script.
 */

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const sandbox = join(root, 'node_modules/electron/dist/chrome-sandbox');

function sandboxIsConfigured() {
  try {
    const info = statSync(sandbox);
    return info.uid === 0 && (info.mode & 0o4000) !== 0;
  } catch {
    return false;
  }
}

const args = ['.', ...process.argv.slice(2)];
if (process.platform === 'linux' && !sandboxIsConfigured()) {
  console.warn(
    'warning: chrome-sandbox is not root:root mode 4755; starting with --no-sandbox.\n' +
      `         Fix once with: sudo chown root:root ${sandbox} && sudo chmod 4755 ${sandbox}`,
  );
  args.push('--no-sandbox');
}

const child = spawn(electronBinary, args, {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
