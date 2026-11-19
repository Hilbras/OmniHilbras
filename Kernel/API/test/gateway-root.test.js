import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { handleStatusRoute } from '../dist/src/routes/status.js';

/**
 * `GET /` on the gateway port.
 *
 * The launcher's startup box prints the gateway URL one line under the dashboard URL, so a person who
 * types the gateway one used to read `404 {"code":"NOT_FOUND"}` and conclude the server was broken. An
 * API having no index page is correct; making the URL we advertise a dead end is not.
 *
 * The three cases are the whole contract: a launched gateway redirects a browser to its dashboard, a
 * gateway with no dashboard to point at says what it is instead of guessing a port, and a non-browser
 * caller (`curl`, a health probe) always gets JSON rather than an HTML page it cannot read.
 */

/** A request/response pair that records what was written, and nothing else. */
function context({ method = 'GET', path = '/', accept, dashboardUrl } = {}) {
  const request = Object.assign(new EventEmitter(), {
    method,
    url: path,
    headers: accept ? { accept } : {},
  });
  const written = [];
  const response = Object.assign(new EventEmitter(), {
    statusCode: 0,
    writableEnded: true,
    headers: {},
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    getHeader(key) { return this.headers[key.toLowerCase()]; },
    removeHeader(key) { delete this.headers[key.toLowerCase()]; },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers ?? {}); return this; },
    write() { return true; },
    end(body) { if (body !== undefined) written.push(String(body)); this.writableEnded = true; },
  });
  return {
    ctx: {
      request,
      response,
      url: new URL(path, 'http://localhost'),
      // `/` must not touch the service: it is a redirect or an index, never a health probe.
      service: new Proxy({}, { get: (_target, property) => { throw new Error(`GET ${path} reached service.${String(property)}`); } }),
      options: dashboardUrl ? { dashboardUrl } : {},
      origin: undefined,
      signal: new AbortController().signal,
      auth: { kind: 'system', tenant: 'local' },
    },
    response,
    written,
  };
}

test('GET / on a launched gateway redirects a browser to the dashboard', async () => {
  const { ctx, response, written } = context({
    accept: 'text/html,application/xhtml+xml',
    dashboardUrl: 'http://localhost:20137/dashboard',
  });

  assert.equal(await handleStatusRoute(ctx), true, 'the root is claimed by the status route');
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, 'http://localhost:20137/dashboard');
  assert.equal(response.headers['cache-control'], 'no-store', 'a redirect whose target can change is not cached');
  assert.deepEqual(written, [], 'a redirect carries no body');
});

test('GET / with no dashboard configured answers JSON, not a guessed port', async () => {
  // A container or desktop gateway starts no dashboard. Redirecting to a guessed :20137 would send the
  // browser to nothing listening — a 404 one step removed from the one this route exists to remove.
  const { ctx, response, written } = context();
  assert.equal(await handleStatusRoute(ctx), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers.location, undefined, 'nothing was configured to redirect to');

  const body = JSON.parse(written.join(''));
  assert.equal(body.service, 'omnihilbras-gateway');
  assert.equal(typeof body.build.version, 'string');
  assert.equal(body.endpoints.health, '/health');
  assert.equal(body.endpoints.models, '/v1/models');
});

test('GET / for a non-browser caller is JSON even when a dashboard exists', async () => {
  // `curl http://127.0.0.1:20138/` is how an operator asks "what is this port", and it is also what a
  // container health probe does. A 302 to the dashboard would hand both an empty body and no answer,
  // so a JSON caller is told what this is and *where* the dashboard is, as data.
  const { ctx, response, written } = context({ dashboardUrl: 'http://localhost:20137/dashboard' });
  assert.equal(await handleStatusRoute(ctx), true);
  assert.equal(response.statusCode, 200, 'a non-browser caller is not redirected');
  assert.equal(response.headers.location, undefined);

  const body = JSON.parse(written.join(''));
  assert.equal(body.service, 'omnihilbras-gateway');
  assert.equal(body.dashboard, 'http://localhost:20137/dashboard', 'the dashboard is named, not hidden');
});

test('GET / for a non-browser caller with no dashboard reports no dashboard', async () => {
  // Absent rather than null or a guessed port: a container gateway answers what it can actually say.
  const { ctx, written } = context();
  assert.equal(await handleStatusRoute(ctx), true);
  assert.equal(JSON.parse(written.join('')).dashboard, undefined);
});

test('GET / for a browser with no dashboard answers a page that says what this port is', async () => {
  const { ctx, response, written } = context({ accept: 'text/html' });
  assert.equal(await handleStatusRoute(ctx), true);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
  // The page describes the port it is on and names the command that starts a dashboard. It does not
  // link to one: there is nothing at a made-up port.
  assert.match(written.join(''), /gateway is running/i);
  assert.match(written.join(''), /omnihilbras/, 'the command that starts the dashboard is named');
});

test('HEAD / follows the same decision as GET / and writes no body', async () => {
  // Browsers and proxies send HEAD to check a URL before following it; the answer has to match what a
  // GET would do, or a link checker reports a different status than the page returns.
  const { ctx, response, written } = context({
    method: 'HEAD',
    accept: 'text/html',
    dashboardUrl: 'http://localhost:20137/dashboard',
  });
  assert.equal(await handleStatusRoute(ctx), true);
  assert.equal(response.statusCode, 302);
  assert.deepEqual(written, []);
});

test('the root is only the root, and a deeper path is still declined', async () => {
  // The guard exists because a `startsWith('/')` in its place would claim every unroutable request and
  // turn a real 404 into a redirect to the dashboard, which is the kind of "it works now" that hides a
  // wrong URL.
  for (const path of ['/v1', '/dashboard', '/not/a/route', '/healthz']) {
    const { ctx } = context({ path, dashboardUrl: 'http://localhost:20137/dashboard' });
    assert.equal(await handleStatusRoute(ctx), false, `${path} must not be claimed by the root route`);
  }
});
