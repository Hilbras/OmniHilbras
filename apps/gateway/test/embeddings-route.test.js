import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InMemorySecretStore, ProviderError, ProviderRegistry } from '@hilbras/omnihilbras';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, createGatewayServer } from '../dist/index.js';
import { isPublicLlmRoute, parseEmbeddingRequest } from '../dist/routes/inference.js';

/**
 * `POST /v1/embeddings`.
 *
 * Every test here is written against a specific wrong answer, because the failure modes of an
 * embeddings endpoint all look like success from outside:
 *
 * - a route added to the dispatcher but not to `isPublicLlmRoute` is **unauthenticated**, and a test
 *   that called the handler directly would never notice;
 * - a provider that cannot embed answered with an empty vector list instead of `NOT_SUPPORTED`;
 * - a dimension count invented rather than measured;
 * - a short result silently accepted, misaligning the caller's array positions.
 */

/** An adapter that serves embeddings, with a scripted failure mode. */
function embeddingAdapter({ fail } = {}) {
  return {
    id: 'acme',
    name: 'Acme',
    capabilities: { chat: true, streaming: true, models: true, embeddings: true },
    async listModels() {
      return [{ id: 'acme-embed', providerId: 'acme' }];
    },
    async *streamChat() {
      // The registry validates that a declared capability has an implementation behind it, so a fake
      // adapter claiming `streaming` has to provide one. Never called by these tests.
      throw new Error('not used');
    },
    async embed(request) {
      if (fail) throw fail;
      const inputs = typeof request.input === 'string' ? [request.input] : [...request.input];
      return {
        id: 'emb-1',
        providerId: 'acme',
        model: request.model,
        createdAt: '2026-10-05T00:00:00.000Z',
        data: inputs.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3], dimensions: 3 })),
        usage: { inputTokens: 4, totalTokens: 4 },
      };
    },
  };
}

/** An adapter with chat but no embeddings at all — the shape most providers have today. */
function chatOnlyAdapter() {
  return {
    id: 'quiet',
    name: 'Quiet',
    capabilities: { chat: true, streaming: true, models: true },
    async listModels() {
      return [{ id: 'quiet-1', providerId: 'quiet' }];
    },
    async *streamChat() {
      throw new Error('not used');
    },
    async chat() {
      return { id: 'c1', providerId: 'quiet', model: 'quiet-1', createdAt: '2026-10-05T00:00:00.000Z', message: { role: 'assistant', content: 'hi' }, finishReason: 'stop' };
    },
  };
}

/** A connection store holding one enabled connection for a provider. */
async function storeWith(providerId, extra = {}) {
  const store = new InMemoryConnectionStore();
  await store.save(
    { id: providerId, providerId, name: 'Test', endpoint: 'https://api.example.test/v1', priority: 1, proxyPool: 'none', modelIds: [`${providerId}-embed`, `${providerId}-1`], ...extra },
    { type: 'api-key', value: 'secret' },
  );
  return store;
}

/**
 * Attaches a recording usage store to a live service.
 *
 * `usage` is a getter over a private field, so it cannot be assigned — and that is the right shape.
 * `GatewayServiceOptions.usageStore` is the seam, and reaching past it in a test would be testing a
 * field rather than the wiring.
 */
function attachUsage(service, recorded) {
  service.usageStore = { record: (entry) => { recorded.push(entry); return Promise.resolve(); }, list: () => Promise.resolve([]) };
}

