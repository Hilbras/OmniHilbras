import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore, createGatewayServer } from '../dist/index.js';
import { InMemorySecretStore, ProviderRegistry } from '@hilbras/omnihilbras';

// End to end: does a request through the real HTTP surface produce a truthful usage record, and does
// `GET /v1/usage` report it without leaking anything the record was designed not to hold?
//
// The store's own tests cover the store. These cover the wiring — the part where a record can be recorded
// with the wrong outcome, attributed to the wrong connection, or not recorded at all because a throw happened
// on the way out. That is where the v1.52.0 cancellation rule has to be re-checked, because a health counter
// and a usage record are different consumers of the same event.

/** A provider whose chat and stream behaviour the test chooses. */
function provider({ chunks = 0, failWith, latencyMs = 1 } = {}) {
  const instance = {
    id: 'p',
    name: 'p',
    capabilities: { chat: true, streaming: chunks > 0, models: true },
    async listModels() { return [{ id: 'm', providerId: 'p' }]; },
    async healthCheck() { return { status: 'healthy', verified: 'credential', checkedAt: new Date().toISOString() }; },
    async chat() {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      if (failWith) throw failWith;
      return {
        id: 'r', providerId: 'p', model: 'm', createdAt: new Date().toISOString(),
        message: { role: 'assistant', content: 'the answer' }, finishReason: 'stop',
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
  if (chunks > 0) {
    instance.capabilities.streaming = true;
    instance.streamChat = async function* () {
      for (let index = 0; index < chunks; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield { id: `c${index}`, providerId: 'p', model: 'm', delta: { content: 'x' } };
      }
      if (failWith) throw failWith;
    };
  }
  return instance;
}

async function gateway(options = {}) {
  const usage = new InMemoryUsageStore();
  const registry = new ProviderRegistry().register(options.provider ?? provider());
  const store = new InMemoryConnectionStore();
  await store.save(
    {
      id: 'conn-p', providerId: 'p', name: 'P', endpoint: 'https://p.example/v1', priority: 1,
      enabled: true, proxyPool: 'none', modelPolicy: 'all',
      resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 },
    },
    { type: 'api-key', value: 'k' },
  );
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('usage-e2e')).key;
  // Argument order matters and I got it wrong first: options is the FIFTH parameter, after the stores.
  // Passing `{ usageStore }` sixth put it in `deployment`, which is why every test saw `recording: false`.
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 1_000, usageStore: usage });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    usage,
    base,
    key,
    post: (body, headers = {}) => fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...body }),
    }),
    getUsage: (query = '') => fetch(`${base}/v1/usage${query}`, { headers: { authorization: `Bearer ${key}` } }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('a successful chat request produces one truthful record', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  assert.equal((await gw.post()).status, 200);

  const body = await (await gw.getUsage()).json();
  assert.equal(body.recording, true);
  assert.equal(body.totals.requests, 1);
  assert.equal(body.totals.succeeded, 1);
  const [record] = body.records;
  assert.equal(record.outcome, 'success');
  assert.equal(record.providerId, 'p');
  assert.equal(record.connectionId, 'conn-p', 'a record must name the connection, so one provider with three connections is three budgets');
  assert.equal(record.attempts, 1);
  assert.equal(record.inputTokens, 100);
  assert.equal(record.outputTokens, 20);
  assert.equal(body.totals.tokensUnmeasured, false);
});

test('a failed request records the provider error code and no tokens it never received', async (t) => {
  const gw = await gateway({ provider: provider({ failWith: Object.assign(new Error('upstream 503'), { code: 'PROVIDER_UNAVAILABLE' }) }) });
  t.after(gw.close);
  assert.equal((await gw.post()).status, 502);

  const body = await (await gw.getUsage()).json();
  assert.equal(body.totals.failed, 1);
  assert.equal(body.totals.succeeded, 0);
  assert.equal(body.records[0].outcome, 'failure');
  assert.ok(body.records[0].errorCode, 'a failure must say which code, or the page shows an error with no cause');
  // Nothing was metered, so the page must not present zeros as a measurement.
  assert.equal(body.totals.tokensUnmeasured, true);
});

