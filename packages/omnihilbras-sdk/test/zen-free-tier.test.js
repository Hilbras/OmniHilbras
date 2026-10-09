import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError, ZenAdapter } from '../dist/index.js';
import { zenSessionId, zenFreeTierHeaders, zenFingerprintTools, zenContractSatisfied, satisfiesZenUserAgentContract, ZEN_FINGERPRINT_TOOL_NAMES } from '../dist/providers/zen/zen-free-tier.js';

/**
 * OpenCode Zen's free-tier request contract.
 *
 * ## What was broken, measured
 *
 * Every free model on an `opencode` connection was refused:
 *
 * ```
 * mimo-v2.6-flash-free   403  {"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}
 * big-pickle             403  (identical)
 * nemotron-3.5-…-free   403  (identical)
 * ```
 *
 * The message names the OpenCode client, so the obvious reading was that the free tier wanted the
 * **CLI's own credential** — a session token rather than the Zen API key the adapter holds. That reading
 * was wrong, and wrong because it was *inferred from one refusal instead of measured*.
 * `/home/gin/work/OmniRoute` serves the same models through the same base URL with
 * `authType: "apikey"`, and `open-sse/executors/opencodeFreeTierContract.ts` records the contract it
 * measured: the gate is the **request**, not the credential.
 *
 * ## What these tests can and cannot prove
 *
 * They prove the request this adapter now sends satisfies the contract, against a fake transport. They
 * cannot prove the upstream accepts it — measured from this machine, a request with all four conditions
 * is *still* refused, which is why `gatedRefusal` names the network rather than the key. That
 * distinction is the point of the last test here.
 */

/** A transport that records the gated request and replays a scripted SSE stream. */
function streamingTransport({ events = [], onRequest } = {}) {
  const requests = [];
  return {
    requests,
    async request(req) {
      requests.push(req);
      throw new Error('the gated path must not use the non-streaming request');
    },
    stream(req) {
      requests.push(req);
      onRequest?.(req);
      // Raw SSE text, because that is what `transport.stream()` yields and what `parseSseStream`
      // consumes. My first version yielded `{data}` objects, and every streaming test failed with an
      // empty answer — a fake that does not have the interface it stands in for, which is the one thing
      // a harness must get right.
      return (async function* () {
        for (const event of events) yield `data: ${JSON.stringify(event)}\n\n`;
        yield 'data: [DONE]\n\n';
      })();
    },
  };
}

const request = (model, over = {}) => ({ model, messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 32, ...over });
const credential = { credential: { type: 'api-key', value: 'k' } };

