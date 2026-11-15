import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { ProviderResolver } from '../dist/src/core/provider-resolver.js';
import { providerClientHeaders } from '../dist/src/core/provider-client-identity.js';

/**
 * The client identity AgentRouter gates on, and the rule that keeps it to one provider.
 *
 * The relay refuses `curl/8.5.0`, `node` and an `OmniHilbras/1.0` `User-Agent` with
 * `401 unauthorized client detected` **before it reads the key** — a valid key, a bogus one and no key
 * all produce that byte-identical body, which is why saving an AgentRouter connection reported
 * "Provider authentication failed. UNAUTHENTICATED" whatever was pasted in. Measured 2026-11-16 against
 * `GET https://agentrouter.org/v1/models`: the fingerprints their allowlist accepts
 * (`claude-cli/...`, `codex_cli_rs/...`, `Cline/...`, `opencode/...`) all reach the token check instead,
 * and `x-app: cli` on its own changes nothing.
 *
 * So the gateway sends one of those fingerprints — for this provider only. These tests are behavioural:
 * they build the adapter through `ProviderResolver`, the way a request does, and read the headers off the
 * transport. The last one puts them on a real socket, because a header that Node's fetch strips on the
 * way out would pass every assertion above and still fix nothing.
 */

const IDENTITY = { userAgent: 'claude-cli/2.1.296 (external, cli)', xApp: 'cli' };
const CREDENTIAL = { type: 'api-key', value: 'sk-bogus-not-a-key' };

/** A transport that records the request instead of sending it. */
function capturingTransport() {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      return request.method === 'GET'
        ? { status: 200, headers: new Headers(), data: { data: [{ id: 'gpt-5', owned_by: 'agentrouter' }] } }
        : { status: 200, headers: new Headers(), data: { id: 'response-1', model: 'gpt-5', created: 1, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } };
    },
    async *stream(request) {
      calls.push(request);
      yield 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n';
      yield 'data: [DONE]\n\n';
    },
  };
}

const lowercased = (headers) => Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));

const chatRequest = { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] };

test('the adapter built for agentrouter sends the identity their relay gates on', async () => {
  // The path a real request takes: a saved connection with an endpoint and no dedicated adapter, so
  // `resolve` synthesises the generic OpenAI-compatible one.
  const transport = capturingTransport();
  const resolver = new ProviderResolver(new ProviderRegistry(), transport);
  const adapter = await resolver.resolve('agentrouter', { endpoint: 'https://agentrouter.org/v1', name: 'AgentRouter' }, async () => []);
  assert.equal(adapter.id, 'agentrouter');

  await adapter.chat(chatRequest, { credential: CREDENTIAL });

  assert.equal(transport.calls.length, 1);
  const headers = lowercased(transport.calls[0].headers);
  assert.equal(headers['user-agent'], IDENTITY.userAgent);
  assert.equal(headers['x-app'], IDENTITY.xApp);
  // The key is still sent as itself: the identity opens the gate, it does not replace the credential. If
  // it ever did, every request would look authenticated and no test would notice.
  assert.equal(headers.authorization, `Bearer ${CREDENTIAL.value}`);
});

test('the health path builds the same identity as the request path', async () => {
  // `active()` constructs its own adapter at a second site, and the model-list probe is what a health
  // check calls. Wired at one site only, the connection would look refused while chat worked.
  const transport = capturingTransport();
  const resolver = new ProviderResolver(new ProviderRegistry(), transport);
  const adapters = await resolver.active([
    { id: 'connection-1', providerId: 'agentrouter', hasCredential: true, endpoint: 'https://agentrouter.org/v1', name: 'AgentRouter' },
  ]);
  assert.equal(adapters.length, 1);

  await adapters[0].listModels({ credential: CREDENTIAL });

  const headers = lowercased(transport.calls[0].headers);
  assert.equal(transport.calls[0].method, 'GET');
  assert.equal(headers['user-agent'], IDENTITY.userAgent);
  assert.equal(headers['x-app'], IDENTITY.xApp);
});

