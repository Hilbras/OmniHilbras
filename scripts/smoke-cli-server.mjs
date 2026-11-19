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
  if (!shell.includes('__OMNIHILBRAS_GATEWAY_URL__')) throw new Error('the dashboard shell has no gateway address injection');
  // The shell must point the browser at its OWN origin, not the gateway port: that is what makes management
  // calls same-origin so the proxy below can attach the token. Asserting the old literal port is exactly the
  // design this replaces.
  if (!/globalThis\.__OMNIHILBRAS_GATEWAY_URL__\s*=\s*window\.location\.origin/.test(shell)) {
    throw new Error('the dashboard shell does not point the browser at window.location.origin');
  }

  // The fix, end to end. A management call the browser marks same-origin must be served by the gateway through
  // the shipped proxy, which presents the token the freshly-started gateway just published. This is the call
  // that answered 401 ("Gateway needs sign-in") before 3.74.1 on any install with key enforcement on — which is
  // the default. The temp config dir has no api-keys.json, so enforcement is on here, which is the point.
  const proxied = await fetch(`http://127.0.0.1:${dashboardPort}/v1/connections`, {
    headers: { 'sec-fetch-site': 'same-origin', accept: 'application/json' },
  });
  if (proxied.status !== 200) throw new Error(`a same-origin management call through the shipped proxy must be served, got ${proxied.status}`);

  // And a request the browser would not mark same-origin is not served as the dashboard: enforcement stays on,
  // the token is only presented for the page's own origin.
  const crossSite = await fetch(`http://127.0.0.1:${dashboardPort}/v1/connections`, {
    headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
  });
  if (crossSite.status === 200) throw new Error('a cross-site request must not be served as the dashboard');

  console.log(`✔ bundled server: gateway ${health.build.version}, dashboard same-origin-proxied with enforcement on`);
  code = 0;
} catch (error) {
  console.error(`✖ ${error.message}`);
  console.error(output);
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('close', resolve));
}
process.exit(code);