/** Starts a gateway on an ephemeral port and runs `run` against it. */
async function withGateway(providerAdapter, run, options = {}) {
  const providerId = providerAdapter.id;
  const connectionStore = await storeWith(providerId);
  const apiKeys = new InMemoryApiKeyStore();
  const { key } = await apiKeys.create('test');
  const service = new GatewayService(
    new ProviderRegistry().register(providerAdapter),
    new InMemorySecretStore({ [providerId]: { type: 'api-key', value: 'secret' } }),
    connectionStore,
    apiKeys,
    {},
  );
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173', ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await run({
      base,
      key,
      service,
      /** POSTs an embeddings request with the given auth header. */
      async embed(body, headers = { authorization: `Bearer ${key}` }) {
        const response = await fetch(`${base}/v1/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ── the authentication boundary ─────────────────────────────────────────────

test('THE BOUNDARY: /v1/embeddings is in the authenticated route set', () => {
  // The whole point: a path served but absent from this predicate is reachable with no key.
  assert.equal(isPublicLlmRoute('POST', '/v1/embeddings'), true, 'a route served without being listed here is unauthenticated');
  assert.equal(isPublicLlmRoute('GET', '/v1/embeddings'), false, 'and only the method the route handles');
  assert.equal(isPublicLlmRoute('POST', '/v1/chat/completions'), true, 'the sibling route must still be guarded');
  assert.equal(isPublicLlmRoute('GET', '/v1/models'), true);
});

test('every /v1 path the dispatcher serves is in the auth predicate, and vice versa', () => {
  // The predicate and the dispatcher are one fact stated twice, so they are compared as sets rather
  // than trusted to stay in step. The reverse direction matters too: a guarded path nobody serves is
  // a gate protecting a door that is not there.
  const source = readFileSync(new URL('../src/routes/inference.ts', import.meta.url), 'utf8');
  const served = [...new Set([...source.matchAll(/url\.pathname === '(\/v1\/[^']+)'/g)].map((m) => m[1]))];
  // Strip comments first, or the predicate's own documentation — which names `/v1/embeddings` in prose
  // — counts as a guarded path and the comparison passes for the wrong reason.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const guarded = [...new Set([...code.matchAll(/pathname === '(\/v1\/[^']+)'/g)].map((m) => m[1]))]
    .filter((path) => new RegExp(`method === '(?:GET|POST)'[^\\n]*${path.replace('/', '\\/')}`).test(code.replace(/\n\s*/g, ' '))
      || new RegExp(`${path.replace('/', '\\/')}[\\s\\S]{0,80}method === '(?:GET|POST)'`).test(code.replace(/\n\s*/g, ' ')));
  assert.deepEqual(served.filter((path) => !guarded.includes(path)), [], 'a served /v1 path is missing from the auth predicate');
  assert.deepEqual(guarded.filter((path) => !served.includes(path)), [], 'the auth predicate names a path that is not served');
});

test('an unauthenticated POST /v1/embeddings is refused with 401', async () => {
  await withGateway(embeddingAdapter(), async ({ embed }) => {
    const { status, body } = await embed({ model: 'acme-embed', input: 'hello' }, { 'content-type': 'application/json' });
    assert.equal(status, 401, 'an unauthenticated embeddings request must be refused, not served');
    assert.equal(body.error?.code, 'AUTHENTICATION_FAILED', 'the same code the chat route returns');
  });
});

test('an invalid key is refused and a valid one is served', async () => {
  await withGateway(embeddingAdapter(), async ({ embed, key }) => {
    const refused = await embed({ model: 'acme-embed', input: 'hello' }, { authorization: 'Bearer wrong' });
    assert.equal(refused.status, 401);

    const served = await embed({ model: 'acme-embed', input: 'hello' }, { authorization: `Bearer ${key}` });
    assert.equal(served.status, 200);
    assert.deepEqual(served.body.data[0].embedding, [0.1, 0.2, 0.3]);
  });
});

// ── the response shape ──────────────────────────────────────────────────────

test('the response is OpenAI-shaped, with measured dimensions and a quotable request id', async () => {
  await withGateway(embeddingAdapter(), async ({ embed }) => {
    const { status, body } = await embed({ model: 'acme-embed', input: ['one', 'two'] });
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.equal(body.model, 'acme-embed');
    assert.equal(body.provider, 'acme');
    assert.deepEqual(body.data.map((row) => row.object), ['embedding', 'embedding']);
    assert.deepEqual(body.data.map((row) => row.index), [0, 1]);
    assert.deepEqual(body.data.map((row) => row.dimensions), [3, 3], 'dimensions come from the vector, not a constant');
    assert.equal(body.usage.prompt_tokens, 4);
    assert.equal(body.usage.total_tokens, 4);
    assert.match(body.gateway.requestId, /^[0-9a-f]{32}$/, 'a client must be able to quote this request');
  });
});

test('dimensions is omitted from the response when the adapter did not measure one', async () => {
  // An adapter that returns a vector without saying its length leaves the field out. A client reading
  // `dimensions` has to be able to tell "not reported" from "zero".
  const adapter = embeddingAdapter();
  const original = adapter.embed;
  adapter.embed = async (request) => {
    const response = await original(request);
    return { ...response, data: response.data.map((row) => ({ index: row.index, embedding: row.embedding })) };
  };
  await withGateway(adapter, async ({ embed }) => {
    const { body } = await embed({ model: 'acme-embed', input: 'hello' });
    assert.equal('dimensions' in body.data[0], false, 'an unmeasured dimension must be absent, not zero');
  });
});

// ── the refusal cases ───────────────────────────────────────────────────────

test('a provider with no embeddings returns NOT_SUPPORTED naming it, not an empty list', async () => {
  // The distinction that matters: "cannot do this" and "is down" look identical from outside and send
  // an operator to opposite places. An empty `data: []` is worse than either — it reads as success.
  await withGateway(chatOnlyAdapter(), async ({ embed, key }) => {
    const { status, body } = await embed({ model: 'quiet-1', input: 'hello' }, { authorization: `Bearer ${key}` });
    // 501, not 404: `statusForError` already maps NOT_SUPPORTED to 501 because for chat it means "this
    // provider cannot do this", which is a server-side capability gap rather than a missing resource.
    assert.equal(status, 501);
    assert.equal(body.error?.code, 'NOT_SUPPORTED');
    assert.match(body.error?.message ?? '', /Quiet does not support embeddings/);
  });
});

test('an adapter that advertises the capability without implementing it is NOT_SUPPORTED, not a 500', async () => {
  // A registry entry can carry the flag before the call exists. Calling `undefined` would reach the
  // client as a 500, which says "the gateway broke" about a provider that simply cannot serve this.
  const adapter = {
    id: 'acme',
    name: 'Acme',
    // `streaming` is dropped because the registry validates that a declared capability has an
    // implementation, and this adapter's whole point is that `embeddings` is declared *without* one.
    capabilities: { chat: true, models: true, embeddings: true },
    async listModels() { return [{ id: 'acme-embed', providerId: 'acme' }]; },
    async chat() { throw new Error('not used'); },
  };
  await withGateway(adapter, async ({ embed, key }) => {
    const { status, body } = await embed({ model: 'acme-embed', input: 'hello' }, { authorization: `Bearer ${key}` });
    assert.equal(status, 501);
    assert.equal(body.error?.code, 'NOT_SUPPORTED');
  });
});

test('a provider failure keeps its own code and status rather than becoming a generic 502', async () => {
  await withGateway(embeddingAdapter({ fail: new ProviderError('RATE_LIMITED', 'slow down', { providerId: 'acme' }) }), async ({ embed, key }) => {
    const { status, body } = await embed({ model: 'acme-embed', input: 'hello' }, { authorization: `Bearer ${key}` });
    assert.equal(status, 429);
    assert.equal(body.error?.code, 'RATE_LIMITED');
  });
});

// ── request validation at the edge ──────────────────────────────────────────

test('a request naming no usable input is refused before it is routed or paid for', () => {
  // Refusing here means nothing is rate-limited and nothing is billed for a request that could never
  // produce a vector. `[]` is not "no input", it is a request for zero vectors, and a caller receiving
  // `data: []` cannot tell that from a provider that silently did nothing.
  for (const body of [{ model: 'm' }, { model: 'm', input: '' }, { model: 'm', input: [] }, { model: 'm', input: [''] }, { model: 'm', input: [1] }, { input: 'a' }, { model: '', input: 'a' }]) {
    assert.throws(() => parseEmbeddingRequest(body), /input must be|model is required/, `accepted ${JSON.stringify(body)}`);
  }
});

test('encoding_format base64 is refused rather than silently returned as floats', () => {
  // Decoding base64 here would mean holding a vector this gateway cannot use; returning floats under a
  // `base64` request is a lie the client cannot detect.
  assert.throws(() => parseEmbeddingRequest({ model: 'm', input: 'a', encoding_format: 'base64' }), /float/);
  assert.equal(parseEmbeddingRequest({ model: 'm', input: 'a', encoding_format: 'float' }).model, 'm');
});

test('dimensions is forwarded only when given, and must be a positive number', () => {
  assert.equal('dimensions' in parseEmbeddingRequest({ model: 'm', input: 'a' }), false);
  assert.equal(parseEmbeddingRequest({ model: 'm', input: 'a', dimensions: 256 }).dimensions, 256);
  assert.throws(() => parseEmbeddingRequest({ model: 'm', input: 'a', dimensions: 0 }), /dimensions/);
  assert.throws(() => parseEmbeddingRequest({ model: 'm', input: 'a', dimensions: 'many' }), /dimensions/);
});

test('a string input and a one-element array are both accepted', () => {
  assert.equal(parseEmbeddingRequest({ model: 'm', input: 'a' }).input, 'a');
  assert.deepEqual(parseEmbeddingRequest({ model: 'm', input: ['a'] }).input, ['a']);
});

// ── the ledger, and what is recorded ────────────────────────────────────────

test('a failure is recorded in usage, attributed, with the error code it carried', async () => {
  // `attachAttempts` rebuilds the error and puts the ledger in `details.attempts`, and `toErrorEnvelope`
  // deliberately does **not** publish `details` — only code, message, requestId, provider, status and
  // retryable. So the ledger is verified where it is actually consumed, by the usage recorder, which is
  // the reader 1.61.0 found silently producing nothing when the ledger went missing.
  const recorded = [];
  await withGateway(embeddingAdapter({ fail: new ProviderError('PROVIDER_REQUEST_FAILED', 'boom', { providerId: 'acme' }) }), async ({ embed, key, service }) => {
    attachUsage(service, recorded);
    const { status, body } = await embed({ model: 'acme-embed', input: 'hello' }, { authorization: `Bearer ${key}` });
    assert.equal(status, 502);
    assert.equal(body.error.code, 'PROVIDER_REQUEST_FAILED');
  });
  assert.equal(recorded.length, 1, 'a failed request is recorded, not dropped');
  assert.equal(recorded[0].outcome, 'failure');
  assert.equal(recorded[0].providerId, 'acme', 'attributed from the ledger, not left unattributed');
  assert.equal(recorded[0].attempts >= 1, true, 'and the attempt count is the ledger length');
  assert.equal(recorded[0].errorCode, 'PROVIDER_REQUEST_FAILED');
});

test('the error envelope publishes no provider internals on an embeddings failure', async () => {
  // The other half of the point above: whatever the ledger holds internally, a client sees a stable
  // shape. `details` would carry the provider's own error details.
  await withGateway(embeddingAdapter({ fail: new ProviderError('PROVIDER_REQUEST_FAILED', 'internal detail: upstream said no', { providerId: 'acme' }) }), async ({ embed, key }) => {
    const { body } = await embed({ model: 'acme-embed', input: 'hello' }, { authorization: `Bearer ${key}` });
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'provider', 'requestId', 'retryable', 'status'].filter((k) => k in body.error).sort());
    assert.equal('details' in body.error, false, 'provider internals must not reach the client');
  });
});

test('an embeddings request is recorded in usage, with the tokens that were measured', async () => {
  const recorded = [];
  await withGateway(embeddingAdapter(), async ({ embed, key, service }) => {
    attachUsage(service, recorded);
    const { status } = await embed({ model: 'acme-embed', input: 'hello' }, { authorization: `Bearer ${key}` });
    assert.equal(status, 200);
  });
  assert.equal(recorded.length, 1, 'one request in, one record out');
  assert.equal(recorded[0].outcome, 'success');
  assert.equal(recorded[0].providerId, 'acme');
  assert.equal(recorded[0].inputTokens, 4, 'measured tokens are carried, not zeroed');
  assert.equal('outputTokens' in recorded[0], false, 'an embeddings call generates no completion tokens');
});

test('a failed request is recorded as a failure, with its error code', async () => {
  const recorded = [];
  await withGateway(embeddingAdapter({ fail: new ProviderError('PROVIDER_REQUEST_FAILED', 'boom', { providerId: 'acme' }) }), async ({ embed, key, service }) => {
    attachUsage(service, recorded);
    await embed({ model: 'acme-embed', input: 'hello' }, { authorization: `Bearer ${key}` });
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].outcome, 'failure');
  assert.equal(recorded[0].errorCode, 'PROVIDER_REQUEST_FAILED');
});

// ── the executor semantics embeddings inherits ──────────────────────────────

test('embeddings walks the route chain and never hedges', async () => {
  // A hedge fires a second concurrent request to reach the fastest provider. For embeddings that
  // doubles the bill for a latency win nobody asked for, so the executor must not race.
  const source = readFileSync(new URL('../src/request-executor.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  async embed(');
  const embedMethod = source.slice(start, source.indexOf('  private async runSequential'));
  assert.ok(start > 0, 'the embed method must exist');
  assert.equal(embedMethod.includes('tryHedgedRace'), false, 'embeddings must not hedge');
  assert.equal(embedMethod.includes('runSequential'), true, 'it must share the sequential chain');
});

test('the sequential chain is one implementation, not a copy per request kind', () => {
  // The value of the extraction: chat and embeddings cannot drift apart because there is one loop.
  // Counting the sites is the property — a third limiter throw or a third `enforceRateLimit` call
  // means a loop was copied rather than shared, which is the drift this guards against.
  const source = readFileSync(new URL('../src/request-executor.ts', import.meta.url), 'utf8');
  // Three dispatch sites, and each is a distinct loop: `runSequential`, `stream`, and the hedge race's
  // `start`. Embeddings added a *caller* of the first, not a fourth — which is the property worth
  // pinning. A copied loop shows up here as four.
  assert.equal((source.match(/enforceRateLimit\(candidate\)/g) ?? []).length, 3, 'three dispatch loops: sequential, stream, hedge race');
  assert.equal((source.match(/this\.deps\.withDeadline\(/g) ?? []).length, 3);
  // And the sharing itself. Both request kinds must reach the one extracted loop, and the only thing
  // that differs between them is the dispatch closure they hand it — which is the property that stops
  // the rules drifting apart.
  const chatMethod = source.slice(source.indexOf('  async chat('), source.indexOf('  /**\n   * Embeds, walking the same route chain'));
  const embedMethod = source.slice(source.indexOf('  async embed('), source.indexOf('  private async runSequential'));
  for (const [name, body] of [['chat', chatMethod], ['embed', embedMethod]]) {
    assert.equal(body.includes('runSequential'), true, `${name} must reach the extracted loop`);
    assert.equal(/withDeadline|recordRateLimitUse|recordSuccess|recordFailure/.test(body), false, `${name} must not re-implement an effect; it hands the loop a dispatch`);
  }
  assert.equal(chatMethod.includes('this.deps.chat('), true, 'chat hands the loop its dispatch');
  assert.equal(embedMethod.includes('this.deps.embed('), true, 'embeddings hands the loop its dispatch');
});