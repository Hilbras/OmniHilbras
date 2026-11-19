#!/usr/bin/env node

/**
 * The bundled server's CLI: the launcher a plain `npm i -g @hilbras/omnihilbras` gets.
 *
 * Unlike the checkout launcher, this one needs no checkout. It starts two processes that ship inside
 * the package — the esbuild-bundled gateway and the static dashboard server — waits for both to accept
 * TCP connections, and keeps a small interactive menu in front of them.
 *
 * ## Ports are cleared, but not blindly
 *
 * The reference launcher kills whatever holds its port. That is convenient and dangerous: a typo in
 * `--port 5432` must not kill PostgreSQL. So the default is to kill a listener whose command line looks
 * like this project's runtime (`node`, `vite`, `pnpm`, `omnihilbras`, `next-server`), and to stop with
 * the PID and command for anything else. `--force` is the explicit override.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
const GATEWAY = path.join(HERE, 'gateway.mjs');
const STATIC = path.join(HERE, 'static.mjs');
const DASHBOARD = path.join(HERE, 'dashboard');

const DEFAULT_DASHBOARD_PORT = 20137;
const DEFAULT_GATEWAY_PORT = 20138;
const LOOPBACK = '127.0.0.1';
const READY_TIMEOUT_MS = 90_000;

const STATE_DIR = process.env.XDG_STATE_HOME
  ? path.join(process.env.XDG_STATE_HOME, 'omnihilbras')
  : path.join(os.homedir(), '.local', 'state', 'omnihilbras');
const PID_FILE = path.join(STATE_DIR, 'bundled.json');

const COLOUR = process.stdout.isTTY;
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';
const paint = (code, text) => (COLOUR ? `${code}${text}${OFF}` : text);

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function createSpinner(text) {
  let frame = 0;
  let timer = null;
  let current = text;
  return {
    update(next) { current = next; },
    start() {
      if (!process.stdout.isTTY) return this;
      process.stdout.write(`\r${SPINNER[0]} ${current}`);
      timer = setInterval(() => { process.stdout.write(`\r${SPINNER[frame++ % SPINNER.length]} ${current}`); }, 90);
      return this;
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
    },
    succeed(message) { this.stop(); console.log(`${paint(GREEN, '✔')} ${message}`); },
    fail(message) { this.stop(); console.log(`${paint(RED, '✖')} ${message}`); },
  };
}

const BOX = process.stdout.isTTY && process.env.TERM !== 'dumb'
  ? { topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯', horizontal: '─', vertical: '│' }
  : { topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+', horizontal: '-', vertical: '|' };
const visibleWidth = (text) => text.replace(/\x1b\[[0-9;]*m/g, '').length;
function summaryBox(title, rows) {
  const lines = [title, ...rows];
  const width = Math.max(...lines.map(visibleWidth));
  const edge = (left, right) => `${left}${BOX.horizontal.repeat(width + 2)}${right}`;
  console.log(edge(BOX.topLeft, BOX.topRight));
  for (const line of lines) console.log(`${BOX.vertical} ${line}${' '.repeat(width - visibleWidth(line))} ${BOX.vertical}`);
  console.log(edge(BOX.bottomLeft, BOX.bottomRight));
}

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

function usage(code) {
  console.log(`omnihilbras ${PKG.version}

Starts the bundled gateway and dashboard, waits until both accept connections,
and stops both on Ctrl-C.

  -p, --port <n>         dashboard port        (default ${DEFAULT_DASHBOARD_PORT})
      --gateway-port <n> gateway port          (default ${DEFAULT_GATEWAY_PORT})
  -n, --no-browser       do not open a browser
  -l, --log              stream both servers' output instead of capturing it
      --force            kill a port holder even when it is not Node/Vite/pnpm
  -y, --yes              do not ask before replacing a previous run
  -h, --help             this text
  -v, --version          print the version

For the client verbs (status, providers, models, test, keys, routing, logs),
run \\\`omnihilbras help\\\`.`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = { dashboardPort: DEFAULT_DASHBOARD_PORT, gatewayPort: DEFAULT_GATEWAY_PORT, open: true, log: false, force: false, yes: false };
  const valueOf = (index, name) => {
    const next = argv[index + 1];
    if (next === undefined || (next.startsWith('-') && !/^-?\d/.test(next))) fail(`\`${name}\` needs a value.`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-p' || arg === '--port') { options.dashboardPort = Number(valueOf(index, arg)); index += 1; }
    else if (arg === '--gateway-port') { options.gatewayPort = Number(valueOf(index, arg)); index += 1; }
    else if (arg === '-n' || arg === '--no-browser') options.open = false;
    else if (arg === '-l' || arg === '--log') options.log = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '-y' || arg === '--yes') options.yes = true;
    else if (arg === '-h' || arg === '--help') usage(0);
    else if (arg === '-v' || arg === '--version') { console.log(PKG.version); process.exit(0); }
    else fail(`Unknown option \`${arg}\`. Run \`omnihilbras --help\` for what this takes.`);
  }
  for (const [name, port] of [['--port', options.dashboardPort], ['--gateway-port', options.gatewayPort]]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`\`${name}\` must be a port number, not \`${port}\`.`);
  }
  if (options.dashboardPort === options.gatewayPort) fail('The dashboard and the gateway cannot share a port.');
  return options;
}

function fail(message) {
  console.error(`${paint(RED, '✖')} ${message}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Ports and recorded runs
 * ------------------------------------------------------------------ */

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
  } catch {
    return undefined;
  }
}

