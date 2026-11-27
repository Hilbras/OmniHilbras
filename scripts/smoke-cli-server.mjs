#!/usr/bin/env node

/**
 * Real start/stop check for the self-contained CLI server, on ports nobody uses.
 *
 * It does not stub the gateway or the dashboard: it stages nothing itself, starts exactly the files a
 * published install gets, and checks both HTTP surfaces before a graceful shutdown. Run it after
 * `pnpm build:cli` (or let `npm pack` do that through `prepack`).
 *
 * Since 3.75.0 it also drives the lifecycle verbs (`ps`, `stop`) against that real run, so the convenience
 * commands are proved end to end and not just unit-tested: the record the launcher writes is the record the
 * verbs read, and `stop` actually ends the processes it started.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const main = path.join(root, 'cli', 'server', 'main.mjs');
const bin = path.join(root, 'cli', 'bin', 'omnihilbras.js');
const dashboardPort = 20437;
const gatewayPort = 20438;

if (!existsSync(main)) {
  console.error('cli/server/main.mjs is missing; run `pnpm build:cli` first.');
  process.exit(1);
}

function waitPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(700);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); retry(); });
      socket.once('error', () => { socket.destroy(); retry(); });
    };
    const retry = () => (Date.now() >= deadline ? resolve(false) : setTimeout(attempt, 150));
    attempt();
  });
}

const config = mkdtempSync(path.join(os.tmpdir(), 'omnihilbras-smoke-'));
const state = mkdtempSync(path.join(os.tmpdir(), 'omnihilbras-smoke-state-'));
const verbEnv = { ...process.env, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, OMNIHILBRAS_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}` };
/**
 * A record from a launcher that predates `runId`.
 *
 * The 4.6.0 launcher crashed on exactly this file with `ReferenceError: currentRunId is not defined`,
 * because `clearPidFile` reached an undeclared name when a stale record had to be cleared at startup.
 * Seeding it here means the smoke test exercises that path instead of only the clean-install one.
 */
