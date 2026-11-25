/**
 * The dashboard's static server for the bundled CLI.
 *
 * The Vite dev server does three things for the dashboard: serve `dist/`, rewrite `/dashboard/*` to
 * the SPA shell, and forward `/v1` to the gateway with the per-launch dashboard token attached. A
 * published install has no Vite, so this replaces all three — and the third is what decides between a
 * dashboard that works and one that says *"Gateway needs sign-in"* forever.
 *
 * ## Why the proxy is load-bearing (3.74.1)
 *
 * The dashboard token is deliberately never given to the browser (`Kernel/API/src/core/dashboard-token.ts`):
 * the **dev** proxy reads it from the gateway's user-only state file and adds it to the requests it forwards,
 * so the gateway tells the dashboard's own page from any other local process. The first version of this
 * server injected the gateway URL and let the browser call the gateway **directly** — which works only while
 * key enforcement is off. With enforcement on, the browser has no token to present and no key to hold, so
 * every management call answered 401 and the shell said *"reload the dashboard"*, advice that could never
 * work because the token is not in the browser to reload into. A fresh `npm i -g` that minted a key locked
 * itself out of its own dashboard.
 *
 * So this server does what the dev server does: the browser calls its **own origin** (the injected address is
 * `window.location.origin`), and `/v1` + `/health` are proxied to the gateway here, where the token is read
 * from disk and attached — but **only for a request the browser itself marks same-origin**. `sec-fetch-site`
 * is set by the browser and cannot be forged by a cross-site page, so a page on another origin reaching this
 * server does not get the token, exactly as in development.
 *
 * The gateway address is therefore no longer a value to assemble by hand: the launcher (`main.mjs`) names the
 * dashboard origin on the gateway's CORS allowlist, this server forwards to `OMNIHILBRAS_GATEWAY_PORT`, and
 * `--gateway-port` and `--port` are honoured because the proxy and the browser's own origin both follow them.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Clean URLs the build emits. `/dashboard/*` is handled separately as the SPA. */
const CLEAN_ROUTES = {
  '/': 'index.html',
  '/home': 'index.html',
  '/home/': 'index.html',
  '/download': 'site/download.html',
  '/download/': 'site/download.html',
  '/docs': 'site/docs.html',
  '/about': 'site/about.html',
  '/pricing': 'site/pricing.html',
  '/changelog': 'site/changelog.html',
  '/security': 'site/security.html',
  '/privacy': 'site/privacy.html',
};

/**
 * Where the running gateway publishes the token the dashboard must present.
 *
 * The path is re-derived here, not imported from `Kernel/API`, because this file ships **standalone** inside
 * the published CLI: `build-cli-server.mjs` copies it verbatim into `cli/server/`, and no unbundled workspace
 * source is installed alongside it. The drift this invites — this reader and the gateway's writer disagreeing
 * about one filename — is exactly what a dashboard 401 that "reload" cannot fix looks like, so
 * `tests/cli-dashboard-proxy.test.js` starts a real gateway that publishes the token through the gateway's own
 * writer and reads it back through this function, and fails if the two ever stop pointing at one file.
 */
const DASHBOARD_TOKEN_FILE = 'dashboard-token';
const maxTokenBytes = 256;

export function dashboardTokenPath(env = process.env, port = 20138) {
  const configHome = env.XDG_CONFIG_HOME?.trim();
  const name = port === 20138 ? DASHBOARD_TOKEN_FILE : `${DASHBOARD_TOKEN_FILE}-${port}`;
  return path.join(configHome || path.join(os.homedir(), '.config'), 'omnihilbras', name);
}

/** The token the running gateway accepts, read fresh each request so a restarted gateway is picked up. */
function readDashboardToken(env, port) {
  try {
    const value = fs.readFileSync(dashboardTokenPath(env, port), 'utf8').trim();
    return value ? value.slice(0, maxTokenBytes) : undefined;
  } catch {
    return undefined;
  }
}

