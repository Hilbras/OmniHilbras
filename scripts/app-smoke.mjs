/**
 * End-to-end smoke test for the desktop app.
 *
 * Runs the real Electron binary with `OMNIHILBRAS_SMOKE=1`; main starts the gateway, opens the
 * renderer, probes the IPC bridge, exercises stop/start, generates one failed request, and prints
 * a `SMOKE {...}` line before quitting. This script asserts that line. A unique `--user-data-dir`
 * keeps it independent of an installed app that may already be running.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packaged = process.argv[2];
const binary = packaged ?? join(root, 'node_modules/electron/dist/electron');
const userData = await mkdtemp(join(tmpdir(), 'omnihilbras-smoke-'));
const args = packaged
  ? ['--no-sandbox', `--user-data-dir=${userData}`]
  : ['.', '--no-sandbox', `--user-data-dir=${userData}`];

const output = await new Promise((resolve, reject) => {
  const child = spawn(binary, args, {
    cwd: root,
    env: { ...process.env, OMNIHILBRAS_SMOKE: '1', OMNIHILBRAS_USER_DATA: userData },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout.on('data', (chunk) => { text += chunk.toString(); });
  child.stderr.on('data', (chunk) => { text += chunk.toString(); });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`The app did not finish its smoke run within 60s.\n${text.slice(-2000)}`));
  }, 60_000);
  child.once('error', reject);
  child.once('exit', (code) => {
    clearTimeout(timer);
    resolve({ code, text });
  });
});

try {
  const line = output.text.split('\n').find((entry) => entry.startsWith('SMOKE '));
  if (!line) throw new Error(`The app printed no smoke result (exit ${output.code}).\n${output.text.slice(-3000)}`);
  const result = JSON.parse(line.slice('SMOKE '.length));
  const failures = [];
  if (!String(result.url).startsWith('app://omnihilbras/')) failures.push(`renderer URL is ${result.url}`);
  if (result.title !== 'OmniHilbras — Dashboard') failures.push(`unexpected title ${result.title}`);
  if (result.shells?.shells !== 1) failures.push(`nested dashboard shell: ${result.shells?.shells}`);
  if (result.shells?.serversHeadings !== 1) failures.push(`Servers heading count ${result.shells?.serversHeadings}`);
  if (!result.controls?.minimize || !result.controls?.maximize || !result.controls?.draggable) failures.push(`window controls incomplete: ${JSON.stringify(result.controls)}`);
  if (!result.probe?.ok) failures.push(`IPC probe failed: ${JSON.stringify(result.probe)}`);
  if (result.cycle?.stopped !== 'stopped') failures.push(`stop did not reach stopped: ${JSON.stringify(result.cycle)}`);
  if (result.cycle?.started !== 'running') failures.push(`start did not reach running: ${JSON.stringify(result.cycle)}`);
  if (!String(result.feed ?? '').includes('streaming')) failures.push('the request feed never connected');
  if (!String(result.feed ?? '').includes('failure')) failures.push('the request feed received no event');
  if (result.server?.state !== 'running') failures.push(`gateway ended in ${result.server?.state}`);
  if (failures.length) {
    console.error(`APP SMOKE FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`app smoke passed: ${result.url} on port ${result.server.port}, ${result.server.restarts} restart(s)`);
} finally {
  await rm(userData, { recursive: true, force: true });
}