mkdirSync(path.join(state, 'omnihilbras'), { recursive: true });
writeFileSync(path.join(state, 'omnihilbras', 'bundled.json'), JSON.stringify({
  gatewayPid: 999999,
  staticPid: 999998,
  dashboardPort: 1,
  gatewayPort: 1,
  startedAt: new Date(0).toISOString(),
}, null, 2));
const child = spawn(process.execPath, [main, '--port', String(dashboardPort), '--gateway-port', String(gatewayPort), '--no-browser'], {
  env: verbEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const childClosed = new Promise((resolve) => child.once('close', resolve));
let bgChild;
let bgClosed;

/** Runs a client verb against this isolated run and parses its `--json` answer. */
function verb(...args) {
  const stdout = execFileSync(process.execPath, [bin, ...args, '--json'], { env: verbEnv, encoding: 'utf8', timeout: 20000 });
  return JSON.parse(stdout);
}
function bgVerb(env, ...args) {
  const stdout = execFileSync(process.execPath, [bin, ...args, '--json'], { env, encoding: 'utf8', timeout: 20000 });
  return JSON.parse(stdout);
}

let code = 1;
try {
  const gateway = await waitPort(gatewayPort);
  const dashboard = await waitPort(dashboardPort);
  if (!gateway || !dashboard) throw new Error(`servers did not answer: gateway=${gateway} dashboard=${dashboard}`);
  const health = await fetch(`http://127.0.0.1:${gatewayPort}/health`).then((response) => response.json());
  if (health.service !== 'omnihilbras-gateway') throw new Error(`unexpected health: ${JSON.stringify(health)}`);
  const shell = await fetch(`http://127.0.0.1:${dashboardPort}/dashboard`).then((response) => response.text());
  if (!shell.includes('__OMNIHILBRAS_GATEWAY_URL__')) throw new Error('the dashboard shell has no gateway address injection');
  if (!/globalThis\.__OMNIHILBRAS_GATEWAY_URL__\s*=\s*window\.location\.origin/.test(shell)) {
    throw new Error('the dashboard shell does not point the browser at window.location.origin');
  }

  // The fix from 3.74.1, end to end: a same-origin management call is served through the shipped proxy with
  // the token the freshly-started gateway published; a cross-site request is not served as the dashboard.
  const proxied = await fetch(`http://127.0.0.1:${dashboardPort}/v1/connections`, { headers: { 'sec-fetch-site': 'same-origin', accept: 'application/json' } });
  if (proxied.status !== 200) throw new Error(`a same-origin management call through the shipped proxy must be served, got ${proxied.status}`);
  const crossSite = await fetch(`http://127.0.0.1:${dashboardPort}/v1/connections`, { headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } });
  if (crossSite.status === 200) throw new Error('a cross-site request must not be served as the dashboard');

  // Lifecycle verbs (3.75.0) against the real run.
  const before = verb('ps');
  if (before.running !== true) throw new Error(`ps should report the run as running, got ${JSON.stringify(before)}`);
  if (before.dashboardPort !== dashboardPort || before.gatewayPort !== gatewayPort) throw new Error(`ps reported the wrong ports: ${JSON.stringify(before)}`);

  // Supervised restart (3.77.0): kill the gateway and the launcher must respawn it (bounded) and serve again.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const oldGatewayPid = before.processes.find((entry) => entry.role === 'gateway').pid;
  process.kill(oldGatewayPid, 'SIGKILL');
  let respawned = false;
  for (let attempt = 0; attempt < 40 && !respawned; attempt += 1) {
    await sleep(250);
    const answered = await fetch(`http://127.0.0.1:${gatewayPort}/health`).then((r) => r.ok).catch(() => false);
    if (!answered) continue;
    const now = verb('ps');
    const newPid = now.processes?.find((entry) => entry.role === 'gateway')?.pid;
    respawned = Boolean(now.running && newPid && newPid !== oldGatewayPid);
  }
  if (!respawned) throw new Error('the gateway was not respawned after a crash');

  const stopped = verb('stop');
  if (stopped.refused?.length) throw new Error(`stop refused its own pids: ${JSON.stringify(stopped.refused)}`);
  // The launcher cascades a shutdown when its gateway exits. A crash during that shutdown still ends
  // the process, so the exit code and stderr are the evidence — a `ReferenceError` there used to pass
  // this test while Ctrl-C would have printed a stack trace.
  const exitCode = await Promise.race([childClosed, new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000))]);
  if (exitCode === 'timeout') throw new Error('the launcher did not exit after its children stopped');
  if (exitCode !== 0) throw new Error(`the launcher exited ${exitCode}: ${output.slice(-2000)}`);
  if (/ReferenceError|TypeError|is not defined/.test(output)) throw new Error(`the launcher shutdown crashed: ${output.slice(-2000)}`);
  if (!/Stopped\./.test(output)) throw new Error(`the launcher did not report a clean stop: ${output.slice(-1000)}`);
  if (existsSync(path.join(state, 'omnihilbras', 'bundled.json'))) throw new Error('stop did not clear the run record');
  const after = verb('ps');
  if (after.running !== false) throw new Error(`ps after stop should report not running, got ${JSON.stringify(after)}`);

  // Background mode (3.77.0): the launcher must EXIT after readiness while the servers keep running, and
  // remain controllable through the record. Different ports so this run is independent of the one above.
  const bgDashboardPort = 20439;
  const bgGatewayPort = 20440;
  const bgEnv = { ...verbEnv, OMNIHILBRAS_GATEWAY_URL: `http://127.0.0.1:${bgGatewayPort}` };
  bgChild = spawn(process.execPath, [main, '--background', '--no-browser', '--port', String(bgDashboardPort), '--gateway-port', String(bgGatewayPort)], { env: bgEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  bgClosed = new Promise((resolve) => bgChild.once('close', resolve));
  const bgExit = await Promise.race([bgClosed, new Promise((resolve) => setTimeout(() => resolve('timeout'), 20000))]);
  if (bgExit === 'timeout') throw new Error('the background launcher did not exit after starting the servers');
  if (!(await waitPort(bgGatewayPort)) || !(await waitPort(bgDashboardPort))) throw new Error('background servers did not survive the launcher exit');
  const bgPs = bgVerb(bgEnv, 'ps');
  if (bgPs.running !== true) throw new Error(`ps should see the background run, got ${JSON.stringify(bgPs)}`);
  const bgStop = bgVerb(bgEnv, 'stop');
  if (bgStop.refused?.length) throw new Error(`stop refused the background pids: ${JSON.stringify(bgStop.refused)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (await waitPort(bgGatewayPort, 1500)) throw new Error('the background gateway is still answering after stop');

  console.log(`✔ bundled server: gateway ${health.build.version}, same-origin proxy, ps/stop lifecycle, background mode`);
  code = 0;
} catch (error) {
  console.error(`✖ ${error.message}`);
  console.error(output);
} finally {
  child.kill('SIGTERM');
  await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (bgChild) {
    bgChild.kill('SIGTERM');
    // The background servers are detached; stop them through the record so none is left behind on a failure.
    try { execFileSync(process.execPath, [bin, 'stop', '--force', '--json'], { env: { ...process.env, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state }, encoding: 'utf8', timeout: 15000 }); } catch { /* already stopped */ }
    if (bgClosed) await Promise.race([bgClosed, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  rmSync(config, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
process.exit(code);
