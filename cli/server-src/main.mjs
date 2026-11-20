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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBundledRecord, writeBundledRecord, clearBundledRecord, bundledStateDir, stopBundledServers, waitPidGone } from '../lib/bundled-state.mjs';
import { selectMenu, statusHeader } from '../lib/menu.mjs';
import { restartDecision, MAX_RESTARTS } from '../lib/restart-policy.mjs';
import { checkForUpdate, updateCommand } from '../lib/update.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
const GATEWAY = path.join(HERE, 'gateway.mjs');
const STATIC = path.join(HERE, 'static.mjs');
const DASHBOARD = path.join(HERE, 'dashboard');

const DEFAULT_DASHBOARD_PORT = 20137;
const DEFAULT_GATEWAY_PORT = 20138;
const LOOPBACK = '127.0.0.1';
const READY_TIMEOUT_MS = 90_000;

// The run record's path and read/write live in `cli/lib/bundled-state.mjs`, shared with the lifecycle verbs
// so the launcher and `omnihilbras stop|ps|open|restart` cannot disagree about where the record is.
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
  -b, --background       start detached and exit; stop later with \`omnihilbras stop\`
      --skip-update      do not check the registry for a newer release
      --force            kill a port holder even when it is not Node/Vite/pnpm
  -y, --yes              do not ask before replacing a previous run
  -h, --help             this text
  -v, --version          print the version

For the client verbs (status, providers, models, test, keys, routing, logs),
run \\\`omnihilbras help\\\`.`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = { dashboardPort: DEFAULT_DASHBOARD_PORT, gatewayPort: DEFAULT_GATEWAY_PORT, open: true, log: false, force: false, yes: false, background: false, skipUpdate: false };
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
    else if (arg === '-b' || arg === '--background' || arg === '--detach') options.background = true;
    else if (arg === '--skip-update') options.skipUpdate = true;
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
  return readBundledRecord();
}

function writePidFile(record) {
  writeBundledRecord(record);
}

function clearPidFile() {
  clearBundledRecord();
}

/**
 * Stops the two processes this launcher started last time, and nothing else.
 *
 * A recorded pid is evidence of a past run, never authority to signal: it can outlive its process and be
 * recycled. This now uses the same ownership-verified helper as the `stop`/`restart` verbs — a live pid whose
 * command line is not one of this launcher's servers is reported and left alone, and the record is only
 * cleared when nothing was refused. (Security audit, 2026-11-20.)
 */
