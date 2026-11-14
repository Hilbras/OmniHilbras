import assert from 'node:assert/strict';
import test from 'node:test';
import { RateLimiter, defaultRequestsPerMinute, resolveRequestsPerMinute } from '../dist/src/core/rate-limit.js';
import { ProviderRegistry } from '../dist/src/core/index.js';
import { InMemoryApiKeyStore, InMemoryConnectionStore, GatewayService, createGatewayServer } from '../dist/src/index.js';

/**
 * The inbound ceiling on the LLM surface.
 *
 * The audit's F8: the gateway limited what it *sends* to a provider and nothing about what arrives, so a
 * retrying agent could spend the operator's quota at line speed — and the provider's own limiter became
 * the thing that stopped it, which reads as the gateway being broken.
 */

function adapter(id) {
  return {
    id, name: id, capabilities: { chat: true, streaming: false, models: true, embeddings: false },
    async listModels() { return [{ id: `model-${id}`, providerId: id }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request) { return { id: 'r', providerId: id, model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }; },
  };
}

async function gateway(options = {}) {
  const store = new InMemoryConnectionStore();
  await store.save({ id: 'conn-a', providerId: 'a', name: 'A', endpoint: 'https://a.example/v1', priority: 1, proxyPool: 'none', enabled: true, modelIds: ['model-a'] }, { type: 'api-key', value: 'key' });
  const keys = new InMemoryApiKeyStore();
  const key = (await keys.create('limit')).key;
  // A second, valid key: an unknown one is refused with 401 by the auth gate, which would test the
  // gate rather than the limiter.
  const secondKey = (await keys.create('other')).key;
  const service = new GatewayService(new ProviderRegistry().register(adapter('a')), store, store, keys);
  const server = createGatewayServer(service, { corsOrigins: ['http://localhost:5173'], ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    key,
    secondKey,
    close: () => new Promise((resolve) => server.close(resolve)),
    call: (path, init = {}) => fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
    }),
  };
}

test('the limiter counts a window, refuses past the ceiling, and recovers on the next window', () => {
  let clock = 1_000_000;
  const limiter = new RateLimiter({ perMinute: 3, now: () => clock });

  assert.deepEqual([1, 2, 3].map(() => limiter.check('k').allowed), [true, true, true]);
  const refused = limiter.check('k');
  assert.equal(refused.allowed, false, 'the fourth request in the window is refused');
  assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 60_000, 'and it is told how long to wait');

  // A different caller has its own window: one runaway key must not starve another.
  assert.equal(limiter.check('other').allowed, true);

  clock += 60_000;
  assert.equal(limiter.check('k').allowed, true, 'the window rolls after a minute');

  // Expired windows are dropped, so a long-lived gateway does not keep one entry per key ever seen.
  limiter.prune();
  assert.equal(limiter.trackedCallers, 1);
});

test('0 turns the limit off, and a typo falls back to the default rather than refusing everything', () => {
  assert.equal(resolveRequestsPerMinute({}), defaultRequestsPerMinute);
  assert.equal(resolveRequestsPerMinute({ OMNIHILBRAS_REQUESTS_PER_MINUTE: ' 120 ' }), 120);
  assert.equal(resolveRequestsPerMinute({ OMNIHILBRAS_REQUESTS_PER_MINUTE: '0' }), 0, 'explicit off is honoured');
  assert.equal(resolveRequestsPerMinute({ OMNIHILBRAS_REQUESTS_PER_MINUTE: 'abc' }), defaultRequestsPerMinute);
  assert.equal(resolveRequestsPerMinute({ OMNIHILBRAS_REQUESTS_PER_MINUTE: '-5' }), defaultRequestsPerMinute);

  const off = new RateLimiter({ perMinute: 0 });
  assert.equal(off.enabled, false);
  assert.equal(off.check('k').allowed, true);
});

test('a loop on the LLM surface is refused with a 429 and a retry-after, while management stays usable', async (t) => {
  const gw = await gateway({ requestsPerMinute: 2 });
  t.after(gw.close);

  const body = JSON.stringify({ model: 'a/model-a', messages: [{ role: 'user', content: 'hi' }] });
  const first = await gw.call('/v1/chat/completions', { method: 'POST', body });
  const second = await gw.call('/v1/chat/completions', { method: 'POST', body });
  const third = await gw.call('/v1/chat/completions', { method: 'POST', body });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 429, 'the third request in the same window is refused');
  assert.ok(Number(third.headers.get('retry-after')) >= 1, 'the refusal says how long to wait');
  const refused = await third.json();
  assert.match(refused.error.message, /2 per minute/, 'and it names the ceiling that was hit');
  assert.match(refused.error.message, /OMNIHILBRAS_REQUESTS_PER_MINUTE/, 'and how to change it');

  // Management is a person clicking, not a loop: refusing those would be the dashboard breaking.
  const models = await gw.call('/v1/models');
  assert.equal(models.status, 200);
  const connections = await gw.call('/v1/connections');
  assert.equal(connections.status, 200, 'a management read is never rate limited');
});

test('two callers do not share one ceiling', async (t) => {
  const gw = await gateway({ requestsPerMinute: 1 });
  t.after(gw.close);
  const body = JSON.stringify({ model: 'a/model-a', messages: [{ role: 'user', content: 'hi' }] });

  const mine = await gw.call('/v1/chat/completions', { method: 'POST', body });
  const mineAgain = await gw.call('/v1/chat/completions', { method: 'POST', body });
  const theirs = await gw.call('/v1/chat/completions', { method: 'POST', body, headers: { authorization: `Bearer ${gw.secondKey}` } });

  assert.equal(mine.status, 200);
  assert.equal(mineAgain.status, 429);
  assert.equal(theirs.status, 200, 'a different key has its own window');
});
