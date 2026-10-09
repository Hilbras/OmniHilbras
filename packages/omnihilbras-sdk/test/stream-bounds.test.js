import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { FetchHttpTransport } from '../dist/core/transport.js';

// The idle timeout and the maximum stream duration are two bounds, and between them they are the only
// thing standing between a provider that stalls and a gateway that hangs. Phase 3 of the stabilization
// roadmap recorded this as "already implemented" — which it was, in `createRequestLifecycle`, and which
// **no test covered**. An inherited claim is the kind most likely to rot silently, because nothing fails
// when it does.
//
// Every measurement below was taken against a real HTTP server that emits exactly the pattern named, and
// the timings were confirmed before being asserted.
//
// Two probe errors are recorded in the file's history and both were mine, not the code's:
//
//  1. `new HttpTransport(...)` — `HttpTransport` is an *interface*; the class is `FetchHttpTransport`.
//  2. `{ idleTimeoutMs: 400 }` — the option is `streamIdleTimeoutMs`. An unknown option is silently
//     ignored, so the probe fell back to the 30 s default and reported a 30-second timeout as though the
//     400 ms budget had been ignored too. That is the shape of bug this file now guards against: a
//     misspelled option looks exactly like a broken mechanism.

/** A server whose behaviour is described by the test that starts it. */
async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  return { url, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

/** Drain a stream, reporting what happened rather than throwing. */
async function drain(transport, url) {
  const chunks = [];
  let outcome = 'completed';
  try {
    for await (const _ of transport.stream({ url, method: 'POST', headers: {}, body: '{}' })) chunks.push(1);
  } catch (error) {
    outcome = error.code ?? error.name;
  }
  return { count: chunks.length, outcome };
}

test('a stream that stalls forever is ended at the idle budget', async (t) => {
  // One chunk, then silence — no end, no more data. This is the failure the bound exists for.
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    // deliberately never ends
  });
  t.after(server.close);

  const started = Date.now();
  const result = await drain(new FetchHttpTransport({ fetch: globalThis.fetch, streamIdleTimeoutMs: 400 }), server.url);
  const elapsed = Date.now() - started;

  assert.equal(result.count, 1, 'the chunk that did arrive should still have been delivered');
  assert.equal(result.outcome, 'PROVIDER_TIMEOUT', `a stalled stream ended as ${result.outcome}`);
  // 400ms budget, with room for the socket setup. Before the fix's companion test existed this was
  // measured at 30 s because the option name in the probe was wrong.
  assert.ok(elapsed >= 350, `gave up after ${elapsed}ms, sooner than the 400ms budget`);
  assert.ok(elapsed < 5_000, `gave up after ${elapsed}ms; the idle budget is not being applied`);
});

test('the idle budget is measured between chunks, not across the whole stream', async (t) => {
  // The half that matters most and is easiest to get backwards: a *healthy* stream must never be cut
  // short. Eight chunks 150ms apart against a 400ms budget — every gap is inside the budget, so the
  // timer must be reset on each chunk and the stream must run to completion.
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sent = 0;
    const timer = setInterval(() => {
      res.write(`data: ${sent++}\n\n`);
      if (sent >= 8) { clearInterval(timer); res.end(); }
    }, 150);
    res.on('close', () => clearInterval(timer));
  });
  t.after(server.close);

  const result = await drain(new FetchHttpTransport({ fetch: globalThis.fetch, streamIdleTimeoutMs: 400 }), server.url);
  assert.equal(result.outcome, 'completed', `a healthy stream was cut short: ${result.outcome}`);
  assert.equal(result.count, 8, 'every chunk should have been delivered');
});

test('a stream that is never idle is bounded by the maximum duration instead', async (t) => {
  // A chunk every 50ms never trips the idle timer, so without a duration cap the connection is held
  // open indefinitely. This is the case the idle timeout *cannot* solve, which is why the second bound
  // exists and why both are tested.
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const timer = setInterval(() => res.write('data: x\n\n'), 50);
    res.on('close', () => clearInterval(timer));
  });
  t.after(server.close);

  const started = Date.now();
  const result = await drain(
    new FetchHttpTransport({ fetch: globalThis.fetch, streamIdleTimeoutMs: 500, maxStreamDurationMs: 600 }),
    server.url,
  );
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, 'PROVIDER_TIMEOUT', `a never-idle stream ended as ${result.outcome}`);
  assert.ok(elapsed < 5_000, `the duration cap did not apply: ${elapsed}ms`);
});

