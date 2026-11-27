import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemorySecretStore, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore, createGatewayServer } from '../dist/src/index.js';
import { renderPrometheusMetrics } from '../dist/src/core/metrics.js';

/**
 * The gateway as Prometheus sees it.
 *
 * Before this file, `grep prometheus|/metrics Kernel/API/src` returned nothing: a person could read `/v1/usage` and
 * an alerting system could read nothing at all. Every series below is rendered from the usage records the gateway
 * already writes, so this endpoint and the page cannot disagree — they are two renderings of one store.
 */

const record = (overrides = {}) => ({
  at: new Date().toISOString(),
  model: 'm',
  outcome: 'success',
  attempts: 1,
  latencyMs: 100,
  ...overrides,
});

test('a scrape names its own liveness and its version', () => {
  const text = renderPrometheusMetrics({ records: [], version: '3.64.0' });
  assert.match(text, /^# TYPE omnihilbras_up gauge$/m);
  assert.match(text, /^omnihilbras_up 1$/m);
  assert.match(text, /^omnihilbras_build_info\{version="3\.64\.0"\} 1$/m);
  // A body with no records still names the gateway: an empty store is a configuration, not an outage.
  // The HELP/TYPE preamble is always present so a scraper knows the series exists; what must not appear is a *sample*.
  assert.doesNotMatch(text, /^omnihilbras_requests_total\{/m, 'an empty store invented a series');
});

test('outcomes are counters per provider, not an average', () => {
  const text = renderPrometheusMetrics({
    version: '3.64.0',
    records: [
      record({ providerId: 'groq' }),
      record({ providerId: 'groq' }),
      record({ providerId: 'groq', outcome: 'failure', errorCode: 'RATE_LIMITED', latencyMs: 300 }),
      record({ providerId: 'nous', outcome: 'cancelled', attempts: 2, latencyMs: 50 }),
    ],
  });
  assert.match(text, /^omnihilbras_requests_total\{provider="groq",outcome="success"\} 2$/m);
  assert.match(text, /^omnihilbras_requests_total\{provider="groq",outcome="failure"\} 1$/m);
  assert.match(text, /^omnihilbras_requests_total\{provider="nous",outcome="cancelled"\} 1$/m);
  // Attempts are counted separately: one request can be several provider calls, and a count of requests is not one.
  assert.match(text, /^omnihilbras_attempts_total\{provider="nous"\} 2$/m);
});

test('latency is exported as a sum and a count, so Prometheus can rate it', () => {
  const text = renderPrometheusMetrics({ version: '1', records: [record({ providerId: 'a', latencyMs: 100 }), record({ providerId: 'a', latencyMs: 200 })] });
  assert.match(text, /^omnihilbras_request_duration_ms_sum\{provider="a"\} 300$/m);
  assert.match(text, /^omnihilbras_request_duration_ms_count\{provider="a"\} 2$/m);
  // A quantile computed here would be a number no scraper could aggregate across instances.
  assert.doesNotMatch(text, /quantile=/);
});

test('estimated tokens are not presented as provider-reported tokens', () => {
  const text = renderPrometheusMetrics({
    version: '1',
    records: [
      record({ providerId: 'a', inputTokens: 100, outputTokens: 10 }),
      record({ providerId: 'a', inputTokens: 40, outputTokens: 5, tokensEstimated: true }),
    ],
  });
  assert.match(text, /^omnihilbras_tokens_total\{provider="a",kind="input"\} 100$/m);
  assert.match(text, /^omnihilbras_tokens_total\{provider="a",kind="output"\} 10$/m);
  assert.match(text, /^omnihilbras_tokens_estimated_total\{provider="a",kind="input"\} 40$/m);
  assert.match(text, /^omnihilbras_tokens_estimated_total\{provider="a",kind="output"\} 5$/m);
});

test('a request no provider served is counted, not dropped', () => {
  const text = renderPrometheusMetrics({ version: '1', records: [record({ providerId: undefined, outcome: 'cancelled' })] });
  assert.match(text, /^omnihilbras_requests_total\{provider="unattributed",outcome="cancelled"\} 1$/m);
});

test('a label value that could break the exposition format is escaped', () => {
  const text = renderPrometheusMetrics({ version: '1', records: [record({ providerId: 'we"ird\\name' })] });
  assert.match(text, /provider="we\\"ird\\\\name"/, 'a quote or backslash in a label value corrupts the scrape');
});

test('GET /metrics is a management path: refused without a credential', async (t) => {
  const apiKeys = new InMemoryApiKeyStore();
  const service = new GatewayService(
    new ProviderRegistry().register({ id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: true }, async listModels() { return []; } }),
    new InMemorySecretStore({}),
    new InMemoryConnectionStore(),
    apiKeys,
    { usageStore: new InMemoryUsageStore() },
  );
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const refused = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(refused.status, 401, 'anything that can read this knows every provider the gateway can reach');

  const created = await apiKeys.create('scraper');
  const answered = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: `Bearer ${created.key}` } });
  assert.equal(answered.status, 200);
  assert.match(answered.headers.get('content-type') ?? '', /text\/plain; version=0\.0\.4/, 'the registered exposition content type');
  assert.match(await answered.text(), /^omnihilbras_up 1$/m);
});

