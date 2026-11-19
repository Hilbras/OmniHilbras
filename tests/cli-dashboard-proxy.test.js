import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createGatewayServer, GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore } from '../Kernel/API/dist/src/index.js';
import { ProviderRegistry, InMemorySecretStore } from '../Kernel/API/dist/src/core/index.js';
import { createDashboardToken, publishDashboardToken, dashboardTokenHeader } from '../Kernel/API/dist/src/core/dashboard-token.js';
import { createDashboardServer, dashboardTokenPath } from '../cli/server-src/static.mjs';

/**
 * The shipped CLI dashboard, served by `cli/server-src/static.mjs`, in front of a gateway with key
 * enforcement **on**.
 *
 * ## What this guards (3.74.1)
 *
 * `@hilbras/omnihilbras` ships the gateway and the dashboard in one package and starts both. The per-launch
 * dashboard token is, by design, never handed to the browser — only the server-side proxy adds it
 * (`Kernel/API/src/core/dashboard-token.ts`). So if the shipped static server let the browser call the gateway
 * directly, a fresh install that minted a key would lock itself out of its own dashboard: every management
 * call 401s, the badge says *"Gateway needs sign-in"*, and "reload" cannot help. That was the bug.
 *
 * The fix is to make the shipped server behave like the dev proxy: forward `/v1` and `/health` to the gateway
 * and present the token, but **only** for a request the browser marks same-origin. These tests drive the real
 * proxy against a real gateway to pin four properties, none of which any existing test covered.
 */

// One dashboard origin the gateway allowlists, matching the launcher's default (`--port 20137`).
const DASHBOARD_ORIGIN = 'http://localhost:20137';
const DASHBOARD_HOST_HEADER = 'localhost:20137';

/** The gateway's own writer publishes the token; this proves the shipped reader points at the same file. */
function listenOnEphemeral(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

/**
 * A raw request so `host` and `sec-fetch-site` can be set exactly as a browser would — these two headers are
 * what the proxy's trust decision keys on, so `fetch`'s forbidden-header rules cannot drive them.
 */
function raw(port, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/** Builds { gateway, static } with enforcement on and the gateway's token published to a throwaway dir. */
async function startPair(t) {
  const env = { XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'omni-proxy-')) };
  t.after(() => fs.rmSync(env.XDG_CONFIG_HOME, { recursive: true, force: true }));

  // The gateway is the writer of its own token; the shipped server is the reader. They must agree.
  const dashboardToken = createDashboardToken();
  await publishDashboardToken(dashboardToken, env);
  assert.equal(dashboardTokenPath(env), path.join(env.XDG_CONFIG_HOME, 'omnihilbras', 'dashboard-token'), 'the shipped reader points where the gateway writes');

  const apiKeys = new InMemoryApiKeyStore();
  await apiKeys.setEnforced(true); // the documented local-mode default for a store that has minted a key.
  const service = new GatewayService(new ProviderRegistry(), new InMemorySecretStore({ ollama: { type: 'api-key', value: 'x' } }), new InMemoryConnectionStore(), apiKeys);
  const gateway = createGatewayServer(service, { corsOrigins: [DASHBOARD_ORIGIN], dashboardToken });
  const gatewayPort = await listenOnEphemeral(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));

  // A throwaway dashboard root with one SPA shell, so the proxy test never depends on a real `dist/`.
  const dashboardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dash-'));
  fs.writeFileSync(path.join(dashboardRoot, 'dashboard.html'), '<html><head></head><body>app</body></html>');
  t.after(() => fs.rmSync(dashboardRoot, { recursive: true, force: true }));

  const staticServer = createDashboardServer({ env, dashboardRoot, gatewayHost: '127.0.0.1', gatewayPort }).server;
  const staticPort = await listenOnEphemeral(staticServer);
  t.after(() => new Promise((resolve) => staticServer.close(resolve)));

  return { env, gatewayPort, staticPort, dashboardRoot };
}

test('a fresh install opens its own dashboard with key enforcement on', async (t) => {
  const { staticPort } = await startPair(t);
  // The dashboard page calls its own origin; the shipped server reads the token from disk and presents it.
  const viaProxy = await raw(staticPort, {
    path: '/v1/connections',
    headers: { host: DASHBOARD_HOST_HEADER, 'sec-fetch-site': 'same-origin', accept: 'application/json' },
  });
  assert.equal(viaProxy.status, 200, `a same-origin management call through the shipped proxy must succeed with enforcement on, got ${viaProxy.status}`);
});

test('the proxied token is the dashboard token the gateway itself published', async (t) => {
  const { env, gatewayPort, staticPort } = await startPair(t);
  // Positive through the proxy (token attached server-side): trusted, 200.
  const proxied = await raw(staticPort, { path: '/v1/connections', headers: { host: DASHBOARD_HOST_HEADER, 'sec-fetch-site': 'same-origin' } });
  assert.equal(proxied.status, 200, 'the shipped proxy presents the published token and the dashboard is trusted');

  // Negative straight to the gateway: the SAME allowlisted origin but NO token → the token is what grants trust.
  const noToken = await raw(gatewayPort, { path: '/v1/connections', headers: { host: `127.0.0.1:${gatewayPort}`, origin: DASHBOARD_ORIGIN, 'sec-fetch-site': 'same-origin' } });
  assert.equal(noToken.status, 401, 'an allowlisted Origin without the token is still refused — the gate was not loosened');

  // And with the token the gateway accepts, presented directly, it is trusted again — proving which value grants it.
  const token = fs.readFileSync(path.join(env.XDG_CONFIG_HOME, 'omnihilbras', 'dashboard-token'), 'utf8').trim();
  const withToken = await raw(gatewayPort, { path: '/v1/connections', headers: { host: `127.0.0.1:${gatewayPort}`, origin: DASHBOARD_ORIGIN, 'sec-fetch-site': 'same-origin', [dashboardTokenHeader]: token } });
  assert.equal(withToken.status, 200, 'the gateway accepts exactly the token it published');
});

test('a cross-site page reaching the dashboard origin does not get the token', async (t) => {
  const { staticPort } = await startPair(t);
  // Exactly what a malicious webpage does: fetch http://localhost:20137/v1/connections from another site.
  // The browser marks it cross-site, so the shipped proxy must NOT present the token, and the gateway refuses.
  const crossSite = await raw(staticPort, { path: '/v1/connections', headers: { host: DASHBOARD_HOST_HEADER, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' } });
  assert.notEqual(crossSite.status, 200, `a cross-site request must not be served as the dashboard, got ${crossSite.status}`);
});

test('the served shell points the browser at its own origin', async (t) => {
  const { staticPort, dashboardRoot } = await startPair(t);
  // Without this, the production build would call the gateway directly and the proxy could never attach the token.
  const shell = await raw(staticPort, { path: '/dashboard', headers: { host: DASHBOARD_HOST_HEADER } });
  assert.equal(shell.status, 200, 'the SPA shell is served');
  assert.match(shell.text, /globalThis\.__OMNIHILBRAS_GATEWAY_URL__=window\.location\.origin;/, 'the shell sets the gateway address to the page origin so calls are same-origin and reach the proxy');
});
