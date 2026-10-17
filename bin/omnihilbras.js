#!/usr/bin/env node

/**
 * `omnihilbras` — start the local dashboard and gateway, and stop them again with Ctrl-C.
 *
 * ## Why this exists
 *
 * Starting this project meant running `pnpm dev` and `pnpm dev:gateway` in two terminals and
 * knowing which port each landed on. Two commands, two windows, and no way to tell a server that
 * is starting from one that is wedged.
 *
 * ## What it borrows from the reference launcher, and what it does not
 *
 * Adopted, because each was learned the hard way there:
 *
 * - **Readiness is a TCP connect, not a sleep.** A fixed `setTimeout` is either too short (the
 *   page loads before the gateway answers, and the first request fails) or too long (a crashed
 *   child still makes you wait out the full delay). `waitServerReady` polls the port.
 * - **A spinner, written inline.** One dependency to draw twelve frames would be a poor trade for a
 *   launcher that otherwise uses nothing but `node:` builtins.
 * - **Kill only what we started.** The reference scans `ps` for its own name, and its own comment
 *   records why: a substring match also matches your editor, `grep` and `str`. We keep a PID file
 *   instead, and *still* check the process command line before signalling, because a PID file can
 *   outlive the process it names and PIDs get reused.
 * - **Refuse to touch a port someone else holds.** If 8787 is not ours, we say so and stop, rather
 *   than killing an unknown process to make room.
 *
 * Deliberately not copied: the reference also self-installs native runtime dependencies on first
 * run and can restart the server on crash. Those are conveniences for a published product that ships
 * binaries; this is a developer launcher for a checkout, and a half-installed native module is better
 * reported than silently repaired.
 */

'use strict';

import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * ES module because this package is. The reference launcher is CommonJS, which works there only
 * because its `package.json` does not set `"type": "module"` — copying the module system along with
 * the launcher would have been copying an accident.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const DEFAULT_DASHBOARD_PORT = 5173;
const GATEWAY_PORT = 8787;
const LOOPBACK = '127.0.0.1';
const READY_TIMEOUT_MS = 120_000;

/** Where the PIDs of what we started are recorded. Under XDG so it is not in the checkout. */
const STATE_DIR = process.env.XDG_STATE_HOME
  ? path.join(process.env.XDG_STATE_HOME, 'omnihilbras')
  : path.join(os.homedir(), '.local', 'state', 'omnihilbras');
const PID_FILE = path.join(STATE_DIR, 'run.json');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

const colour = process.stdout.isTTY;
const paint = (code, text) => (colour ? `${code}${text}${OFF}` : text);

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {
    dashboardPort: DEFAULT_DASHBOARD_PORT,
    gatewayPort: GATEWAY_PORT,
    open: true,
    log: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const valueOf = (name) => {
      const next = argv[i + 1];
      // A negative number is a bad value, not a missing one: telling someone `--port -1` "needs a
      // value" sends them looking for an argument they did supply.
      if (next === undefined || (next.startsWith('-') && !/^-?\d/.test(next))) fail(`\`${name}\` needs a value.`);
      i += 1;
      return next;
    };
    if (arg === '-p' || arg === '--port') options.dashboardPort = Number(valueOf(arg));
    else if (arg === '--gateway-port') options.gatewayPort = Number(valueOf(arg));
    else if (arg === '--no-browser') options.open = false;
    else if (arg === '--log') options.log = true;
    else if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--version' || arg === '-v') { console.log(PKG.version); process.exit(0); }
    else fail(`Unknown option \`${arg}\`. Run \`omnihilbras --help\` for what this takes.`);
  }
  for (const [name, port] of [['--port', options.dashboardPort], ['--gateway-port', options.gatewayPort]]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`\`${name}\` must be a port number, not \`${port}\`.`);
  }
  if (options.dashboardPort === options.gatewayPort) fail('The dashboard and the gateway cannot share a port.');
  return options;
}

function usage(code) {
  console.log(`omnihilbras ${PKG.version}

Starts the local gateway and the dashboard, waits until both actually accept
connections, and shuts both down again on Ctrl-C.

  -p, --port <n>         dashboard port        (default ${DEFAULT_DASHBOARD_PORT})
      --gateway-port <n> gateway port          (default ${GATEWAY_PORT})
      --no-browser        do not open a browser
      --log               stream both servers' output instead of capturing it
  -h, --help              this text
  -v, --version           print the version

This is a developer launcher for a checkout — it runs the same commands as
\`pnpm dev\` and \`pnpm dev:gateway\`, in one terminal.`);
  process.exit(code);
}