test('a scrape counts answers whose provider reported no usage', async () => {
  // The page now shows a labelled estimate for these, and this is how an operator sees the gap without opening records:
  // 500 records through one provider had no token counts and nothing said so outside the page.
  const text = renderPrometheusMetrics({
    version: '3.65.0',
    records: [
      { at: 'now', model: 'm', providerId: 'zcode', outcome: 'success', attempts: 1, latencyMs: 10 },
      { at: 'now', model: 'm', providerId: 'openrouter', outcome: 'success', attempts: 1, latencyMs: 10, inputTokens: 5, outputTokens: 2 },
    ],
  });
  assert.match(text, /^omnihilbras_usage_unreported_total\{provider="zcode"\} 1$/m);
  assert.doesNotMatch(text, /omnihilbras_usage_unreported_total\{provider="openrouter"\}/, 'a reported figure was counted as unreported');
});

test('the release route is answered by the gateway, and an unreachable feed is a stated result', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  // The gateway's own call to GitHub is stubbed; the dashboard's call to the gateway is not.
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.github.com/')) return new Response('{}', { status: 403 });
    return original(input, init);
  };

  const apiKeys = new InMemoryApiKeyStore();
  const service = new GatewayService(
    new ProviderRegistry().register({ id: 'p', name: 'P', capabilities: { chat: true, streaming: false, models: true }, async listModels() { return []; } }),
    new InMemorySecretStore({}),
    new InMemoryConnectionStore(),
    apiKeys,
    {},
  );
  const { createGatewayServer } = await import('../dist/src/index.js');
  const server = createGatewayServer(service, { corsOrigin: 'http://localhost:5173' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  // Management path, like every `/v1/system` route: it is answered for a credential, not for anyone who asks.
  const created = await apiKeys.create('update-check');
  const response = await fetch(`http://127.0.0.1:${port}/v1/system/update`, { headers: { authorization: `Bearer ${created.key}` } });
  assert.equal(response.status, 200, 'a blocked feed is a 500 rather than an answer');
  const body = await response.json();
  assert.equal(body.unavailable, true);
  assert.match(String(body.reason), /403/);
});

test('budget checks and refusals are series, and are omitted when budgets are not wired', () => {
  const withBudget = renderPrometheusMetrics({ records: [], version: '4.6.0', budget: { checks: 7, usdRefusals: 2, tokenRefusals: 1, policyRefusals: 3 } });
  assert.match(withBudget, /^omnihilbras_budget_checks_total 7$/m);
  assert.match(withBudget, /^omnihilbras_budget_refusals_total\{kind="usd"\} 2$/m);
  assert.match(withBudget, /^omnihilbras_budget_refusals_total\{kind="tokens"\} 1$/m);
  assert.match(withBudget, /^omnihilbras_budget_refusals_total\{kind="policy"\} 3$/m);

  const without = renderPrometheusMetrics({ records: [], version: '4.6.0' });
  assert.doesNotMatch(without, /omnihilbras_budget_/);
});

test('connection-pool reuse is exposed, because the fast state is otherwise invisible', () => {
  const text = renderPrometheusMetrics({
    records: [],
    version: '4.8.0',
    providerHttp: { requests: 12, connections: 2, reused: 10 },
  });
  assert.match(text, /^omnihilbras_provider_http_requests_total 12$/m);
  assert.match(text, /^omnihilbras_provider_http_connections_total 2$/m);
  assert.match(text, /^omnihilbras_provider_http_reused_total 10$/m);

  // Omitted rather than zero when the gateway was not given the pool: three zeros would read as
  // "the pool ran and never reused anything", which is a different claim.
  assert.doesNotMatch(renderPrometheusMetrics({ records: [], version: '4.8.0' }), /omnihilbras_provider_http_/);
});
