#!/usr/bin/env node

/**
 * Real start/stop check for the self-contained CLI server, on ports nobody uses.
 *
 * It does not stub the gateway or the dashboard: it stages nothing itself, starts exactly the files a
 * published install gets, and checks both HTTP surfaces before a graceful shutdown. Run it after
 * `pnpm build:cli` (or let `npm pack` do that through `prepack`).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const main = path.join(root, 'cli', 'server', 'main.mjs');
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
const child = spawn(process.execPath, [main, '--port', String(dashboardPort), '--gateway-port', String(gatewayPort), '--no-browser'], {
  env: { ...process.env, XDG_CONFIG_HOME: config },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

let code = 1;
try {
  const gateway = await waitPort(gatewayPort);
  const dashboard = await waitPort(dashboardPort);
  if (!gateway || !dashboard) throw new Error(`servers did not answer: gateway=${gateway} dashboard=${dashboard}`);
  const health = await fetch(`http://127.0.0.1:${gatewayPort}/health`).then((response) => response.json());
  if (health.service !== 'omnihilbras-gateway') throw new Error(`unexpected health: ${JSON.stringify(health)}`);
  const shell = await fetch(`http://127.0.0.1:${dashboardPort}/dashboard`).then((response) => response.text());
  if (!shell.includes('__OMNIHILBRAS_GATEWAY_URL__')) throw new Error('the dashboard shell has no gateway URL injection');
  if (!shell.includes(String(gatewayPort))) throw new Error(`the dashboard shell does not point at port ${gatewayPort}`);
  console.log(`✔ bundled server: gateway ${health.build.version}, dashboard injected`);
  code = 0;
} catch (error) {
  console.error(`✖ ${error.message}`);
  console.error(output);
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('close', resolve));
}
process.exit(code);