function resolveFile(dashboardRoot, pathname) {
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) return 'dashboard.html';
  const clean = CLEAN_ROUTES[pathname];
  if (clean) return clean;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  // Normalise before joining, then require the result to stay under the dashboard root. A path that
  // escapes is a 404, not a file read.
  const relative = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^[/\\]+/, '');
  const file = path.join(dashboardRoot, relative);
  if (!file.startsWith(`${dashboardRoot}${path.sep}`)) return undefined;
  try {
    return fs.statSync(file).isFile() ? relative : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The shell gets the gateway address for this launch by pointing the page at its **own origin**, so every
 * management call is same-origin and reaches the proxy below. Hashed assets carry no such script.
 */
function readBody(file) {
  const body = fs.readFileSync(file);
  if (!file.endsWith('.html')) return body;
  const text = body.toString('utf8');
  const injected = '<script>globalThis.__OMNIHILBRAS_GATEWAY_URL__=window.location.origin;</script>';
  return Buffer.from(text.includes('</head>') ? text.replace('</head>', `${injected}</head>`) : `${injected}${text}`, 'utf8');
}

/**
 * Forwards one management call to the gateway, presenting the dashboard token only when the browser says the
 * request came from this very page. Mirrors the dev proxy in `vite.config.ts` and the reason it exists.
 */
function proxyToGateway(request, response, { gatewayHost, gatewayPort, env }) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    // Drop the framing that belongs to this hop, and any origin/token the caller sent — the gateway's trust
    // is decided here, never passed through from whoever asked.
    if (typeof value !== 'string') continue;
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'origin' || lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding' || lower === 'x-omnihilbras-dashboard-token') continue;
    headers[name] = value;
  }
  headers.host = `${gatewayHost}:${gatewayPort}`;
  if (request.headers['sec-fetch-site'] === 'same-origin') {
    const token = readDashboardToken(env, gatewayPort);
    if (token) {
      headers.origin = `http://${request.headers.host ?? 'localhost'}`;
      headers['x-omnihilbras-dashboard-token'] = token;
    }
  }

  const upstream = http.request(
    { host: gatewayHost, port: gatewayPort, path: request.url, method: request.method, headers },
    (upstreamResponse) => {
      const forwarded = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        const lower = name.toLowerCase();
        if (lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding') continue;
        if (value !== undefined) forwarded[name] = value;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, forwarded);
      upstreamResponse.pipe(response);
    },
  );

  // The gateway can be restarted with a request or the log stream open. An errored socket must end this one
  // response, not take the whole server down with it (the dev proxy records the same lesson).
  upstream.on('error', () => {
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'GATEWAY_UNREACHABLE', message: 'The local gateway did not answer. Start it again with `omnihilbras`.' } }));
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
}

/**
 * Builds the dashboard server. Returned un-listening so it can be driven from a test; the published launcher
 * runs this file directly, which is when it binds the port.
 */
export function createDashboardServer(options = {}) {
  const env = options.env ?? process.env;
  const dashboardRoot = options.dashboardRoot ?? path.join(HERE, 'dashboard');
  const port = options.port ?? Number(env.OMNIHILBRAS_DASHBOARD_PORT || 20137);
  const host = options.host ?? env.OMNIHILBRAS_DASHBOARD_HOST ?? '127.0.0.1';
  const gatewayPort = options.gatewayPort ?? Number(env.OMNIHILBRAS_GATEWAY_PORT || 20138);
  const gatewayHost = options.gatewayHost ?? '127.0.0.1';

  const server = http.createServer((request, response) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    } catch {
      response.writeHead(400);
      response.end('Bad request.');
      return;
    }

    // The management surface is proxied for every method; everything else is a static asset.
    if (pathname.startsWith('/v1/') || pathname === '/health' || pathname === '/metrics') {
      const allowed = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
      if (!allowed.includes(request.method)) {
        response.writeHead(405, { allow: allowed.join(', ') });
        response.end('Method not allowed.');
        return;
      }
      proxyToGateway(request, response, { gatewayHost, gatewayPort, env });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end('Method not allowed.');
      return;
    }

    const relative = resolveFile(dashboardRoot, pathname);
    if (!relative) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found.');
      return;
    }

    const file = path.join(dashboardRoot, relative);
    let body;
    try {
      body = readBody(file);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found.');
      return;
    }

    const extension = path.extname(relative).toLowerCase();
    const hashedAsset = relative.startsWith(`assets${path.sep}`) || relative.startsWith('assets/');
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'content-length': body.length,
      // The HTML shell is regenerated per launch because it carries the gateway address. Hashed assets
      // never change under one name, so they can be cached forever.
      'cache-control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else response.end(body);
  });

  return { server, port, host };
}

// `main.mjs` spawns this file directly to run the shipped dashboard; imported (by a test), it only exports.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { server, port, host } = createDashboardServer();
  server.listen(port, host, () => {
    process.stdout.write(`OmniHilbras dashboard on http://${host}:${port}/dashboard\n`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