test('a client disconnect is recorded as cancelled, not as a success or a failure', async (t) => {
  // The v1.52.0 rule, on a second consumer. A tab closing must not score the provider.
  //
  // **Two probe mistakes, both mine, and the first was near-invisible.**
  //
  // 1. I first fired two requests and aborted one, then asserted a single cancelled record — and read
  //    `succeeded: 1`, because the *other* request completed and its record was the one I saw.
  // 2. Then I aborted a `fetch` with an `AbortController` and got `success` at every delay (2/4/8/20 ms).
  //    That looked like the gateway recording cancellations as successes. It was not: **undici's fetch abort
  //    does not close the socket** — it discards the response body locally, so the server never sees a
  //    disconnect and the stream genuinely ran to completion. The gateway was right; the client was lying.
  //
  // A real disconnect is a destroyed socket, which is what a closed browser tab produces. Measured with a
  // raw socket destroyed mid-stream: `cancelled/p` — correct.
  const gw = await gateway({ provider: provider({ chunks: 200 }) });
  t.after(gw.close);
  const port = Number(new URL(gw.base).port);

  /** Read a few SSE frames, then destroy the socket, as a closed tab does. */
  const disconnectMidStream = () =>
    new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${gw.key}` },
      });
      let frames = 0;
      request.on('response', (response) => {
        response.on('data', () => {
          frames += 1;
          if (frames === 3) { response.destroy(); request.destroy(); resolve('destroyed'); }
        });
        response.on('close', () => resolve('closed'));
      });
      request.on('error', reject);
      request.end(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }));
    });

  assert.equal(await disconnectMidStream(), 'destroyed', 'the socket was never actually closed, so nothing was tested');
  await new Promise((resolve) => setTimeout(resolve, 200));

  const body = await (await gw.getUsage()).json();
  assert.equal(body.totals.requests, 1, `expected exactly one record, got ${JSON.stringify(body.totals)}`);
  assert.equal(body.totals.succeeded, 0, 'a stream nobody finished reading was recorded as a success');
  assert.equal(body.totals.failed, 0, `a client disconnect recorded ${body.totals.failed} provider failures`);
  assert.equal(body.totals.cancelled, 1, `expected one cancelled record, got ${JSON.stringify(body.totals)}`);
});

test('a completed stream is recorded once, as a success', async (t) => {
  const gw = await gateway({ provider: provider({ chunks: 4 }) });
  t.after(gw.close);
  const response = await gw.post({ stream: true }, { accept: 'text/event-stream' });
  await response.text();
  await new Promise((resolve) => setTimeout(resolve, 80));

  const body = await (await gw.getUsage()).json();
  assert.equal(body.totals.requests, 1, `a stream recorded ${body.totals.requests} records; it must be one, not one per chunk`);
  assert.equal(body.totals.succeeded, 1);
});

test('a stream that dies mid-answer records a failure, not a success', async (t) => {
  const gw = await gateway({ provider: provider({ chunks: 2, failWith: Object.assign(new Error('upstream died'), { code: 'PROVIDER_REQUEST_FAILED' }) }) });
  t.after(gw.close);
  const response = await gw.post({ stream: true }, { accept: 'text/event-stream' });
  const text = await response.text();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.ok(!text.includes('data: [DONE]'), 'the client must not be told the stream completed');
  const body = await (await gw.getUsage()).json();
  assert.equal(body.totals.succeeded, 0, 'a truncated stream was recorded as a success');
  assert.equal(body.totals.failed, 1);
});

test('no record, and no response body, contains the prompt or a credential', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  await fetch(`${gw.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${gw.key}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'MY-PRIVATE-PROMPT-MARKER' }] }),
  });

  const raw = await (await gw.getUsage()).text();
  assert.ok(!raw.includes('MY-PRIVATE-PROMPT-MARKER'), 'the usage response echoed the prompt back');
  assert.ok(!raw.includes(gw.key), 'the usage response echoed the API key back');
  for (const field of ['messages', 'content', 'prompt', 'headers', 'authorization']) {
    assert.ok(!raw.includes(`"${field}"`), `the usage response contains a \`${field}\` field`);
  }
  // And on disk, through the local store, which is where it would outlive the request.
  const onDisk = JSON.stringify(await gw.usage.list());
  assert.ok(!onDisk.includes('MY-PRIVATE-PROMPT-MARKER'));
});