/** The command line of a PID, for a message and for the "is this ours" decision. */
function commandLine(pid) {
  if (process.platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    } catch { /* fall through to ps */ }
  }
  return run('ps', ['-p', String(pid), '-o', 'command=']) ?? '';
}

/** The process listening on a TCP port, when the platform tools can name it. */
function listenerOn(port) {
  if (process.platform === 'win32') {
    const table = run('netstat', ['-ano', '-p', 'tcp']);
    const line = table?.split('\n').find((row) => new RegExp(`[:.]${port}\\s`).test(row) && /LISTENING/i.test(row));
    const pid = Number(line?.trim().split(/\s+/).pop());
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    const command = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']) ?? '';
    return { pid, command };
  }
  if (process.platform === 'darwin') {
    const pid = Number(run('lsof', ['-ti', `tcp:${port}`])?.split('\n')[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, command: commandLine(pid) } : undefined;
  }
  const output = run('ss', ['-ltnp', `sport = :${port}`]);
  const match = output?.match(/pid=(\d+)/);
  if (match) {
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid, command: commandLine(pid) } : undefined;
  }
  const pid = Number(run('lsof', ['-ti', `tcp:${port}`])?.split('\n')[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? { pid, command: commandLine(pid) } : undefined;
}

function signalPid(pid, signal) {
  if (process.platform === 'win32') {
    run('taskkill', ['/F', '/T', '/PID', String(pid)]);
    return;
  }
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitGone(pid, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

function readPidFile() {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { return undefined; }
}

function writePidFile(record) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PID_FILE, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function clearPidFile() {
  try { fs.unlinkSync(PID_FILE); } catch { /* nothing to clear */ }
}

/** Stops the two processes this launcher started last time, and nothing else. */
async function stopRecorded() {
  const record = readPidFile();
  if (!record) return;
  const pids = [record.gatewayPid, record.staticPid].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  for (const pid of pids) signalPid(pid, 'SIGTERM');
  for (const pid of pids) await waitGone(pid);
  clearPidFile();
}

/**
 * Clears one port.
 *
 * A listener that looks like this project's runtime is killed without a prompt — that is the common
 * case of a previous `pnpm dev`, Vite, or gateway. Anything else is reported, and `--force` is the
 * deliberate override. A port we cannot attribute is never killed.
 */
async function clearPort(port, { force }) {
  const listener = listenerOn(port);
  if (!listener) return { ok: true };
  const ours = /node|vite|pnpm|omnihilbras|next-server/i.test(listener.command);
  if (!ours && !force) {
    return { ok: false, port, pid: listener.pid, command: listener.command };
  }
  console.log(`${paint(DIM, `Stopping pid ${listener.pid} on port ${port}${listener.command ? `: ${listener.command}` : ''}`)}`);
  signalPid(listener.pid, 'SIGTERM');
  if (!(await waitGone(listener.pid))) signalPid(listener.pid, 'SIGKILL');
  await waitGone(listener.pid, 1000);
  return { ok: true, pid: listener.pid };
}

/** Resolves when something accepts TCP on the port, or false on timeout. */
function waitPort(port, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host: LOOPBACK, port });
      socket.setTimeout(800);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); retry(); });
      socket.once('error', () => { socket.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() >= deadline) resolve(false);
      else setTimeout(attempt, 150);
    };
    attempt();
  });
}

function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd') : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(opener, args, { stdio: 'ignore', detached: true }).on('error', () => {
    console.log(paint(DIM, `  (could not open a browser — open ${url} yourself)`));
  }).unref();
}

function captureTail(stream, label, lines) {
  stream?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      lines.push(`${paint(DIM, `[${label}]`)} ${line}`);
      if (lines.length > 40) lines.shift();
    }
  });
  return lines;
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

const options = parseArgs(process.argv.slice(2));
for (const file of [GATEWAY, STATIC, DASHBOARD]) {
  if (!fs.existsSync(file)) fail(`This install is missing \`${path.relative(HERE, file)}\`; reinstall @hilbras/omnihilbras.`);
}

let children = {};
let stopping = false;
let spinner;
let menu;

function killChildren() {
  for (const child of Object.values(children)) {
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    }
  }
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  spinner?.stop();
  menu?.close();
  killChildren();
  await Promise.all(Object.values(children).map((child) => child?.pid ? waitGone(child.pid, 1500) : Promise.resolve(true)));
  for (const child of Object.values(children)) {
    if (child?.pid && alive(child.pid)) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }
  clearPidFile();
  console.log(paint(DIM, 'Stopped.'));
  setTimeout(() => process.exit(code), 200).unref();
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

