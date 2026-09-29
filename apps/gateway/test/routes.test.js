import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { handleStatusRoute } from '../dist/routes/status.js';
import { handleConnectionsRoute } from '../dist/routes/connections.js';
import { handleOauthRoute } from '../dist/routes/oauth.js';
import { handleApiKeysRoute } from '../dist/routes/api-keys.js';
import { handleInferenceRoute } from '../dist/routes/inference.js';

/**
 * The route split's two invariants.
 *
 * `server.ts` was one 373-line `if` chain over 37 routes. It is now five modules and a five-line
 * dispatcher. "The tests still pass" is weak evidence for a move like that, because a route that
 * quietly stopped being reachable fails nothing — every existing test either still works or was
 * never exercising that path in the first place. So the structure itself is asserted here.
 */

const modules = [
  { name: 'status', handler: handleStatusRoute },
  { name: 'connections', handler: handleConnectionsRoute },
  { name: 'oauth', handler: handleOauthRoute },
  { name: 'api-keys', handler: handleApiKeysRoute },
  { name: 'inference', handler: handleInferenceRoute },
];

/** A request and response pair that records what was written, and nothing else. */
function context({ method = 'GET', path = '/', origin } = {}) {
  const request = Object.assign(new EventEmitter(), { method, url: path, headers: {} });
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
    async writeSse() { return true; },
  });
  return {
    ctx: {
      request,
      response,
      url: new URL(path, 'http://localhost'),
      // A service with no methods: if a handler touches one, the test fails loudly rather than
      // passing because the route was never actually reached.
      service: new Proxy({}, { get: (_t, prop) => { throw new Error(`the ${method} ${path} route reached service.${String(prop)}`); } }),
      options: { publicBaseUrl: 'http://127.0.0.1:8787' },
      origin,
      signal: new AbortController().signal,
      trusted: false,
    },
    written,
  };
}

test('a route module claims only its own routes', async () => {
  // The failure this guards: a mangled condition — a dropped `&&`, a moved brace — makes a handler
  // match a request it does not own. Because the dispatcher stops at the first `true`, one
  // over-eager module silently shadows every module after it, and a 404 arrives in place of a real
  // route. Nothing else in the suite would notice.
  //
  // Each probe names its owner, so the assertion is that every *other* module declines it. A
  // module claiming its own route is correct; a module claiming a stranger's is the bug.
  const probes = [
    { method: 'GET', path: '/v1/connections', owner: 'connections' },
    { method: 'POST', path: '/v1/oauth/cline/start', owner: 'oauth' },
    { method: 'GET', path: '/v1/keys', owner: 'api-keys' },
    { method: 'GET', path: '/v1/models', owner: 'inference' },
    { method: 'GET', path: '/health', owner: 'status' },
    { method: 'GET', path: '/v1/routing', owner: 'status' },
    { method: 'DELETE', path: '/v1/connections/anything', owner: 'connections' },
    { method: 'PATCH', path: '/v1/keys/anything', owner: 'api-keys' },
  ];
  for (const { name, handler } of modules) {
    for (const probe of probes) {
      if (probe.owner === name) continue;
      const { ctx } = context(probe);
      assert.equal(await handler(ctx), false, `${name} claimed ${probe.method} ${probe.path}, which belongs to ${probe.owner}`);
    }
  }
});

test('an unroutable request is declined by every module, so the 404 is reachable', async () => {
  // The other half of the invariant: nothing may claim a path nobody owns. If a module did, the
  // 404 at the end of the dispatcher would be dead code and an unroutable request would get a
  // module's error shape instead of `NOT_FOUND`.
  for (const probe of [{ method: 'GET', path: '/not/a/route' }, { method: 'POST', path: '/v1/nope' }, { method: 'PATCH', path: '/v1/connections' }]) {
    for (const { name, handler } of modules) {
      const { ctx } = context(probe);
      assert.equal(await handler(ctx), false, `${name} claimed the unroutable ${probe.method} ${probe.path}`);
    }
  }
});

test('the dispatcher tries every route module, in the order the old chain used', () => {
  // Order is load-bearing: the connection routes match on `startsWith('/v1/connections/')`, so the
  // specific `/check` and `/models/refresh` branches are only reached because they come first, and
  // `inference` is last because it carries the authentication gate.
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const list = source.match(/const routes = \[([\s\S]*?)\];/);
  assert.ok(list, 'the dispatcher must declare its route order in one readable list');
  const order = [...list[1].matchAll(/handle(\w+?)Route,?\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(order, ['Status', 'Connections', 'Oauth', 'ApiKeys', 'Inference']);
  // Every module that exists must actually be wired in: a module with routes but no entry here is
  // a module whose routes 404, which no unit test would catch.
  for (const { name } of modules) {
    const handlerName = 'handle' + name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('') + 'Route';
    assert.ok(list[1].includes(handlerName), `${name}.ts is not in the dispatcher's route list`);
  }
});

test('a 404 is only reachable after every module has declined', () => {
  // `handleRequest` ends in a 404, and that is the right place for it: it can only run once all
  // five handlers returned false. Asserting the order is what makes the 404 trustworthy.
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const chain = source.match(/for \(const route of routes\) \{\s*if \(await route\(ctx\)\) return;\s*\}\s*\n\s*sendJson\(response, 404/);
  assert.ok(chain, 'the 404 must follow the loop that tries every route');
});
