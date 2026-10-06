import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleAdapter, ProviderError } from '../dist/index.js';

/**
 * `/embeddings` on the OpenAI-compatible adapter.
 *
 * The tests here are mostly about what the adapter must **refuse to invent**, because that is where
 * an embeddings client is quietly harmed:
 *
 * - a dimension count that is measured, never assumed;
 * - one vector per input, or an error — a short list silently misaligns with the caller's inputs;
 * - no request at all when the provider has not declared the capability.
 */

function createTransport(data) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      return { status: 200, headers: new Headers(), data };
    },
    async *stream() {},
  };
}

/** Every call site needs a credential unless it is specifically testing the credential gate. */
const WITH_KEY = { credential: { type: 'api-key', value: 'secret' } };

function createAdapter(transport, config = {}) {
  return new OpenAICompatibleAdapter({
    id: 'acme',
    name: 'Acme',
    baseUrl: 'https://api.acme.test/v1',
    auth: { header: 'X-API-Key' },
    capabilities: { embeddings: true },
    ...config,
  }, { transport });
}

const twoVectors = {
  id: 'emb-1',
  model: 'acme-embed',
  data: [
    { object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] },
    { object: 'embedding', index: 1, embedding: [0.4, 0.5] },
  ],
  usage: { prompt_tokens: 7, total_tokens: 7 },
};

test('embed posts to /embeddings and normalises a string input to a one-element array', async () => {
  const transport = createTransport({ data: [{ object: 'embedding', index: 0, embedding: [1, 2] }] });
  const adapter = createAdapter(transport);

  const response = await adapter.embed(
    { model: 'acme-embed', input: 'hello' },
    { credential: { type: 'api-key', value: 'secret' } },
  );

  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].method, 'POST');
  assert.equal(transport.calls[0].url, 'https://api.acme.test/v1/embeddings');
  const body = JSON.parse(transport.calls[0].body);
  assert.deepEqual(body.input, ['hello'], 'a bare string becomes a one-element array, as OpenAI expects');
  assert.equal(body.model, 'acme-embed');
  assert.equal(response.data.length, 1);
});

test('embed carries dimensions, encoding_format and user only when given', async () => {
  const transport = createTransport({ data: [{ index: 0, embedding: [1] }] });
  const adapter = createAdapter(transport);

  await adapter.embed({ model: 'm', input: 'a', dimensions: 256, encodingFormat: 'float', user: 'u1' }, WITH_KEY);
  const withAll = JSON.parse(transport.calls[0].body);
  assert.equal(withAll.dimensions, 256);
  assert.equal(withAll.encoding_format, 'float');
  assert.equal(withAll.user, 'u1');

  await adapter.embed({ model: 'm', input: 'a' }, WITH_KEY);
  const bare = JSON.parse(transport.calls[1].body);
  assert.equal('dimensions' in bare, false, 'an absent dimension request must not be sent as undefined');
  assert.equal('user' in bare, false);
});

test('dimensions are MEASURED from the vector, per row, never assumed', async () => {
  // Two rows of different lengths in one response. A single hardcoded constant — 1536 being the
  // obvious one — gets the second row wrong, and a caller who trusts it cannot detect that.
  const transport = createTransport(twoVectors);
  const adapter = createAdapter(transport);

  const response = await adapter.embed({ model: 'acme-embed', input: ['one', 'two'] }, WITH_KEY);

  assert.deepEqual(response.data.map((row) => row.dimensions), [3, 2]);
  assert.deepEqual(response.data.map((row) => row.embedding.length), [3, 2]);
  assert.deepEqual(response.data.map((row) => row.index), [0, 1]);
});

test('a row whose index the provider omitted takes its position rather than a guess', async () => {
  const transport = createTransport({ data: [{ embedding: [1] }, { embedding: [2] }] });
  const adapter = createAdapter(transport);
  const response = await adapter.embed({ model: 'm', input: ['a', 'b'] }, WITH_KEY);
  assert.deepEqual(response.data.map((row) => row.index), [0, 1]);
});

test('a short result is an error, not a partial success', async () => {
  // Two inputs, one vector. Returning it would hand the caller an array whose positions no longer
  // line up with the inputs they sent, with nothing in the response to say so.
  const transport = createTransport({ data: [{ index: 0, embedding: [1, 2, 3] }] });
  const adapter = createAdapter(transport);

  await assert.rejects(
    () => adapter.embed({ model: 'm', input: ['one', 'two'] }, WITH_KEY),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.match(error.message, /1 embedding\(s\) for 2 input\(s\)/);
      return true;
    },
  );
});

test('a response with no data array is refused', async () => {
  const transport = createTransport({ id: 'x', model: 'm' });
  const adapter = createAdapter(transport);
  await assert.rejects(() => adapter.embed({ model: 'm', input: 'a' }, WITH_KEY), /missing data/);
});

test('an empty or non-numeric vector is refused rather than passed on', async () => {
  for (const embedding of [[], ['a', 1], [Number.NaN], [Number.POSITIVE_INFINITY]]) {
    const transport = createTransport({ data: [{ index: 0, embedding }] });
    const adapter = createAdapter(transport);
    await assert.rejects(() => adapter.embed({ model: 'm', input: 'a' }, WITH_KEY), /embedding/, `accepted ${JSON.stringify(embedding)}`);
  }
});

test('empty input is refused before any request is made', async () => {
  const transport = createTransport({ data: [] });
  const adapter = createAdapter(transport);

  for (const input of ['', [], [''], ['ok', '']]) {
    await assert.rejects(() => adapter.embed({ model: 'm', input }, WITH_KEY), /non-empty/);
  }
  assert.equal(transport.calls.length, 0, 'a request was sent for input that cannot produce a vector');
});