async function start() {
  stopping = false;
  await stopRecorded();

  for (const [name, port] of [['dashboard', options.dashboardPort], ['gateway', options.gatewayPort]]) {
    const result = await clearPort(port, { force: options.force });
    if (!result.ok) {
      fail(`Port ${port} is held by pid ${result.pid}${result.command ? ` (${result.command})` : ''}.\n  That does not look like this project, so it was left alone. Pass \`--force\` to stop it, or choose another port.`);
    }
  }

  const tails = { gateway: [], dashboard: [] };
  const stdio = options.log ? 'inherit' : ['ignore', 'pipe', 'pipe'];
  const gateway = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      OMNIHILBRAS_PORT: String(options.gatewayPort),
      OMNIHILBRAS_BUILD_VERSION: PKG.version,
      OMNIHILBRAS_CORS_ORIGINS: [...new Set([
        ...(process.env.OMNIHILBRAS_CORS_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
        `http://localhost:${options.dashboardPort}`,
        `http://127.0.0.1:${options.dashboardPort}`,
      ])].join(','),
    },
    stdio,
  });
  const dashboard = spawn(process.execPath, [STATIC], {
    env: {
      ...process.env,
      OMNIHILBRAS_DASHBOARD_PORT: String(options.dashboardPort),
      OMNIHILBRAS_GATEWAY_PORT: String(options.gatewayPort),
    },
    stdio,
  });
  children = { gateway, dashboard };
  if (!options.log) {
    captureTail(gateway.stderr, 'gateway', tails.gateway);
    captureTail(gateway.stdout, 'gateway', tails.gateway);
    captureTail(dashboard.stderr, 'dashboard', tails.dashboard);
    captureTail(dashboard.stdout, 'dashboard', tails.dashboard);
  }

  writePidFile({
    gatewayPid: gateway.pid,
    staticPid: dashboard.pid,
    dashboardPort: options.dashboardPort,
    gatewayPort: options.gatewayPort,
    startedAt: new Date().toISOString(),
  });

  let failed = false;
  const onExit = (label) => (code) => {
    if (stopping || failed) return;
    failed = true;
    spinner?.stop();
    console.error(`${paint(RED, '✖')} the ${label} exited (code ${code}) before startup finished.`);
    for (const line of tails[label] ?? []) console.error(line);
    void shutdown(1);
  };
  gateway.on('close', onExit('gateway'));
  dashboard.on('close', onExit('dashboard'));

  spinner = createSpinner('starting').start();
  spinner.update('waiting for the gateway');
  if (!(await waitPort(options.gatewayPort))) {
    spinner.fail(`the gateway did not answer on port ${options.gatewayPort}`);
    for (const line of tails.gateway) console.error(line);
    await shutdown(1);
    return;
  }
  spinner.update('waiting for the dashboard');
  if (!(await waitPort(options.dashboardPort))) {
    spinner.fail(`the dashboard did not answer on port ${options.dashboardPort}`);
    for (const line of tails.dashboard) console.error(line);
    await shutdown(1);
    return;
  }

  const url = `http://localhost:${options.dashboardPort}`;
  const dashboardUrl = `${url}/dashboard`;
  spinner.succeed(`${paint(BOLD, 'OmniHilbras')} is running`);
  if (process.stdout.isTTY) {
    summaryBox(`${paint(BOLD, 'OmniHilbras')} ${PKG.version}`, [
      `Dashboard  ${dashboardUrl}`,
      `Gateway    http://${LOOPBACK}:${options.gatewayPort}`,
      `Stop       Ctrl-C`,
    ]);
  } else {
    console.log(`  dashboard  ${dashboardUrl}`);
    console.log(`  gateway    http://${LOOPBACK}:${options.gatewayPort}`);
    console.log(`  ${paint(DIM, 'Ctrl-C stops both.')}`);
  }
  if (options.open) openBrowser(dashboardUrl);

  if (process.stdin.isTTY && process.stdout.isTTY && !options.log) {
    menu = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => {
      menu.question('  [1] open dashboard  [2] restart  [3] exit  > ', async (answer) => {
        if (stopping) return;
        const choice = answer.trim();
        if (choice === '1') { openBrowser(dashboardUrl); ask(); }
        else if (choice === '2') { await restart(); ask(); }
        else if (choice === '3') { await shutdown(0); }
        else ask();
      });
    };
    ask();
  }
}

async function restart() {
  if (stopping) return;
  const wasStopping = stopping;
  stopping = true;
  spinner?.stop();
  killChildren();
  await Promise.all(Object.values(children).map((child) => child?.pid ? waitGone(child.pid, 1500) : Promise.resolve(true)));
  clearPidFile();
  stopping = wasStopping;
  await start();
}

void start();