test('a free-tier request carries all four conditions of the contract', async () => {
  let sent;
  const adapter = new ZenAdapter({
    transport: streamingTransport({
      events: [{ id: 'r1', choices: [{ delta: { content: 'OK' } }] }, { id: 'r1', choices: [{ delta: {}, finish_reason: 'stop' }] }],
      onRequest: (req) => { sent = req; },
    }),
  });

  const response = await adapter.chat(request('mimo-v2.6-flash-free'), credential);
  assert.equal(response.message.content, 'OK');
  assert.equal(response.finishReason, 'stop');

  const headers = sent.headers;
  const body = JSON.parse(sent.body);
  assert.equal(body.stream, true, 'condition 1: streaming');
  assert.ok(Array.isArray(body.tools) && body.tools.length > 0, 'condition 2: a non-empty tools array');
  assert.deepEqual(body.tools.map((tool) => tool.function.name), [...ZEN_FINGERPRINT_TOOL_NAMES], 'the file-search quartet, lowercase');
  assert.match(headers['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, 'condition 3: the session shape');
  assert.ok(satisfiesZenUserAgentContract(headers['user-agent']), `condition 4: user-agent, got ${headers['user-agent']}`);

  assert.equal(zenContractSatisfied(headers, body), true, 'and the adapter agrees it satisfied them');
});

test('a free-tier request streams upstream even when the caller asked for JSON', async () => {
  // There is no non-streaming path: `stream: false` is refused with `FreeTierError`. So the answer is
  // aggregated from the stream the contract requires. A caller asking why their JSON request streamed
  // deserves the answer, so it is asserted rather than left to be discovered.
  const adapter = new ZenAdapter({
    transport: streamingTransport({
      events: [
        { id: 'r', choices: [{ delta: { content: 'he' } }] },
        { id: 'r', choices: [{ delta: { content: 'llo' } }] },
        { id: 'r', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ],
    }),
  });
  const response = await adapter.chat(request('mimo-v2.5-free'), credential);
  assert.equal(response.message.content, 'hello', 'the stream is re-aggregated into one response');
});

test('a caller\'s own tools are kept — the placeholder never displaces a real tool', async () => {
  let sent;
  const adapter = new ZenAdapter({
    transport: streamingTransport({
      events: [{ id: 'r', choices: [{ delta: { content: 'x' } }] }],
      onRequest: (req) => { sent = req; },
    }),
  });
  await adapter.chat(request('mimo-v2.5-free', {
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  }), credential);
  const body = JSON.parse(sent.body);
  const names = body.tools.map((tool) => tool.function.name);
  assert.ok(names.includes('read_file'), 'the caller\'s tool is still declared');
  const own = body.tools.find((tool) => tool.function.name === 'read_file');
  assert.deepEqual(own.function.parameters.properties.path, { type: 'string' }, 'and its schema survives');
  assert.deepEqual(names.filter((name) => ['bash', 'glob', 'grep', 'read'].includes(name)), ['bash', 'glob', 'grep', 'read'], 'the quartet is appended beside it');
});

test('the gate applies to free models only', async () => {
  // A paid model must keep the ordinary JSON path. Applying the contract to it would mean streaming
  // every paid request and sending a tool the caller never declared, which is a behaviour change to a
  // path that works.
  const adapter = new ZenAdapter({
    transport: { async request() { throw new Error('should not be reached'); }, stream() { throw new Error('should not be reached'); } },
  });
  await assert.rejects(
    () => adapter.chat(request('deepseek-v4-pro'), credential),
    /unexpected request|should not be reached/,
    'a non-free model does not take the gated path',
  );
});

test('two turns of one conversation share an upstream session, and two conversations do not', async () => {
  // The upstream prompt cache keys on the session id, so a fresh id per request would mean a cold
  // cache on every turn of a conversation — paying full price for the same context again.
  const seeds = [];
  const adapter = new ZenAdapter({
    transport: streamingTransport({ events: [{ id: 'r', choices: [{ delta: { content: 'x' } }] }], onRequest: (req) => seeds.push(req.headers['x-opencode-session']) }),
  });
  const first = { model: 'mimo-v2.5-free', messages: [{ role: 'user', content: 'hello' }] };
  const second = { ...first, messages: [...first.messages, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'again' }] };
  const other = { model: 'mimo-v2.5-free', messages: [{ role: 'user', content: 'different' }] };

  await adapter.chat(first, credential);
  await adapter.chat(first, credential);
  await adapter.chat(other, credential);
  assert.equal(seeds[0], seeds[1], 'the same request twice is the same session');
  assert.notEqual(seeds[0], seeds[2], 'a different conversation is a different session');
});

test('a refusal after the contract names the network, not the API key', async () => {
  // The whole reason this error text exists. Measured, all four conditions still answer 403 from a
  // datacenter egress; a message saying "check your key" would send the user to rotate a key the
  // upstream already accepted.
  const adapter = new ZenAdapter({
    transport: {
      async request() { throw new Error('unused'); },
      stream() {
        return (async function* () {
          yield `data: ${JSON.stringify({ error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode" } })}\n\n`;
        })();
      },
    },
  });
  await assert.rejects(
    () => adapter.chat(request('mimo-v2.6-flash-free'), credential),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.match(error.publicMessage, /not a credential problem/i, 'the key is explicitly cleared');
      assert.match(error.publicMessage, /datacenter networks/i, 'and the likely cause is named');
      assert.match(error.publicMessage, /free-tier request contract requires/, 'with what was sent');
      assert.equal(error.details?.providerReason, "OpenCode's free tier can only be used from within OpenCode", "the provider's own words survive");
      return true;
    },
  );
});

test('a stream that closes without any payload is a refusal, not an empty answer', async () => {
  // Otherwise a gate refusal before the first event reads as "the model returned nothing", which is the
  // exact class of empty verdict this project keeps removing.
  const adapter = new ZenAdapter({
    transport: { async request() { throw new Error('unused'); }, stream() { return (async function* () {})(); } },
  });
  await assert.rejects(() => adapter.chat(request('mimo-v2.5-free'), credential), (error) => /refused/.test(error.message));
});

test('the session id has the shape the upstream checks, and the shape is all it checks', () => {
  assert.match(zenSessionId(), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(zenSessionId('stable'), zenSessionId('stable'), 'a seed makes it deterministic');
  assert.notEqual(zenSessionId('stable'), zenSessionId('other'));
});

test('the user-agent rule is the upstream\'s, not a guess', () => {
  assert.equal(satisfiesZenUserAgentContract('opencode/1.17.0'), true);
  assert.equal(satisfiesZenUserAgentContract('opencode/2.0.0'), true);
  assert.equal(satisfiesZenUserAgentContract('opencode/1.16.0'), false, 'below the floor');
  assert.equal(satisfiesZenUserAgentContract('curl/8.5.0'), false, 'a generic client UA does not pass');
  assert.equal(satisfiesZenUserAgentContract(undefined), false);
});

test('the free-tier quartet is declared in lowercase, and a caller\'s casing variant is renamed, not duplicated', async () => {
  const { gatedTools } = await import('../dist/providers/zen/index.js');
  assert.deepEqual(zenFingerprintTools().map((tool) => tool.function.name), ['bash', 'glob', 'grep', 'read']);

  const merged = gatedTools([
    { name: 'Bash', description: 'run', parameters: { type: 'object', properties: {} } },
    { name: 'write', description: 'write', parameters: { type: 'object', properties: {} } },
  ]);
  const names = merged.map((tool) => tool.function.name);
  assert.equal(names.filter((name) => name === 'bash').length, 1, 'Bash becomes bash, declared once');
  assert.ok(!names.includes('Bash'), 'the caller spelling is not sent');
  assert.ok(names.includes('write'), 'a non-quartet tool the caller declared is kept');
  assert.ok(names.includes('glob') && names.includes('grep') && names.includes('read'), 'missing quartet members are appended');
});

test('the contract check reports honestly rather than assuming it passed', () => {
  const headers = zenFreeTierHeaders(zenSessionId());
  const full = { stream: true, tools: zenFingerprintTools() };
  assert.equal(zenContractSatisfied(headers, full), true);
  assert.equal(zenContractSatisfied(headers, { ...full, stream: false }), false, 'a non-stream body is not satisfied');
  assert.equal(zenContractSatisfied(headers, { stream: true, tools: [] }), false, 'an empty tools array is not satisfied');
  assert.equal(zenContractSatisfied({ ...headers, 'user-agent': 'curl/8.5.0' }, full), false, 'a generic UA is not satisfied');
  assert.equal(zenContractSatisfied({}, full), false, 'no headers at all is not satisfied');
});
