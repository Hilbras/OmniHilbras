import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { ProviderResolver } from '../dist/src/core/provider-resolver.js';
import { providerResponsesPath } from '../dist/src/core/provider-responses-lane.js';
import { FetchHttpTransport } from '../../SDK/_shared/dist/transport.js';
import { forgetResponsesLanes } from '../../SDK/_shared/dist/responses-lane.js';

/**
 * The Responses lane, wired for the one provider that has one.
 *
 * AgentRouter serves some models only through `/v1/responses` and answers the rest of its catalog —
 * `glm`, `deepseek` — on `/v1/chat/completions`, so the decision has to be per model. The mechanism is the
 * SDK's (`Kernel/SDK/openai/lib/responses-lane.ts`); what these tests pin is the **wiring**: that the
 * generic adapter the resolver builds for `agentrouter` carries the lane, at both of its construction
 * sites, and that no other provider acquires one.
 *
 * The last test is the one that matters most: the identity this gateway sends to this relay is another
 * vendor's client, and a lane is a second honest way for a provider to be special. A provider that is not
 * in the table must keep the behaviour it had, including its refusals.
 */

const IDENTITY_USER_AGENT = 'claude-cli/2.1.296 (external, cli)';
const CREDENTIAL = { type: 'api-key', value: 'sk-bogus-not-a-key' };
const LANE_REFUSAL = '模型 gpt-6-astra 不支持 /v1/chat/completions 接口,请改用 /v1/responses(OpenAI Responses API). Model gpt-6-astra does not support /v1/chat/completions, please use /v1/responses instead. (request id: 8b1d7f61-0000)';

/** A `fetch` double: the real transport, so the refusal is classified by the code that classifies refusals. */
function scriptedFetch({ refusesChat = () => undefined } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const href = String(url);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ path: new URL(href).pathname, body, headers: init.headers ?? {} });
    const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    if (href.endsWith('/chat/completions')) {
      const refusal = refusesChat(body);
      if (refusal) return json(refusal.status, refusal.body);
      return json(200, { id: 'chat-1', model: body.model, created: 1, choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    }
    if (href.endsWith('/responses')) {
      return json(200, {
        id: 'resp-1',
        model: body.model,
        created_at: 1,
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok from responses' }] }],
      });
    }
    return json(404, { error: { message: `the fixture does not serve ${href}` } });
  };
  return { calls, impl };
}

const turn = (model) => ({ model, messages: [{ role: 'user', content: 'hi' }] });

test('the adapter the request path builds for agentrouter retries the refusal on the Responses lane', async () => {
  forgetResponsesLanes();
  const script = scriptedFetch({ refusesChat: (body) => (body.model === 'gpt-6-astra' ? { status: 400, body: { error: { message: LANE_REFUSAL } } } : undefined) });
  const resolver = new ProviderResolver(new ProviderRegistry(), new FetchHttpTransport({ fetch: script.impl }));
  const adapter = await resolver.resolve('agentrouter', { endpoint: 'https://agentrouter.org/v1', name: 'AgentRouter' }, async () => []);
  assert.equal(adapter.id, 'agentrouter');

  const response = await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL });

  assert.deepEqual(script.calls.map((call) => call.path), ['/v1/chat/completions', '/v1/responses']);
  assert.equal(response.message.content, 'ok from responses');
  // The identity the relay gates on travels with the lane. It is configured on the adapter rather than per
  // request, which is why this passes — but a lane that lost the gate would be a 401 on the retry, and
  // nothing else in the suite would notice.
  assert.equal(script.calls[1].headers['User-Agent'], IDENTITY_USER_AGENT);
  assert.equal(script.calls[1].headers['x-app'], 'cli');
});

test('the health path builds the same lane as the request path', async () => {
  // `active()` is the second construction site. Wired at one site only, a request would reach the Responses
  // lane while the connection's own probe kept reporting the relay's chat-path refusal.
  forgetResponsesLanes();
  const script = scriptedFetch({
    refusesChat: (body) => (body.model === 'gpt-6-astra' ? { status: 400, body: { error: { message: LANE_REFUSAL } } } : undefined),
  });
  const resolver = new ProviderResolver(new ProviderRegistry(), new FetchHttpTransport({ fetch: script.impl }));
  const adapters = await resolver.active([
    { id: 'connection-1', providerId: 'agentrouter', hasCredential: true, endpoint: 'https://agentrouter.org/v1', name: 'AgentRouter' },
  ]);
  assert.equal(adapters.length, 1);

  const response = await adapters[0].chat(turn('gpt-6-astra'), { credential: CREDENTIAL });

  assert.deepEqual(script.calls.map((call) => call.path), ['/v1/chat/completions', '/v1/responses']);
  assert.equal(response.message.content, 'ok from responses');
});

test('a provider that is not in the table gets no lane, and its refusal is unchanged', async () => {
  forgetResponsesLanes();
  const script = scriptedFetch({ refusesChat: () => ({ status: 400, body: { error: { message: LANE_REFUSAL } } }) });
  const resolver = new ProviderResolver(new ProviderRegistry(), new FetchHttpTransport({ fetch: script.impl }));
  const adapter = await resolver.resolve('my-endpoint', { endpoint: 'https://example.invalid/v1', name: 'Mine' }, async () => []);

  const error = await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL }).then(() => undefined, (thrown) => thrown);

  assert.equal(error.statusCode, 400);
  assert.deepEqual(script.calls.map((call) => call.path), ['/v1/chat/completions']);
});

test('no SDK provider inherits a Responses lane by accident', () => {
  // Generalised the way the client-identity test generalises its own rule: the vocabulary is the SDK's
  // provider directories, so a provider added later extends this check without an edit.
  const sdkProviders = readdirSync(new URL('../../SDK/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const withLanes = sdkProviders.filter((id) => id !== 'agentrouter' && providerResponsesPath(id) !== undefined);
  assert.deepEqual(withLanes, [], `these providers would send requests to an endpoint nobody measured: ${withLanes.join(', ')}`);
  assert.equal(providerResponsesPath('agentrouter'), '/responses');
  assert.equal(providerResponsesPath('AgentRouter'), undefined, 'provider ids are matched as they are written');
});

test('the lane survives the real transport and the real socket', async (t) => {
  // Everything above drives a fake `fetch`. This one puts the retry on a loopback server and lets Node's
  // fetch carry it, so the URL, the method and the headers are the ones that would leave the process — the
  // same reason `agentrouter-client-identity.test.js` ends by reading its headers off the wire.
  forgetResponsesLanes();
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, headers: request.headers });
    if (request.url === '/v1/chat/completions') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: LANE_REFUSAL } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'resp-1', model: 'gpt-6-astra', created_at: 1, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok from responses' }] }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  // No transport is injected, so this is the resolver's own — the one a running gateway uses.
  const resolver = new ProviderResolver(new ProviderRegistry());
  const adapter = await resolver.resolve('agentrouter', { endpoint: `http://127.0.0.1:${server.address().port}/v1`, name: 'AgentRouter' }, async () => []);
  const response = await adapter.chat(turn('gpt-6-astra'), { credential: CREDENTIAL });

  assert.deepEqual(seen.map((entry) => entry.url), ['/v1/chat/completions', '/v1/responses']);
  assert.equal(response.message.content, 'ok from responses');
  assert.equal(seen[1].headers['user-agent'], IDENTITY_USER_AGENT);
});
