import assert from 'node:assert/strict';
import test from 'node:test';

import { NvidiaAdapter } from '../nvidia/dist/adapter/index.js';
import { ProviderError } from '../_shared/dist/errors.js';

/**
 * NVIDIA is OpenAI-shaped on the wire, but its catalog is public and its reasoning control is a
 * translated field. Both differences are provider-specific and must not leak into the shared base.
 */

function transport(handler) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      const answer = await handler(request);
      if (answer.throw) throw answer.throw;
      return { status: 200, headers: new Headers(), data: answer.data };
    },
    async *stream() { throw new Error('not used'); },
  };
}

const catalog = { data: [{ id: 'nvidia/nemotron-3-ultra-550b-a55b', object: 'model', created: 1, owned_by: 'nvidia' }] };
const chatReply = { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
const credential = { type: 'api-key', value: 'nvapi_test' };

test('a key check sends a real 1-token probe because the catalog is public', async () => {
  const fake = transport((request) => ({ data: request.method === 'GET' ? catalog : chatReply }));
  const result = await new NvidiaAdapter({ transport: fake }).validateCredential(credential);
  assert.equal(result.status, 'valid');
  assert.equal(fake.calls.length, 2, 'catalog read plus probe, not a catalog read alone');
  assert.equal(fake.calls[0].url, 'https://integrate.api.nvidia.com/v1/models');
  const probe = fake.calls[1];
  assert.equal(probe.method, 'POST');
  assert.equal(probe.url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  const body = JSON.parse(probe.body);
  assert.equal(body.max_tokens, 1);
  assert.equal(body.stream, false);
  assert.equal(body.model, 'nvidia/nemotron-3-ultra-550b-a55b');
});

test('a refused key is a credential failure; a missing key spends nothing', async () => {
  const refused = transport((request) => request.method === 'GET'
    ? { data: catalog }
    : { throw: new ProviderError('AUTHENTICATION_FAILED', 'Forbidden', { statusCode: 403 }) });
  await assert.rejects(
    () => new NvidiaAdapter({ transport: refused }).validateCredential(credential),
    (error) => error.code === 'AUTHENTICATION_FAILED' && /NVIDIA refused this key/.test(error.publicMessage ?? ''),
  );
  const noKey = transport(() => ({ data: catalog }));
  await assert.rejects(
    () => new NvidiaAdapter({ transport: noKey }).validateCredential(undefined),
    (error) => error.code === 'AUTHENTICATION_FAILED',
  );
  assert.equal(noKey.calls.length, 0);
});

test('health says what a public catalog proves, and does not claim key validity', async () => {
  const fake = transport(() => ({ data: catalog }));
  const health = await new NvidiaAdapter({ transport: fake }).healthCheck({ credential });
  assert.equal(health.status, 'degraded');
  assert.match(health.message ?? '', /catalog is public/);
  assert.equal(fake.calls.length, 1, 'no billable probe in a health poll');
});

async function chatBody(request) {
  const fake = transport(() => ({ data: chatReply }));
  await new NvidiaAdapter({ transport: fake }).chat(request, { credential });
  return JSON.parse(fake.calls.at(-1).body);
}

test('reasoning effort is translated into chat_template_kwargs, never sent raw', async () => {
  const tools = [{ name: 'read', parameters: { type: 'object', properties: {} } }];
  const high = await chatBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high', tools });
  assert.equal(high.reasoning_effort, undefined);
  assert.deepEqual(high.chat_template_kwargs, { enable_thinking: true, force_nonempty_content: true });
  const medium = await chatBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'medium' });
  assert.deepEqual(medium.chat_template_kwargs, { enable_thinking: true, medium_effort: true });
  const off = await chatBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'low', providerOptions: { chat_template_kwargs: { force_nonempty_content: true } } });
  assert.equal(off.chat_template_kwargs.enable_thinking, true);
  assert.equal(off.chat_template_kwargs.medium_effort, true);
  assert.equal(off.chat_template_kwargs.force_nonempty_content, true);
});

test('only the NVIDIA provider option is accepted', async () => {
  await assert.rejects(
    () => chatBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }], providerOptions: { something_else: true } }),
    (error) => error.code === 'INVALID_REQUEST',
  );
});

test('the shared normalizer carries NVIDIA capability flags', async () => {
  const { normalizeCatalogModel } = await import('../_shared/dist/model-normalize.js');
  const model = normalizeCatalogModel({
    id: 'moonshotai/kimi-k3.1-pro', context_window: 1048576, model_type: 'vlm',
    supports_tools: true, supports_thinking: true,
  }, 'nvidia');
  assert.equal(model.modelType, 'vlm');
  assert.deepEqual(model.capabilities, { tools: true, reasoning: true });
  const bare = normalizeCatalogModel({ id: 'bare' }, 'nvidia');
  assert.equal(bare.capabilities, undefined, 'a silent catalog is not a tools:false claim');
});