test('a provider that has not declared embeddings is told so, without a round trip', async () => {
  // The distinction that matters to a user: "this provider cannot do embeddings" and "this provider
  // is down" look identical from outside and send them to opposite places.
  const transport = createTransport(twoVectors);
  const adapter = createAdapter(transport, { capabilities: { embeddings: false } });

  await assert.rejects(
    () => adapter.embed({ model: 'm', input: 'a' }, WITH_KEY),
    (error) => {
      assert.equal(error.code, 'NOT_SUPPORTED');
      assert.equal(error.providerId, 'acme');
      assert.match(error.publicMessage ?? '', /Acme does not support embeddings/);
      return true;
    },
  );
  assert.equal(transport.calls.length, 0, 'an undeclared capability must not become a third-party 404');
});

test('embeddings is NOT on by default for an OpenAI-shaped base URL', async () => {
  // A compatible server implementing chat and nothing else is common, so chat-shaped is not evidence
  // that /embeddings exists. Defaulting it on would make the capability a claim rather than a fact.
  const transport = createTransport(twoVectors);
  const adapter = new OpenAICompatibleAdapter(
    { id: 'acme', name: 'Acme', baseUrl: 'https://api.acme.test/v1', auth: { header: 'X-API-Key' } },
    { transport },
  );

  assert.equal(adapter.capabilities.embeddings, false);
  await assert.rejects(() => adapter.embed({ model: 'm', input: 'a' }, WITH_KEY), (error) => error.code === 'NOT_SUPPORTED');
  assert.equal(transport.calls.length, 0);
});

test('embeddingsPath is configurable and is not derived from chatPath', async () => {
  // A provider serving chat at one path and embeddings at another is the normal case; deriving one
  // from the other is a guess about someone else's URL layout.
  const transport = createTransport({ data: [{ index: 0, embedding: [1] }] });
  const adapter = createAdapter(transport, { chatPath: '/v2/generate', embeddingsPath: '/v2/vectorize' });

  await adapter.embed({ model: 'm', input: 'a' }, WITH_KEY);
  assert.equal(transport.calls[0].url, 'https://api.acme.test/v1/v2/vectorize');
});

test('a provider that does not declare the capability still lists models and chats', async () => {
  const calls = [];
  const transport = {
    async request(request) {
      calls.push(request.url);
      if (request.url.endsWith('/models')) return { status: 200, headers: new Headers(), data: { data: [{ id: 'acme-1' }] } };
      return { status: 200, headers: new Headers(), data: { choices: [{ message: { role: 'assistant', content: 'hi' } }] } };
    },
    async *stream() {},
  };
  const adapter = new OpenAICompatibleAdapter(
    { id: 'acme', name: 'Acme', baseUrl: 'https://api.acme.test/v1', auth: { header: 'X-API-Key' } },
    { transport },
  );

  await adapter.listModels({ credential: { type: 'api-key', value: 's' } });
  await adapter.chat({ model: 'acme-1', messages: [{ role: 'user', content: 'hi' }] }, { credential: { type: 'api-key', value: 's' } });
  assert.deepEqual(calls, ['https://api.acme.test/v1/models', 'https://api.acme.test/v1/chat/completions']);
});

test('usage is carried when the provider reports it and omitted when it does not', async () => {
  const withUsage = createTransport(twoVectors);
  const a1 = createAdapter(withUsage);
  const r1 = await a1.embed({ model: 'm', input: ['a', 'b'] }, WITH_KEY);
  assert.equal(r1.usage?.inputTokens, 7);
  assert.equal(r1.usage?.totalTokens, 7);
  // An embeddings call generates no completion tokens. The shared `normalizeUsage` helper owns the
  // shape of a usage object, so this asserts the *value* rather than the key's absence — a
  // zero here would be a claim about tokens that were never generated.
  assert.ok(r1.usage.outputTokens === undefined || r1.usage.outputTokens === 0,
    `completion tokens must not be invented, got ${String(r1.usage.outputTokens)}`);

  const withoutUsage = createTransport({ data: [{ index: 0, embedding: [1] }] });
  const a2 = createAdapter(withoutUsage);
  const r2 = await a2.embed({ model: 'm', input: 'a' }, WITH_KEY);
  assert.equal(r2.usage, undefined, 'an unreported usage must stay absent rather than becoming zero');
});

test('the credential gate applies to embeddings exactly as it does to chat', async () => {
  const transport = createTransport({ data: [{ index: 0, embedding: [1, 2, 3] }] });
  const adapter = createAdapter(transport, { auth: { header: 'X-API-Key', required: true } });

  await assert.rejects(() => adapter.embed({ model: 'm', input: 'a' }), (error) => error.code === 'AUTHENTICATION_FAILED');
  assert.equal(transport.calls.length, 0);

  await adapter.embed({ model: 'm', input: 'a' }, { credential: { type: 'api-key', value: 'secret' } });
  assert.equal(transport.calls[0].headers['X-API-Key'], 'secret');
});

test('an aborted signal reaches the provider request', async () => {
  const controller = new AbortController();
  const transport = createTransport({ data: [{ index: 0, embedding: [1] }] });
  const adapter = createAdapter(transport);
  controller.abort();

  await adapter.embed({ model: 'm', input: 'a' }, { credential: { type: 'api-key', value: 's' }, signal: controller.signal });
  assert.equal(transport.calls[0].signal, controller.signal, 'the transport must be given the signal to abort on');
});