test('a gateway with no usage store says so, rather than reporting zeros as a measurement', async (t) => {
  const registry = new ProviderRegistry().register(provider());
  const store = new InMemoryConnectionStore();
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('none')).key;
  // No `usageStore` in options -- the documented default.
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 10 });
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/usage`, { headers: { authorization: `Bearer ${key}` } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.recording, false, 'a gateway recording nothing must say so, not return zeros that read as "nothing was spent"');
  assert.equal(body.totals.tokensUnmeasured, true);
  assert.ok(body.reason, 'and must explain why');
});

test('an unknown outcome or a malformed limit is a 400, not a filter that matches nothing', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  await gw.post();

  const badOutcome = await (await gw.getUsage('?outcome=exploded')).json();
  assert.equal(badOutcome.error.code, 'INVALID_REQUEST', 'an unvalidated outcome silently matches nothing, which reads as "no failures"');
  assert.match(badOutcome.error.message, /success, failure, cancelled/);

  assert.equal((await gw.getUsage('?limit=abc')).status, 400);
  assert.equal((await gw.getUsage('?limit=999999')).status, 400);
  assert.equal((await gw.getUsage('?limit=5')).status, 200);
});

test('paging moves through the list while the totals still cover every record', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  for (let i = 0; i < 5; i += 1) await gw.post();

  assert.equal((await gw.getUsage('?offset=abc')).status, 400);

  const first = await (await gw.getUsage('?limit=2&offset=0')).json();
  const second = await (await gw.getUsage('?limit=2&offset=2')).json();
  const last = await (await gw.getUsage('?limit=2&offset=4')).json();
  assert.equal(first.records.length, 2);
  assert.equal(second.records.length, 2);
  assert.equal(last.records.length, 1);
  const ids = [...first.records, ...second.records, ...last.records].map((record) => record.id);
  assert.equal(new Set(ids).size, 5, 'each page returns different records');
  assert.equal(first.totals.requests, 5);
  assert.equal(last.totals.requests, 5, 'paging must not shrink the totals');
});

test('usage is read-only', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    // The `content-type` header matters: the gateway answers a body-bearing non-JSON request with 415 before
    // any route sees it, so without it this measured the wrong guard. With it, the 405 below is the route's.
    const response = await fetch(`${gw.base}/v1/usage`, {
      method,
      headers: { authorization: `Bearer ${gw.key}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 405, `${method} /v1/usage was accepted; records must not be writable from outside`);
  }
});

test('the query filters actually filter', async (t) => {
  const gw = await gateway();
  t.after(gw.close);
  await gw.post();
  await gw.post();

  const filtered = await (await gw.getUsage('?outcome=failure')).json();
  assert.equal(filtered.totals.requests, 0, 'a filter that does not filter is worse than no filter');
  const byProvider = await (await gw.getUsage('?provider=p')).json();
  assert.equal(byProvider.totals.requests, 2);
  const other = await (await gw.getUsage('?provider=nope')).json();
  assert.equal(other.totals.requests, 0);
});

test('GET /v1/usage requires the admin key when management enforcement is on', async (t) => {
  // `/v1/usage` joins MANAGEMENT_PREFIXES for the same reason `/v1/routing` is in it: a record describes
  // which providers and connections this machine talks to. An unauthenticated caller must not get that.
  const registry = new ProviderRegistry().register(provider());
  const store = new InMemoryConnectionStore();
  await store.save(
    { id: 'conn-p', providerId: 'p', name: 'P', endpoint: 'https://p.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelPolicy: 'all', resilience: { maxRetries: 0, requestsPerMinute: 0, timeoutMs: 5_000, hedgeAfterMs: 0 } },
    { type: 'api-key', value: 'k' },
  );
  const apiKeys = new InMemoryApiKeyStore();
  const key = (await apiKeys.create('gate')).key;
  const service = new GatewayService(registry, new InMemorySecretStore({}), store, apiKeys, { failureThreshold: 10, usageStore: new InMemoryUsageStore() });
  // Enforcement is a runtime toggle on the service, not a constructor option -- I guessed
  // `enforceManagementAuth` and it does not exist, which is why this reads the real API.
  // `setEnforced` lives on the service under a different name -- the API key manager's toggle.
  await service.setRequireApiKey(true);
  service.setHealthInterval(0);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const anonymous = await fetch(`${base}/v1/usage`);
  assert.equal(anonymous.status, 401, 'usage was readable with no key');
  const authenticated = await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(authenticated.status, 200);
});
