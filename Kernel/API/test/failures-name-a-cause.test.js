import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';

/**
 * A cause must survive to the operator.
 *
 * Three separate bugs in one session, one root cause each, and every one of them cost a full
 * diagnosis cycle because the reason never arrived:
 *
 * | What the user saw | What had happened |
 * | --- | --- |
 * | "the gateway encountered an unexpected error" | a configuration refusal thrown as a plain `Error`, which `toErrorEnvelope` replaces |
 * | a sign-in that failed for no stated reason | a bare `catch {}` that discarded the exception |
 * | a refusal with no detail | a provider's nested error object typed away, so the reason was dropped |
 *
 * The third is the dangerous one: it type-checked perfectly and lost the message at runtime. The
 * first two are ordinary mistakes any `Error` throws somewhere in the gateway — which is why this is
 * written as behaviour rather than as a ban on `throw new Error`. Much of the gateway throws a plain
 * `Error` legitimately (a filesystem guard, a startup-time config refusal), and a lint rule banning it
 * would push people to wrap the wrong throws and teach them nothing.
 *
 * What is asserted is the only property an operator can observe: **a failure the user caused arrives
 * with a cause, not a shrug.**
 */

const GENERIC = /unexpected error/i;

async function startServer(t) {
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('probe')).key;
  const service = new GatewayService(
    new ProviderRegistry(),
    new InMemorySecretStore({}),
    new InMemoryConnectionStore(),
    apiKeys,
    { config: { codex: {} } },
  );
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // `service.close()` matters and is not decoration: a Codex sign-in opens the loopback port its
  // registered redirect points at, and leaving that listener open keeps the event loop alive — which
  // hangs `node --test` at the end of the run rather than failing a test. It cost this file's first
  // version a 200-second timeout to find out.
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await service.close();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, key };
}

const CASES = [
  {
    label: 'a sign-in session id that is not a plausible one',
    run: ({ base, key }) => fetch(`${base}/v1/oauth/codex/session/x`, { headers: { authorization: `Bearer ${key}` } }),
  },
  {
    label: 'a quota read for a connection that does not exist',
    run: ({ base, key }) => fetch(`${base}/v1/connections/no-such/quota`, { headers: { authorization: `Bearer ${key}` } }),
  },
  {
    label: 'a credential check for a provider with no adapter',
    run: ({ base, key }) => fetch(`${base}/v1/connections/no-such-provider/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ apiKey: 'k' }),
    }),
  },
  {
    label: 'a save for a provider with no adapter',
    run: ({ base, key }) => fetch(`${base}/v1/connections/no-such-provider`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ credential: 'none' }),
    }),
  },
  {
    label: 'a body that is not JSON on a route that reads one',
    run: ({ base, key }) => fetch(`${base}/v1/oauth/cline/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: '{not json',
    }),
  },
  {
    label: 'an unknown field in a body a route reads',
    run: ({ base, key }) => fetch(`${base}/v1/oauth/cline/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ redirectUri: 'http://127.0.0.1:8787/cb', surprise: true }),
    }),
  },
  {
    label: 'an unauthenticated management read',
    run: ({ base }) => fetch(`${base}/v1/connections`, { headers: { accept: 'application/json' } }),
  },
];

for (const { label, run } of CASES) {
  test(`${label} answers with a cause rather than a shrug`, async (t) => {
    const context = await startServer(t);
    const response = await run(context);
    const raw = await response.text();
    assert.ok(raw.trim(), 'the gateway answered with no body at all');
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      // A non-JSON body breaks the promise this file makes: an operator sees prose, not a reason.
      assert.fail(`${label}: answered ${response.status} with a body that is not JSON: ${raw.slice(0, 160)}`);
    }
    assert.notEqual(body.error?.code, 'INTERNAL_ERROR', `${label} arrived as INTERNAL_ERROR`);
    assert.doesNotMatch(body.error?.message ?? '', GENERIC, `${label} arrived as the generic sentence`);
    // "Something went wrong" is only an improvement over INTERNAL_ERROR if it says *what*.
    assert.ok((body.error?.message ?? '').length > 10, `${label} gave a message too short to act on: ${body.error?.message}`);
  });
}

test('the generic sentence is reserved for faults that are genuinely unknown', () => {
  // Read from source because the property is about a fallback, which no single response can show.
  // The fallback has to exist — a fault carrying no `ProviderError` still needs an envelope — but
  // all three bugs above were ways of *reaching* it that should not have existed.
  const http = readFileSync(new URL('../src/core/http.ts', import.meta.url), 'utf8');
  assert.match(http, /INTERNAL_ERROR/, 'the fallback is gone, so an unknown fault has no envelope at all');
  assert.match(http, /export function toErrorEnvelope/, 'the envelope builder was renamed or removed');
});

test('every route that reads a body refuses unknown fields rather than ignoring them', async (t) => {
  // Found while writing this file: `POST /v1/oauth/codex/start` accepts any body at all, because it
  // reads none. That is defensible for a route with no input, but it means a client sending a
  // misspelled field is told nothing — and the routes that *do* read a body must be strict, or the
  // same mistake is silent everywhere else.
  const { base, key } = await startServer(t);
  const strict = await fetch(`${base}/v1/oauth/cline/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ redirectUri: 'http://127.0.0.1:8787/cb', surprise: true }),
  });
  assert.equal(strict.status, 400, 'a route that reads a body accepted an unknown field');
});