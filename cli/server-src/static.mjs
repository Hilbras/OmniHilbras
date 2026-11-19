/**
 * The dashboard's static server for the bundled CLI.
 *
 * The Vite dev server does three things for the dashboard: serve `dist/`, rewrite `/dashboard/*` to
 * the SPA shell, and forward `/v1` to the gateway. A published install has no Vite, so this replaces
 * the first two. The third is not needed: a production build calls the gateway directly at
 * `127.0.0.1:<gateway port>`, and the gateway's CORS allowlist names the dashboard origin.
 *
 * The gateway URL is injected into the shell as `globalThis.__OMNIHILBRAS_GATEWAY_URL__`, which the
 * client already consults before its compiled default. Without it, `--gateway-port` would move the
 * gateway while the page kept calling 20138.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.join(here, 'dashboard');
const port = Number(process.env.OMNIHILBRAS_DASHBOARD_PORT || 20137);
const host = process.env.OMNIHILBRAS_DASHBOARD_HOST || '127.0.0.1';
const gatewayPort = Number(process.env.OMNIHILBRAS_GATEWAY_PORT || 20138);
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

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

function resolveFile(pathname) {
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

/** The shell gets the gateway URL for this launch; every other asset is served verbatim. */
function readBody(file) {
  const body = fs.readFileSync(file);
  if (!file.endsWith('.html')) return body;
  const text = body.toString('utf8');
  const injected = `<script>globalThis.__OMNIHILBRAS_GATEWAY_URL__=${JSON.stringify(gatewayUrl)};</script>`;
  return Buffer.from(text.includes('</head>') ? text.replace('</head>', `${injected}</head>`) : `${injected}${text}`, 'utf8');
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' });
    response.end('Method not allowed.');
    return;
  }

  let pathname = '/';
  try {
    pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
  } catch {
    response.writeHead(400);
    response.end('Bad request.');
    return;
  }

  const relative = resolveFile(pathname);
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
    // The HTML shell is regenerated per launch because it carries the gateway URL. Hashed assets
    // never change under one name, so they can be cached forever.
    'cache-control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (request.method === 'HEAD') response.end();
  else response.end(body);
});

server.listen(port, host, () => {
  process.stdout.write(`OmniHilbras dashboard on http://${host}:${port}/dashboard\n`);
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