test('the duration cap works with the idle timer disabled', async (t) => {
  // Independent bounds, not one mechanism with two settings. Measured: with `streamIdleTimeoutMs: 0` the
  // duration cap still ends a never-idle stream.
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const timer = setInterval(() => res.write('data: x\n\n'), 50);
    res.on('close', () => clearInterval(timer));
  });
  t.after(server.close);

  const started = Date.now();
  const result = await drain(
    new FetchHttpTransport({ fetch: globalThis.fetch, streamIdleTimeoutMs: 0, maxStreamDurationMs: 400 }),
    server.url,
  );
  assert.equal(result.outcome, 'PROVIDER_TIMEOUT');
  assert.ok(Date.now() - started < 5_000, 'the duration cap must work on its own');
});

test('a typo in the option name is not silently ignored into a 30-second hang', async (t) => {
  // The reason this file exists in the shape it does. `idleTimeoutMs` is not the option; it is
  // `streamIdleTimeoutMs`, and an unknown property in an options object is silently dropped — so a probe
  // written against the wrong name gets the 30 s default and looks like the mechanism is broken.
  //
  // This asserts the *converse*: a stream that stalls under a real budget must not take anywhere near
  // the default. If someone renames the option, this fails rather than every future probe quietly
  // hanging for 30 seconds.
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: x\n\n');
  });
  t.after(server.close);

  const started = Date.now();
  await drain(new FetchHttpTransport({ fetch: globalThis.fetch, streamIdleTimeoutMs: 300 }), server.url);
  assert.ok(Date.now() - started < 10_000, 'the default 30s timeout was used, so the option name has changed');
});

test('the bounds are named in the published types, so they cannot be renamed silently', () => {
  // A test that renames these options should fail here first, rather than in every probe that ever
  // measures a stall. Read from the **source**, not the build: this is about the contract being
  // documented where a reader looks for it.
  const source = readFileSync(new URL('../src/core/transport.ts', import.meta.url), 'utf8');
  const options = source.slice(source.indexOf('FetchHttpTransportOptions'), source.indexOf('export class FetchHttpTransport'));
  assert.ok(options.includes('streamIdleTimeoutMs'), 'streamIdleTimeoutMs must be a declared option');
  assert.ok(options.includes('maxStreamDurationMs'), 'maxStreamDurationMs must be a declared option');
  assert.ok(options.includes('maxStreamBytes'), 'the stream size cap must remain alongside the two time bounds');

  // And neither may default to unbounded. A `?? 0` here would mean "never expire", which is the one
  // default that turns a slow provider into a stuck gateway.
  const constructor = source.slice(source.indexOf('constructor(options: FetchHttpTransportOptions'));
  assert.match(constructor, /streamIdleTimeoutMs = options\.streamIdleTimeoutMs \?\? options\.timeoutMs \?\? defaultTimeoutMs/,
    'the idle budget must fall back to the request timeout, never to zero');
  assert.match(constructor, /maxStreamDurationMs = options\.maxStreamDurationMs \?\? defaultMaxStreamDurationMs/,
    'the duration cap must have a default');
});

test('the DEFAULTS bound a stall, because every real caller omits the options', async (t) => {
  // Every other test here passes an explicit budget — which means a broken *default* would leave them all
  // green. Mutation-tested: setting the idle default to `0` failed only the source-shape assertion while
  // all five behavioural tests passed. And the default is what production uses, because the gateway
  // constructs the transport without `streamIdleTimeoutMs`.
  //
  // The default is 30 s, so this takes half a minute by design. It is the only test in the file that
  // does, and the reason is that the alternative is asserting the shape of a default rather than its
  // effect.
  const server = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: x\n\n');
    // never ends
  });
  t.after(server.close);

  const started = Date.now();
  const result = await drain(new FetchHttpTransport({ fetch: globalThis.fetch }), server.url);
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, 'PROVIDER_TIMEOUT', `a stalled stream under the defaults ended as ${result.outcome}`);
  assert.ok(elapsed < 90_000, `the default bound never fired: ${elapsed}ms`);
  assert.ok(elapsed >= 1_000, `gave up after ${elapsed}ms, which is not a per-minute request budget`);
});
