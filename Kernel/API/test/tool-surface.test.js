import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { InMemorySecretStore, ProviderError, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryConnectionStore, createGatewayServer } from '../dist/src/index.js';

/**
 * What the client is told about tools.
 *
 * The contract's refusal is only half of it: a request that *can* be served is still served, so a client needs to be
 * able to tell that its tools were dropped rather than ignored by a model that chose not to call. These assert the
 * three surfaces that say so — the model listing, the response body, and the streaming header.
 */

const models = {
  'qwen-web': [{ id: 'qw/qwen3.8-max', providerId: 'qwen-web' }],
  openai: [{ id: 'openai/gpt-4o', providerId: 'openai' }],
  kiro: [{ id: 'kiro/claude-sonnet-5', providerId: 'kiro' }],
};

function service() {
  const registry = new ProviderRegistry();
  for (const id of ['qwen-web', 'openai', 'kiro']) {
    registry.register({
      id,
      name: id,
      capabilities: { chat: true, streaming: true, models: true },
      async listModels() { return models[id]; },
      async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
      async chat(request) {
        return { id: 'r', providerId: id, model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
      },
      async *streamChat(request) {
        yield { id: 'r', providerId: id, model: request.model, delta: { content: 'ok' } };
        yield { id: 'r', providerId: id, model: request.model, delta: {}, finishReason: 'stop' };
      },
    });
  }
  const connections = new InMemoryConnectionStore();
  for (const id of ['qwen-web', 'openai', 'kiro']) {
    void connections.save({ id, providerId: id, name: id, endpoint: 'https://example.invalid/v1', priority: 1, proxyPool: 'none', modelIds: [models[id][0].id] }, { type: 'api-key', value: 'k' });
  }
  // No gateway key store: this is local mode, so a request without a bearer token is the normal case and the surfaces
  // are the thing under test rather than the gate.
  return new GatewayService(registry, new InMemorySecretStore({ 'qwen-web': { type: 'api-key', value: 'k' }, openai: { type: 'api-key', value: 'k' }, kiro: { type: 'api-key', value: 'k' } }), connections, undefined, {});
}

async function withServer(run) {
  const server = createGatewayServer(service(), { corsOrigins: ['http://localhost:20137'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A gateway whose tools-capable primary refuses the stream and whose tools-less backup answers it. */
async function failoverService() {
  const registry = new ProviderRegistry();
  const adapter = (id, fail) => ({
    id, name: id, capabilities: { chat: true, streaming: true, models: true },
    async listModels() { return [{ id: 'shared/model', providerId: id }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1 }; },
    async chat() { throw new Error('not used'); },
    async *streamChat(request) {
      if (fail) throw new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true });
      yield { id: 'r', providerId: id, model: request.model, delta: { content: 'ok' }, finishReason: 'stop' };
    },
  });
  registry.register(adapter('openai', true));
  registry.register(adapter('qwen-web', false));
  const connections = new InMemoryConnectionStore();
  await connections.save({ id: 'primary', providerId: 'openai', name: 'primary', endpoint: 'https://example.invalid/v1', priority: 1, proxyPool: 'none', modelIds: ['shared/model'], resilience: { maxRetries: 0 } }, { type: 'api-key', value: 'k' });
  await connections.save({ id: 'backup', providerId: 'qwen-web', name: 'backup', endpoint: 'https://example.invalid/v1', priority: 2, proxyPool: 'none', modelIds: ['shared/model'] }, { type: 'api-key', value: 'k' });
  return new GatewayService(registry, new InMemorySecretStore({}), connections, undefined, {});
}

async function withFailoverServer(run) {
  const server = createGatewayServer(await failoverService(), { corsOrigins: ['http://localhost:20137'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// The OpenAI wire shape, which is what a client sends: the definition is nested under `function`.
const tool = { type: 'function', function: { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } } };
const body = (model) => JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], tools: [tool] });

test('a model whose provider cannot serve tools says so in the listing', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/models`);
    const data = (await response.json()).data;
    const web = data.find((entry) => entry.id.endsWith('qwen3.8-max'));
    const api = data.find((entry) => entry.id.endsWith('gpt-4o'));
    assert.equal(web.tools, false, 'a web model did not say it cannot call tools');
    assert.equal('tools' in api, false, 'a capable model carries a field that is true for almost every model');
  });
});

test('a chat answered by a web session reports that the tools were not used', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: body('qw/qwen3.8-max'),
    });
    const raw = await response.text();
    assert.equal(response.status, 200, raw.slice(0, 300));
    const payload = JSON.parse(raw);
    assert.equal(payload.gateway.tools, 'unsupported', 'the client was left to guess why its agent went quiet');
  });
});

test('a forced call a provider cannot honour is refused with the documented 501', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kiro/claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }], tools: [tool], tool_choice: 'required' }),
    });
    const payload = await response.json();
    assert.equal(response.status, 501, `expected the documented 501, got ${response.status}: ${JSON.stringify(payload)}`);
    assert.equal(payload.error?.code ?? payload.code, 'NOT_SUPPORTED');
    const spec = readFileSync(new URL('../../../docs/SPEC-SDK.md', import.meta.url), 'utf8');
    assert.match(
      spec,
      /tool_choice: "required"[\s\S]{0,120}answers `501` with code `NOT_SUPPORTED`/,
      'the spec advertises a different status than the wire sends',
    );
  });
});

test('a chat answered by a capable provider says nothing extra', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: body('openai/gpt-4o'),
    });
    const payload = await response.json();
    assert.equal('tools' in payload.gateway, false);
  });
});

test('a streamed answer from a web session carries the note in the stream', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...JSON.parse(body('qw/qwen3.8-max')), stream: true }),
    });
    // The head is written before the provider is known, so the note arrives as the stream's first event.
    const streamed = await response.text();
    const first = streamed.split('\n\n')[0];
    assert.match(first, /"gateway":\{"tools":"unsupported"\}/, `the note was not in the stream: ${first.slice(0, 200)}`);
  });
});

test('a Responses request to a tools-less provider says so in its body', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qw/qwen3.8-max', input: 'hi', tools: [tool] }),
    });
    const raw = await response.text();
    assert.equal(response.status, 200, raw.slice(0, 300));
    assert.equal(JSON.parse(raw).gateway?.tools, 'unsupported', 'the Responses surface left the client guessing');
  });
});

test('a streamed Responses completion carries the same note', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qw/qwen3.8-max', input: 'hi', tools: [tool], stream: true }),
    });
    const events = await response.text();
    assert.match(events, /event: response\.completed/);
    assert.match(events, /"gateway":\{"requestId":"[^"]+","tools":"unsupported"\}/, `the streamed completion had no note: ${events.slice(-300)}`);
  });
});

test('a streamed note names the provider that answered, not the one that failed first', async () => {
  await withFailoverServer(async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'shared/model', messages: [{ role: 'user', content: 'hi' }], tools: [tool], stream: true }),
    });
    const streamed = await response.text();
    const first = streamed.split('\n\n')[0];
    assert.match(first, /"gateway":\{"tools":"unsupported"\}/, `the backup is a web session but the note named the failed primary: ${first.slice(0, 200)}`);
  });
});

test('a streamed answer from a capable provider carries no such note', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...JSON.parse(body('openai/gpt-4o')), stream: true }),
    });
    const streamed = await response.text();
    assert.doesNotMatch(streamed, /"tools":"unsupported"/);
  });
});
