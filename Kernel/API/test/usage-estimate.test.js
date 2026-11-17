import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore, createGatewayServer, summarizeUsage } from '../dist/src/index.js';

/**
 * A provider that reports no token usage now produces a **labelled estimate** rather than a dash.
 *
 * Measured before this: 500 records through one provider, none with a token count, so the usage page showed `—` for
 * every token figure and "Not priced" for cost. Honest, and useless. The record now carries `tokensEstimated` when the
 * figure came from counting characters, so the page can print "measured" or "estimated from text" and mean whichever
 * it says.
 */

const request = { model: 'm', messages: [{ role: 'user', content: 'Explain in one sentence why a gateway estimates tokens.' }], max_tokens: 32 };

async function run(adapter, t, body = request) {
  const store = new InMemoryConnectionStore();
  await store.save(
    { id: 'c', providerId: 'p', name: 'c', endpoint: 'https://p.example/v1', priority: 1, proxyPool: 'none', enabled: true, modelPolicy: 'all', modelIds: ['m'], resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: 'sk-test' },
  );
  const usageStore = new InMemoryUsageStore();
  const apiKeys = new InMemoryApiKeyStore();
  await apiKeys.setEnforced(false);
  const service = new GatewayService(
    new ProviderRegistry().register({ id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: true }, async listModels() { return [{ id: 'm', providerId: 'p' }]; }, ...adapter }),
    new InMemorySecretStore({ p: { type: 'api-key', value: 'sk-test' } }),
    store,
    apiKeys,
    { usageStore },
  );
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  // The record is written off the response path on purpose (a metrics write must never delay an answer), so wait for it
  // rather than reading an empty store.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [record] = await usageStore.list({ limit: 1 });
    if (record) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return usageStore;
}

const answer = (content, usage) => ({
  id: 'r',
  providerId: 'p',
  model: 'm',
  createdAt: new Date().toISOString(),
  message: { role: 'assistant', content },
  finishReason: 'stop',
  ...(usage ? { usage } : {}),
});

test('an answer with no usage is recorded as an estimate, and says so', async (t) => {
  const store = await run({ async chat() { return answer('Because a provider that reports nothing would otherwise leave every figure blank.'); } }, t);
  const [record] = await store.list({ limit: 1 });
  assert.ok((record.inputTokens ?? 0) > 0, 'the prompt tokens were not estimated');
  assert.ok((record.outputTokens ?? 0) > 0, 'the answer tokens were not estimated');
  assert.equal(record.tokensEstimated, true, 'an estimate was recorded as if it were measured');
  const totals = summarizeUsage(await store.list({ limit: 10 }));
  assert.equal(totals.tokensEstimated, true, 'the totals do not say that any figure was estimated');
  assert.equal(totals.tokensUnmeasured, false, 'a counted record still reads as unmeasured');
});

test('an answer that reports usage is recorded as measured, with no estimate attached', async (t) => {
  const store = await run({ async chat() { return answer('Measured answer.', { inputTokens: 12, outputTokens: 3 }); } }, t);
  const [record] = await store.list({ limit: 1 });
  assert.equal(record.inputTokens, 12, 'the provider\'s own count was overwritten');
  assert.equal(record.outputTokens, 3);
  assert.notEqual(record.tokensEstimated, true, 'a measured record was labelled estimated');
  assert.equal(summarizeUsage(await store.list({ limit: 10 })).tokensEstimated, false);
});

test('a request with no text to count stays unmeasured rather than guessing zero', async (t) => {
  // An empty prompt is not a zero-token prompt, and claiming one would be the same lie in the other direction. This
  // sends nothing and receives nothing, which is the only shape with no characters to count.
  const store = await run({ async chat() { return { ...answer(''), message: { role: 'assistant', content: '' } }; } }, t, { model: 'm', messages: [{ role: 'user', content: '' }], max_tokens: 8 });
  const [record] = await store.list({ limit: 1 });
  assert.equal(record.inputTokens, undefined, 'an empty request produced a token count');
  assert.equal(summarizeUsage(await store.list({ limit: 10 })).tokensUnmeasured, true);
});

test('the estimate is a stated approximation, not a tokenizer', async (t) => {
  // 4 characters per token, minimum one. The exact number does not matter; that it is labelled does.
  const store = await run({ async chat() { return answer('12345678'); } }, t);
  const [record] = await store.list({ limit: 1 });
  assert.equal(record.outputTokens, 2, 'eight characters should read as two tokens');
});

/** The streaming path used to record no usage at all — not the provider's, not an estimate. */
async function runStreaming(chunks, t) {
  const store = new InMemoryConnectionStore();
  await store.save(
    { id: 'c', providerId: 'p', name: 'c', endpoint: 'https://p.example/v1', priority: 1, proxyPool: 'none', enabled: true, modelPolicy: 'all', modelIds: ['m'], resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: 'sk-test' },
  );
  const usageStore = new InMemoryUsageStore();
  const apiKeys = new InMemoryApiKeyStore();
  await apiKeys.setEnforced(false);
  const service = new GatewayService(
    new ProviderRegistry().register({
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, models: true },
      async listModels() { return [{ id: 'm', providerId: 'p' }]; },
      async chat() { throw new Error('not used'); },
      async *streamChat(request) {
        for (const chunk of chunks) yield { id: 'r', providerId: 'p', model: request.model, ...chunk };
      },
    }),
    new InMemorySecretStore({ p: { type: 'api-key', value: 'sk-test' } }),
    store,
    apiKeys,
    { usageStore },
  );
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request, stream: true }),
  });
  assert.equal(response.status, 200);
  await response.text();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [record] = await usageStore.list({ limit: 1 });
    if (record) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return usageStore;
}

test('a streamed turn records the usage its final chunk carried', async (t) => {
  const store = await runStreaming([
    { delta: 'Because ' },
    { delta: 'it reports usage.' },
    { delta: '', finishReason: 'stop', usage: { inputTokens: 21, outputTokens: 5, totalTokens: 26 } },
  ], t);
  const [record] = await store.list({ limit: 1 });
  assert.equal(record.inputTokens, 21, 'the streamed usage never reached the record');
  assert.equal(record.outputTokens, 5);
  assert.notEqual(record.tokensEstimated, true, 'a measured stream was labelled estimated');
});

test('a streamed turn that reports nothing is estimated from what was sent and received', async (t) => {
  const store = await runStreaming([{ delta: 'twelve chars' }, { delta: '', finishReason: 'stop' }], t);
  const [record] = await store.list({ limit: 1 });
  assert.ok((record.outputTokens ?? 0) > 0, 'the streamed answer was not counted');
  assert.equal(record.tokensEstimated, true);
});