async function stopRecorded() {
  const record = readPidFile();
  if (!record) return;
  const { stopped, refused } = stopBundledServers(record);
  await Promise.all(stopped.map((pid) => waitPidGone(pid)));
  for (const entry of refused) {
    console.log(paint(DIM, `Left pid ${entry.pid} alone: not one of this launcher's servers.`));
  }
  if (refused.length === 0) clearPidFile();
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
let startGeneration = 0;
let spinner;
let menuAbort;

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
  menuAbort?.abort();
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
  // Fired now so the registry check overlaps startup; resolved after readiness. Fail-open: a slow or
  // unreachable registry never blocks or fails a start, and `--skip-update` opts out entirely.
  const updatePromise = options.skipUpdate ? Promise.resolve(undefined) : checkForUpdate(PKG.version).catch(() => undefined);
  await stopRecorded();

  for (const [name, port] of [['dashboard', options.dashboardPort], ['gateway', options.gatewayPort]]) {
    const result = await clearPort(port, { force: options.force });
    if (!result.ok) {
      fail(`Port ${port} is held by pid ${result.pid}${result.command ? ` (${result.command})` : ''}.\n  That does not look like this project, so it was left alone. Pass \`--force\` to stop it, or choose another port.`);
    }
  }

  const tails = { gateway: [], dashboard: [] };
  const gatewayEnv = {
    ...process.env,
    OMNIHILBRAS_PORT: String(options.gatewayPort),
    OMNIHILBRAS_BUILD_VERSION: PKG.version,
    // So `GET /` on the gateway port sends a browser to the dashboard instead of a 404. The
    // launcher is the only thing that knows both ports.
    OMNIHILBRAS_DASHBOARD_URL: `http://localhost:${options.dashboardPort}/dashboard`,
    OMNIHILBRAS_CORS_ORIGINS: [...new Set([
      ...(process.env.OMNIHILBRAS_CORS_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
      `http://localhost:${options.dashboardPort}`,
      `http://127.0.0.1:${options.dashboardPort}`,
    ])].join(','),
  };
  const dashboardEnv = {
    ...process.env,
    OMNIHILBRAS_DASHBOARD_PORT: String(options.dashboardPort),
    OMNIHILBRAS_GATEWAY_PORT: String(options.gatewayPort),
  };
  // In the background the servers outlive this launcher, so they are detached and their output goes to a
  // log file under the state directory rather than to a pipe this process owns and would close on exit.
  const childStdio = (name) => {
    if (options.background) {
      const fd = fs.openSync(path.join(bundledStateDir(), `bundled-${name}.log`), 'a');
      return ['ignore', fd, fd];
    }
    return options.log ? 'inherit' : ['ignore', 'pipe', 'pipe'];
  };
  const spawnGateway = () => spawn(process.execPath, [GATEWAY], { env: gatewayEnv, stdio: childStdio('gateway'), detached: options.background });
  const spawnDashboard = () => spawn(process.execPath, [STATIC], { env: dashboardEnv, stdio: childStdio('dashboard'), detached: options.background });

  const gateway = spawnGateway();
  const dashboard = spawnDashboard();
  children = { gateway, dashboard };
  if (!options.log && !options.background) {
    captureTail(gateway.stderr, 'gateway', tails.gateway);
    captureTail(gateway.stdout, 'gateway', tails.gateway);
    captureTail(dashboard.stderr, 'dashboard', tails.dashboard);
    captureTail(dashboard.stdout, 'dashboard', tails.dashboard);
  }

  const recordRun = () => writePidFile({
    gatewayPid: children.gateway.pid,
    staticPid: children.dashboard.pid,
    dashboardPort: options.dashboardPort,
    gatewayPort: options.gatewayPort,
    startedAt: new Date().toISOString(),
  });
  recordRun();

  // `started` flips once both ports answer. Before that, a child exit is a startup failure and fails fast
  // (the original behaviour). After that, it is a crash the restart policy may recover — bounded, so a
  // process that keeps dying immediately is reported rather than spun in a loop.
  let started = false;
  // A deliberate restart kills the old children but their `close` events can land after the next start has
  // begun. Capture this start's generation so a stale close cannot be read as a crash and spawn a duplicate
  // pair over the new one (code review, 2026-11-20).
  const generation = ++startGeneration;
  const childState = { gateway: { restarts: 0, startedAt: Date.now() }, dashboard: { restarts: 0, startedAt: Date.now() } };
  const respawn = { gateway: spawnGateway, dashboard: spawnDashboard };
  const onExit = (label) => (code) => {
    if (stopping || options.background || generation !== startGeneration) return;
    if (!started) {
      spinner?.stop();
      console.error(`${paint(RED, '✖')} the ${label} exited (code ${code}) before startup finished.`);
      for (const line of tails[label] ?? []) console.error(line);
      void shutdown(1);
      return;
    }
    const state = childState[label];
    const decision = restartDecision({ restarts: state.restarts, uptimeMs: Date.now() - state.startedAt });
    if (decision.action === 'stop') {
      spinner?.stop();
      console.error(`${paint(RED, '✖')} the ${label} exited (code ${code}) after ${MAX_RESTARTS} restarts; giving up.`);
      for (const line of tails[label] ?? []) console.error(line);
      void shutdown(1);
      return;
    }
    state.restarts = decision.restarts;
    state.startedAt = Date.now();
    console.error(`${paint(DIM, `the ${label} exited (code ${code}); restarting (${decision.restarts}/${MAX_RESTARTS})`)}`);
    const child = respawn[label]();
    children[label] = child;
    if (!options.log) {
      captureTail(child.stderr, label, tails[label]);
      captureTail(child.stdout, label, tails[label]);
    }
    child.on('close', onExit(label));
    recordRun();
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
  started = true;

  const updateInfo = await updatePromise;
  if (updateInfo?.updateAvailable) {
    console.log(`  ${paint(DIM, `Update available: ${updateInfo.current} → ${updateInfo.latest} · run \`omnihilbras update\``)}`);
  }

  const url = `http://localhost:${options.dashboardPort}`;
  const dashboardUrl = `${url}/dashboard`;
  spinner.succeed(`${paint(BOLD, 'OmniHilbras')} is running`);
  const stopHint = options.background ? 'omnihilbras stop' : 'Ctrl-C';
  if (process.stdout.isTTY) {
    summaryBox(`${paint(BOLD, 'OmniHilbras')} ${PKG.version}`, [
      `Dashboard  ${dashboardUrl}`,
      `Gateway    http://${LOOPBACK}:${options.gatewayPort}`,
      `Stop       ${stopHint}`,
    ]);
  } else {
    console.log(`  dashboard  ${dashboardUrl}`);
    console.log(`  gateway    http://${LOOPBACK}:${options.gatewayPort}`);
    console.log(`  ${paint(DIM, options.background ? 'Running in background. Stop with `omnihilbras stop`.' : 'Ctrl-C stops both.')}`);
  }
  if (options.open) openBrowser(dashboardUrl);

  // Background: the servers are detached and outlive this process. Unref them and exit without the shutdown
  // path (which would kill them); the run record is already written, so `omnihilbras ps|stop` find them.
  if (options.background) {
    children.gateway.unref();
    children.dashboard.unref();
    process.exit(0);
  }

  if (process.stdin.isTTY && process.stdout.isTTY && !options.log) {
    const gatewayUrl = `http://${LOOPBACK}:${options.gatewayPort}`;
    const items = [
      { label: 'Open dashboard', description: 'Servers, providers and keys', section: 'Dashboard' },
      { label: 'Providers', description: 'Connect an account or paste a key', section: 'Dashboard' },
      { label: 'Models', description: 'Saved and catalogued models', section: 'Dashboard' },
      { label: 'Usage', description: 'Requests, tokens and cost', section: 'Dashboard' },
      { label: 'Logs', description: 'Live request log with filters', section: 'Dashboard' },
      { label: 'Restart', description: 'Stop and start both servers', section: 'Server' },
      { label: 'Exit', description: 'Stop both servers and close', section: 'Server' },
    ];
    // The header asks the gateway rather than asserting it: a gateway that did not answer reads as unknown,
    // never as healthy. Uptime is computed from the timestamp the gateway reported, so a clock-skewed
    // launcher cannot claim a process has been up longer than it has. Refreshed on every redraw so a
    // restart is reflected without a relaunch.
    const uptime = (startedAt) => {
      const started = Date.parse(startedAt ?? '');
      if (!Number.isFinite(started)) return undefined;
      const minutes = Math.max(0, Math.floor((Date.now() - started) / 60_000));
      if (minutes < 1) return '<1m';
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ${minutes % 60}m`;
      return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    };
    const header = async () => {
      let health;
      let version;
      let stats;
      try {
        const response = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(1500) });
        const body = await response.json();
        health = body.status;
        version = body.build?.version;
        const running = uptime(body.build?.startedAt);
        if (running) stats = { uptime: running };
      } catch { /* fail-open: the menu still works when the gateway is slow or down */ }
      return statusHeader({ dashboardUrl, gatewayUrl, health, version, update: updateInfo, stats });
    };
    const loop = async () => {
      while (!stopping) {
        menuAbort = new AbortController();
        const choice = await selectMenu({
          items,
          title: `${paint(BOLD, 'OmniHilbras')} ${PKG.version}`,
          header: await header(),
          colour: COLOUR,
          signal: menuAbort.signal,
        });
        if (stopping || choice === -1 || choice === items.length - 1) { await shutdown(0); return; }
        if (choice === items.length - 2) { await restart(); return; }
        const routes = ['', '/providers', '/models', '/usage', '/logs'];
        openBrowser(`${dashboardUrl}${routes[choice] ?? ''}`);
      }
    };
    void loop();
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