function fail(message) {
  console.error(`${paint(RED, '✖')} ${message}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Package manager — this is a pnpm workspace, and the lockfile decides
 * ------------------------------------------------------------------ */

function packageManager() {
  if (fs.existsSync(path.join(ROOT, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(ROOT, 'package-lock.json'))) return 'npm';
  if (fs.existsSync(path.join(ROOT, 'yarn.lock'))) return 'yarn';
  fail('No lockfile found. This launcher expects to be run from the OmniHilbras checkout.');
}

/* ------------------------------------------------------------------ *
 * Readiness
 * ------------------------------------------------------------------ */

/**
 * Resolve once something accepts a TCP connection on the port, or false on timeout.
 *
 * A connect says the listener is up. It deliberately does not say the server is *healthy* — a
 * gateway that is listening but cannot reach its providers answers on /health with `degraded`,
 * which is a different and more useful thing to find out.
 */
function waitServerReady(port, { timeoutMs = READY_TIMEOUT_MS, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host: LOOPBACK, port });
      socket.setTimeout(1000);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); retry(); });
      socket.once('error', () => { socket.destroy(); retry(); });
    };
    const retry = () => { if (Date.now() >= deadline) resolve(false); else setTimeout(attempt, intervalMs); };
    attempt();
  });
}

/** True when nothing holds the port. Probed rather than assumed, because a bind error at spawn time
 *  arrives after the spinner has already promised a URL. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, LOOPBACK, () => probe.close(() => resolve(true)));
  });
}

/* ------------------------------------------------------------------ *
 * What we started last time
 * ------------------------------------------------------------------ */

function readPidFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a recorded process group still belongs to us.
 *
 * Both halves are load-bearing. The **group** is what gets signalled, not a single pid: `pnpm` is the
 * process we spawn, but the server that actually binds the port is its child, so killing the recorded
 * pid alone leaves the listener alive and the next run finds its own ports occupied. The **command
 * line** is what makes it safe — a group id can outlive its members and be reused, and signalling a
 * recycled group would kill whatever inherited that id.
 */
function groupIsOurs(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  const members = processGroupMembers(pgid);
  if (members.length === 0) return pidIsAlive(pgid);
  return members.some(({ cmdline }) => cmdline.includes('omnihilbras') || cmdline.includes('vite'));
}

/** Every live process whose process group is `pgid`, read from `/proc`. */
function processGroupMembers(pgid) {
  const members = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return members; // Not Linux; the caller falls back to a plain liveness check.
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // Field 5 of /proc/<pid>/stat is the process group, but comm (field 2) may contain spaces and
      // parentheses, so the fields after it are located from the last ')' rather than by splitting.
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(afterComm[2]) !== pgid) continue;
      const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ').toLowerCase();
      if (cmdline.trim()) members.push({ pid: Number(entry), cmdline });
    } catch { /* the process exited between readdir and read */ }
  }
  return members;
}

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Signal a whole process group, which is why each server was spawned detached. */
function signalGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  try { process.kill(-pgid, signal); } catch { try { process.kill(pgid, signal); } catch { /* already gone */ } }
}

/** Stop whatever the last run of this launcher started, if it is still ours. */
function stopPreviousRun() {
  const record = readPidFile();
  if (!record) return [];
  const stopped = [];
  for (const pgid of [record.dashboardGroup, record.gatewayGroup]) {
    if (!groupIsOurs(pgid)) continue;
    signalGroup(pgid, 'SIGTERM');
    stopped.push(pgid);
  }
  if (stopped.length === 0) return [];
  // Give them a moment to close their listeners before we try to bind the same ports.
  execFileSync(process.execPath, ['-e', `
    const net = require('net');
    const wait = (ports, ms) => new Promise((done) => {
      const end = Date.now() + ms;
      const check = () => {
        let busy = 0;
        for (const p of ports) {
          const s = net.connect({ host: '127.0.0.1', port: p });
          s.on('connect', () => { s.destroy(); busy += 1; });
          s.on('error', () => {});
        }
        setTimeout(() => done(busy === 0 || Date.now() >= end), 150);
      };
      check();
    });
    wait(${JSON.stringify([record.dashboardPort, record.gatewayPort])}, 5000);
  `], { stdio: 'ignore', timeout: 8000 });
  return stopped;
}

function writePidFile(record) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function clearPidFile() {
  try { fs.unlinkSync(PID_FILE); } catch { /* nothing to clear */ }
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

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

const KEEP_LINES = 40;
function captureTail(stream, label) {
  const lines = [];
  stream?.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      lines.push(`${paint(DIM, `[${label}]`)} ${line}`);
      if (lines.length > KEEP_LINES) lines.shift();
    }
  });
  return () => lines;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pm = packageManager();

  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.log(`${paint(DIM, 'Dependencies are not installed; running the install once first.')}`);
    const install = spawn(pm, ['install'], { cwd: ROOT, stdio: 'inherit' });
    const code = await new Promise((resolve) => install.on('close', resolve));
    if (code !== 0) fail('Dependency install failed. Nothing was started.');
  }

  const requested = [
    ['dashboard', options.dashboardPort, 'dashboardGroup'],
    ['gateway', options.gatewayPort, 'gatewayGroup'],
  ];
  // Ask *before* stopping anything. A typo in a port must not cost you a running server: the port you
  // asked for is checked first, and only a port held by our own previous run is treated as reclaimable
  // rather than as someone else's.
  const previous = readPidFile();
  for (const [name, port, groupKey] of requested) {
    if (await isPortFree(port)) continue;
    const holder = previous?.[groupKey];
    if (holder && groupIsOurs(holder)) continue;
    fail(`Port ${port} is already in use, so the ${name} cannot start.\n  Pass a different port (--port / --gateway-port), or stop whatever is using it.`);
  }

  const stopped = stopPreviousRun();
  if (stopped.length > 0) console.log(`${paint(DIM, `Stopped the previous run (pid ${stopped.join(', ')}).`)}`);

  for (const [name, port] of requested) {
    // Reclaimable ports can still be held if the previous run ignored the signal; a bind failure at
    // spawn time would arrive after the spinner had already promised a URL.
    if (!(await isPortFree(port))) {
      fail(`Port ${port} did not free up after stopping the previous run, so the ${name} cannot start.`);
    }
    void name;
  }

  const spinner = createSpinner('starting').start();
  const tails = { gateway: [], dashboard: [] };
  const spawnOne = (label, args) => {
    const child = spawn(pm, args, {
      cwd: ROOT,
      // Detached so Ctrl-C here does not race the package manager's own signal handling; we kill the
      // whole group explicitly in `shutdown`.
      detached: true,
      stdio: options.log ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    if (!options.log) {
      tails[label] = captureTail(child.stdout, label);
      captureTail(child.stderr, label);
    }
    return child;
  };

  const gateway = spawnOne('gateway', ['dev:gateway']);
  const dashboard = spawnOne('dashboard', ['dev']);

  const children = { gateway, dashboard };
  let shuttingDown = false;

  const killGroup = (child) => {
    // The whole group, because the process we spawn is `pnpm` and the server that binds the port is
    // its child. Signalling only the pid we spawned is how a launcher leaves its own port occupied.
    signalGroup(child?.pid, 'SIGTERM');
  };

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    spinner.stop();
    killGroup(dashboard);
    killGroup(gateway);
    clearPidFile();
    console.log(`${paint(DIM, 'Stopped.')}`);
    setTimeout(() => process.exit(code), 300).unref();
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  // A child that dies on its own is the launcher failing, not something to paper over with a restart.
  const onExit = (label) => (code) => {
    if (shuttingDown) return;
    spinner.stop();
    console.error(`${paint(RED, '✖')} the ${label} exited (code ${code}) before startup finished.`);
    for (const line of tails[label] ?? []) console.error(line);
    console.error(`Run \`${pm} dev:${label}\` directly to see everything it printed.`);
    shutdown(1);
  };
  gateway.on('close', onExit('gateway'));
  dashboard.on('close', onExit('dashboard'));

  spinner.update('waiting for the gateway');
  if (!(await waitServerReady(options.gatewayPort))) {
    spinner.fail(`the gateway did not answer on port ${options.gatewayPort}`);
    for (const line of tails.gateway) console.error(line);
    shutdown(1);
    return;
  }
  spinner.update('waiting for the dashboard');
  if (!(await waitServerReady(options.dashboardPort))) {
    spinner.fail(`the dashboard did not answer on port ${options.dashboardPort}`);
    for (const line of tails.dashboard) console.error(line);
    shutdown(1);
    return;
  }

  writePidFile({
    // The group id, not the child's pid alone: each server was spawned detached, so the pid it
    // returned is also the process group its own children inherit — which is where the listening
    // process actually is.
    gatewayGroup: gateway.pid,
    dashboardGroup: dashboard.pid,
    gatewayPort: options.gatewayPort,
    dashboardPort: options.dashboardPort,
    startedAt: new Date().toISOString(),
  });

  const url = `http://localhost:${options.dashboardPort}`;
  spinner.succeed(`${paint(BOLD, 'OmniHilbras')} is running`);
  console.log(`  dashboard  ${url}`);
  console.log(`  gateway    http://${LOOPBACK}:${options.gatewayPort}`);
  console.log(`  ${paint(DIM, 'Ctrl-C stops both.')}`);

  if (options.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {
      console.log(`${paint(DIM, '  (could not open a browser — open the dashboard yourself)')}`);
    }).unref();
  }
}

main().catch((error) => fail(error?.message ?? String(error)));