test('a provider that is not in the table gets no User-Agent from this mechanism', async () => {
  // The rule that matters more than the fix. The identity sent is another vendor's client, so rewriting
  // the header for every provider would misattribute this gateway's traffic to a tool it is not, in every
  // other vendor's logs and rate-limit attribution. A provider that is not in the table keeps the
  // transport's own identity and carries no header from this module.
  const transport = capturingTransport();
  const resolver = new ProviderResolver(new ProviderRegistry(), transport);
  const adapter = await resolver.resolve('my-endpoint', { endpoint: 'https://example.invalid/v1', name: 'Mine' }, async () => []);

  await adapter.chat(chatRequest, { credential: CREDENTIAL });

  const headers = lowercased(transport.calls[0].headers);
  assert.equal('user-agent' in headers, false, 'the adapter must not carry a User-Agent of its own');
  assert.equal('x-app' in headers, false);
});

test('no SDK provider inherits the identity by accident', () => {
  // Generalised the way `documentation-counts.test.js` generalises its own rule: the vocabulary is the
  // SDK's own provider directories, so a provider added later extends this check without an edit. One id
  // in the table, and it is not an SDK package.
  const sdkProviders = readdirSync(new URL('../../SDK/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(sdkProviders.length > 10, `the SDK listing looks wrong; only ${sdkProviders.length} directories`);

  const offenders = sdkProviders.filter((id) => providerClientHeaders(id, {}) !== undefined);
  assert.deepEqual(offenders, [], `these providers would send another vendor's User-Agent: ${offenders.join(', ')}`);
  // An id is matched as it is written, so a differently-cased id is a different provider and gets nothing.
  assert.equal(providerClientHeaders('AgentRouter', {}), undefined, 'provider ids are lower-case');
});

test('the environment override replaces the User-Agent and leaves the rest alone', async () => {
  // The allowlist moves, and this is the way out when it does. Overridable rather than hard-coded, and
  // overridable *per value* rather than per provider, so the escape hatch cannot become a second way to
  // send a false identity somewhere else.
  const headers = providerClientHeaders('agentrouter', { OMNIHILBRAS_AGENTROUTER_USER_AGENT: 'Cline/3.5.54' });
  assert.equal(headers['User-Agent'], 'Cline/3.5.54');
  assert.equal(headers['x-app'], 'cli');
  // A variable exported as an empty string is unset, not an empty `User-Agent`.
  assert.equal(providerClientHeaders('agentrouter', { OMNIHILBRAS_AGENTROUTER_USER_AGENT: '  ' })['User-Agent'], IDENTITY.userAgent);

  // And the live path reads it: the resolver is built with the process environment, so the override has
  // to travel that far or the documented escape hatch does nothing.
  const previous = process.env.OMNIHILBRAS_AGENTROUTER_USER_AGENT;
  process.env.OMNIHILBRAS_AGENTROUTER_USER_AGENT = 'codex_cli_rs/0.159.2 (Mac OS 26.6.0; arm64)';
  try {
    const transport = capturingTransport();
    const resolver = new ProviderResolver(new ProviderRegistry(), transport);
    const adapter = await resolver.resolve('agentrouter', { endpoint: 'https://agentrouter.org/v1', name: 'AgentRouter' }, async () => []);
    await adapter.chat(chatRequest, { credential: CREDENTIAL });
    assert.equal(lowercased(transport.calls[0].headers)['user-agent'], 'codex_cli_rs/0.159.2 (Mac OS 26.6.0; arm64)');
  } finally {
    if (previous === undefined) delete process.env.OMNIHILBRAS_AGENTROUTER_USER_AGENT;
    else process.env.OMNIHILBRAS_AGENTROUTER_USER_AGENT = previous;
  }
});

test('the identity survives the real transport, because fetch could strip it on the way out', async (t) => {
  // A fake transport records whatever it is handed, so every assertion above would still pass if Node's
  // fetch dropped the header — which is what a forbidden request header looks like from the inside. This
  // is the one test that reads the header off the wire, on a loopback socket the test owns.
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'response-1', model: 'gpt-5', created: 1, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const resolver = new ProviderResolver(new ProviderRegistry());
  const adapter = await resolver.resolve('agentrouter', { endpoint: `http://127.0.0.1:${server.address().port}/v1`, name: 'AgentRouter' }, async () => []);
  await adapter.chat(chatRequest, { credential: CREDENTIAL });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/v1/chat/completions');
  // Node's HTTP server lower-cases incoming header names; the values are the identity verbatim.
  assert.equal(seen[0].headers['user-agent'], IDENTITY.userAgent);
  assert.equal(seen[0].headers['x-app'], IDENTITY.xApp);
});
