#!/usr/bin/env node

/**
 * Stages the self-contained server inside the publishable CLI.
 *
 * ## Why the package needs this
 *
 * `@hilbras/omnihilbras` is the only manifest npm publishes, and until now it was a client: verbs
 * against a gateway someone else had started. A person who ran `npm i -g @hilbras/omnihilbras` and then
 * `omnihilbras` got help. The reference launcher they asked us to match ships its server in the
 * package, and this is the equivalent for a pnpm workspace: bundle the gateway into one ESM file, copy
 * the built dashboard, and put both under `cli/server/`.
 *
 * ## Why esbuild and not `pnpm deploy`
 *
 * `pnpm deploy` produces a correct tree, but npm refuses to put a `node_modules` directory in a
 * tarball even when `files` names its parent. The deployed gateway would install with no dependencies
 * at all. A bundle has no such directory, so what is staged is what runs.
 *
 * `playwright-core` is the one external: the web-session providers load it dynamically, and it is a
 * large optional runtime. It is declared as an optional dependency of the CLI, so a machine that skips
 * it still installs, and the provider reports that a browser is needed rather than failing to start.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'cli');
const staged = join(cli, 'server');
const source = join(cli, 'server-src');
/**
 * `pnpm build` has already built the gateway and the dashboard before it calls `--skip-builds`.
 * `npm pack` calls this script with no flag from a checkout that may not have built anything, so it
 * does the full chain. One script, one staging path, no difference between local and published files.
 */
const skipBuilds = process.argv.includes('--skip-builds');

const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });

/**
 * Windows resolves `pnpm` to a `.cmd` shim, which `spawnSync` cannot execute without a shell (and Node
 * refuses `.cmd` via `shell` outright since the 2024 batch-injection fix). Naming the shim is the honest
 * fix: same arguments, same behaviour, and the CI desktop workflow ran this file on windows-latest, where
 * `spawnSync pnpm ENOENT` failed every tag build.
 */
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const steps = [
  ['SDK', ['build:sdk']],
  ['TokenSaver', ['build:token-saver']],
  ['Tools', ['build:tools']],
  ['gateway', ['build:gateway']],
  ['dashboard', ['build:frontend']],
];
if (!skipBuilds) {
  for (const [label, args] of steps) {
    process.stdout.write(`\n▸ ${label}\n`);
    run(packageManager, args);
  }
}

process.stdout.write('\n▸ staging cli/server\n');
rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });

for (const file of ['main.mjs', 'static.mjs']) {
  cpSync(join(source, file), join(staged, file));
}

// One ESM file. `--external:playwright-core` keeps the browser runtime optional; everything else,
// including every workspace SDK, is in the bundle.
run(packageManager, [
  'exec', 'esbuild', 'Kernel/API/dist/src/main.js',
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node20',
  '--external:playwright-core',
  `--outfile=${join(staged, 'gateway.mjs')}`,
]);

const dashboard = join(root, 'dist');
if (!existsSync(join(dashboard, 'dashboard.html'))) {
  throw new Error('The dashboard build did not produce dist/dashboard.html.');
}
cpSync(dashboard, join(staged, 'dashboard'), { recursive: true });

const locales = join(root, 'Kernel', 'API', 'locales');
if (!existsSync(locales)) throw new Error('Kernel/API/locales is missing.');
cpSync(locales, join(staged, 'locales'), { recursive: true });

const required = [
  'gateway.mjs',
  'static.mjs',
  'main.mjs',
  'dashboard/dashboard.html',
  'locales/en.json',
];
for (const file of required) {
  if (!existsSync(join(staged, file))) throw new Error(`The staged server is missing ${file}.`);
}

/**
 * A directory's size, walked with Node instead of `du`.
 *
 * `du -sb` is GNU-only — BSD `du` (macOS runners) refuses the flag, and the desktop workflow failed every
 * tag on that line. A walk over two entries is nothing; portability is the point of the check.
 */
const treeBytes = (target) => {
  const stat = statSync(target);
  if (stat.isFile()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(target)) total += treeBytes(join(target, entry));
  return total;
};

const version = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8')).version;
const bytes = [
  'gateway.mjs',
  'dashboard',
].reduce((total, entry) => {
  const target = join(staged, entry);
  if (!existsSync(target)) return total;
  return total + treeBytes(target);
}, 0);

console.log(`\n✔ staged ${relative(root, staged)} for ${version} — ${(bytes / 1024 / 1024).toFixed(1)} MB`);
