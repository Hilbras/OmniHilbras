import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryVirtualModelStore, ProviderError, ProviderRegistry } from '../dist/src/core/index.js';
import { GatewayService, InMemoryApiKeyStore, InMemoryConnectionStore, InMemoryUsageStore, createGatewayServer } from '../dist/src/index.js';

/**
 * `smart` and `fusion` spend real turns. Every provider below is a scripted adapter — no live key,
 * no billed request — but the gateway still routes through its own executor, usage ledger and virtual
 * store. A fabricated router choice would make the scripted "choice wins" assertion pass for the wrong
 * reason, so the router's chat call is recorded and checked as well.
 */

const signal = () => new AbortController().signal;

function adapter(id, seen, { content = `answer-${id}`, decision, waitForAbort = false, delayMs = 0 } = {}) {
  return {
    id,
    name: id,
    capabilities: { chat: true, streaming: false, models: true },
    async listModels() { return [{ id: `model-${id}`, providerId: id }]; },
    async healthCheck() { return { status: 'healthy', checkedAt: new Date().toISOString(), latencyMs: 1, verified: 'credential' }; },
    async chat(request, context) {
      seen.push({ id, model: request.model, messages: request.messages, signal: context?.signal });
      if (waitForAbort) {
        const s = context?.signal;
        if (!s) throw new Error('the abort signal did not reach the adapter');
        await new Promise((resolve) => {
          if (s.aborted) return resolve();
          s.addEventListener('abort', resolve, { once: true });
        });
        throw new ProviderError('CANCELLED', 'cancelled', { publicMessage: 'cancelled' });
      }
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const text = decision ? JSON.stringify(decision) : content;
      return { id: `r-${id}`, providerId: id, model: request.model, createdAt: new Date().toISOString(), message: { role: 'assistant', content: text }, finishReason: 'stop' };
    },
  };
}

async function setup({ strategy, extra = {}, panelIds = ['a', 'b', 'c'], judgeId = 'judge', routerDecision = { choice: 'model-b', confidence: 0.9 } } = {}) {
  const seen = [];
  const connections = new InMemoryConnectionStore();
  const registry = new ProviderRegistry();
  for (const id of panelIds) {
    await connections.save({ id: `conn-${id}`, providerId: id, name: id, endpoint: `https://${id}.example/v1`, priority: 1, enabled: true, proxyPool: 'none', modelIds: [`model-${id}`] }, { type: 'api-key', value: 'key' });
    registry.register(adapter(id, seen));
  }
  for (const id of ['router', judgeId]) {
    if (registry.get(id)) continue;
    await connections.save({ id: `conn-${id}`, providerId: id, name: id, endpoint: `https://${id}.example/v1`, priority: 1, enabled: true, proxyPool: 'none', modelIds: [`model-${id}`] }, { type: 'api-key', value: 'key' });
    registry.register(adapter(id, seen, { ...(id === 'router' ? { decision: routerDecision } : { content: 'the synthesised answer' }) }));
  }
  const virtual = new InMemoryVirtualModelStore();
  await virtual.save({
    id: strategy === 'fusion' ? 'oh/fuse' : 'oh/smart',
    name: strategy,
    strategy,
    targets: panelIds.map((id) => ({ connectionId: `conn-${id}`, upstreamModelId: `model-${id}`, priority: 1 })),
    ...(strategy === 'smart' ? { routerModel: 'model-router' } : { judgeModel: `model-${judgeId}` }),
    ...extra,
  });
  const usage = new InMemoryUsageStore();
  const apiKeys = new InMemoryApiKeyStore();
  const service = new GatewayService(registry, connections, connections, apiKeys, { virtualModels: virtual, usageStore: usage });
  service.setHealthInterval(0);
  const model = strategy === 'fusion' ? 'oh/fuse' : 'oh/smart';
  return { seen, connections, virtual, service, usage, apiKeys, model, request: { model, messages: [{ role: 'user', content: 'explain X' }] } };
}

const request = (model, messages = [{ role: 'user', content: 'explain X' }]) => ({ model, messages });

test('smart: a scripted router choice wins and the router turn really happened', async () => {
  const { service, seen, request } = await setup({ strategy: 'smart' });
  const outcome = await service.chatWithFailover(request, undefined, signal());
  const panel = seen.filter((entry) => entry.id !== 'router');
  assert.equal(panel[0].id, 'b', 'the chosen target went first');
  assert.equal(seen.filter((entry) => entry.id === 'router').length, 1, 'a real router turn was spent');
  assert.equal(outcome.response.model, 'model-b', 'the upstream model id reached the adapter');
});

test('smart: low confidence and a router failure both fall back to declared order', async () => {
  const low = await setup({ strategy: 'smart', routerDecision: { choice: 'model-c', confidence: 0.2 }, extra: { confidenceThreshold: 0.8 } });
  await low.service.chatWithFailover(low.request, undefined, signal());
  assert.equal(low.seen.filter((entry) => entry.id !== 'router')[0].id, 'a');

  const noRouter = await setup({ strategy: 'smart', extra: { routerModel: 'model-does-not-exist' } });
  const outcome = await noRouter.service.chatWithFailover(noRouter.request, undefined, signal());
  assert.equal(outcome.response.model, 'model-a', 'a router that cannot be routed falls back without failing the turn');
});

test('smart: session stickiness reuses the choice, and sessionSticky:false pays per turn', async () => {
  const sticky = await setup({ strategy: 'smart', extra: { sessionSticky: true } });
  await sticky.service.chatWithFailover(sticky.request, undefined, signal());
  await sticky.service.chatWithFailover(request('oh/smart'), undefined, signal());
  assert.equal(sticky.seen.filter((entry) => entry.id === 'router').length, 1, 'the second turn reused the sticky choice');
  assert.equal(sticky.seen.filter((entry) => entry.id !== 'router')[1].id, 'b');

  const perTurn = await setup({ strategy: 'smart', extra: { sessionSticky: false } });
  await perTurn.service.chatWithFailover(perTurn.request, undefined, signal());
  await perTurn.service.chatWithFailover(request('oh/smart'), undefined, signal());
  assert.equal(perTurn.seen.filter((entry) => entry.id === 'router').length, 2, 'per-turn mode pays for a second router call');
});

test('smart and fusion fields survive an encrypted-backup export/import round trip', async () => {
  const store = new InMemoryVirtualModelStore();
  await store.save({
    id: 'oh/smart', strategy: 'smart', routerModel: 'model-router', confidenceThreshold: 0.91, sessionSticky: false,
    targets: [{ connectionId: 'conn-a', upstreamModelId: 'model-a' }],
  });
  await store.save({
    id: 'oh/fuse', strategy: 'fusion', judgeModel: 'model-judge', quorum: 3, graceMs: 500, hardTimeoutMs: 4000,
    targets: [{ connectionId: 'conn-a', upstreamModelId: 'model-a' }],
  });
  const backup = await store.exportState();
  const restored = new InMemoryVirtualModelStore();
  await restored.importState(backup);
  const smart = (await restored.list()).find((model) => model.id === 'oh/smart');
  const fusion = (await restored.list()).find((model) => model.id === 'oh/fuse');
  assert.equal(smart.routerModel, 'model-router');
  assert.equal(smart.confidenceThreshold, 0.91);
  assert.equal(smart.sessionSticky, false);
  assert.equal(fusion.judgeModel, 'model-judge');
  assert.equal(fusion.quorum, 3);
  assert.equal(fusion.graceMs, 500);
  assert.equal(fusion.hardTimeoutMs, 4000);
  await assert.rejects(() => store.save({ id: 'oh/bad', strategy: 'smart', targets: [{ connectionId: 'conn-a', upstreamModelId: 'model-a' }] }), /routerModel/);
  await assert.rejects(() => store.save({ id: 'oh/bad', strategy: 'fusion', targets: [{ connectionId: 'conn-a', upstreamModelId: 'model-a' }] }), /judgeModel/);
});

test('fusion: all panel members are dispatched and the judge sees anonymised sources', async () => {
  const { service, seen, request, model } = await setup({ strategy: 'fusion', extra: { quorum: 3, graceMs: 50, hardTimeoutMs: 2000 } });
  const outcome = await service.chatWithFailover(request, undefined, signal());
  for (const id of ['a', 'b', 'c']) assert.ok(seen.some((entry) => entry.id === id), `${id} was never asked`);
  const judge = seen.find((entry) => entry.id === 'judge');
  assert.ok(judge, 'a real judge turn was spent');
  const panelPrompt = judge.messages.at(-1).content;
  assert.match(panelPrompt, /\[Source 1\]/);
  assert.match(panelPrompt, /\[Source 2\]/);
  assert.match(panelPrompt, /\[Source 3\]/);
  assert.match(panelPrompt, /answer-a/);
  assert.match(panelPrompt, /answer-c/);
  assert.equal(outcome.response.message.content, 'the synthesised answer');
  assert.equal(outcome.attempts.length, 4, 'three panel turns plus one judge turn are all in the ledger');
  assert.equal(outcome.response.model, model, 'the client sees the virtual id, not the judge model');
});

test('fusion: zero enabled panel members is refused before any turn', async () => {
  const { service, connections, seen, request } = await setup({ strategy: 'fusion' });
  await connections.setEnabled('conn-a', false);
  await connections.setEnabled('conn-b', false);
  await connections.setEnabled('conn-c', false);
  await assert.rejects(() => service.chatWithFailover(request, undefined, signal()), /no enabled targets/);
  assert.equal(seen.filter((entry) => entry.id === 'judge').length, 0, 'no judge turn was paid for');
});

test('fusion: a client abort is propagated to every outstanding panel member', async () => {
  const seen = [];
  const connections = new InMemoryConnectionStore();
  const registry = new ProviderRegistry();
  const ids = ['a', 'b', 'c'];
  for (const id of ids) {
    await connections.save({ id: `conn-${id}`, providerId: id, name: id, endpoint: `https://${id}.example/v1`, priority: 1, enabled: true, proxyPool: 'none', modelIds: [`model-${id}`] }, { type: 'api-key', value: 'key' });
    registry.register(adapter(id, seen, { waitForAbort: true }));
  }
  await connections.save({ id: 'conn-judge', providerId: 'judge', name: 'judge', endpoint: 'https://judge.example/v1', priority: 1, enabled: true, proxyPool: 'none', modelIds: ['model-judge'] }, { type: 'api-key', value: 'key' });
  registry.register(adapter('judge', seen));
  const virtual = new InMemoryVirtualModelStore();
  await virtual.save({ id: 'oh/fuse', strategy: 'fusion', judgeModel: 'model-judge', targets: ids.map((id) => ({ connectionId: `conn-${id}`, upstreamModelId: `model-${id}` })) });
  const service = new GatewayService(registry, connections, connections, new InMemoryApiKeyStore(), { virtualModels: virtual });
  service.setHealthInterval(0);
  const controller = new AbortController();
  const pending = service.chatWithFailover(request('oh/fuse'), undefined, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(() => pending);
  assert.equal(seen.length, 3, 'all three panel members received the abort');
  for (const entry of seen) assert.equal(entry.signal?.aborted, true, `${entry.id} kept running after the client left`);
});

test('smart and fusion leave no prompt or response field in UsageRecord', async (t) => {
  const forbidden = ['prompt', 'response', 'messages', 'content', 'text', 'answer', 'body', 'headers', 'toolNames'];
  for (const strategy of ['smart', 'fusion']) {
    const env = await setup({ strategy });
    const key = (await env.apiKeys.create(`usage-${strategy}`)).key;
    const server = createGatewayServer(env.service, { corsOrigin: 'http://localhost:5173' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(env.request),
    });
    assert.equal(response.status, 200, `${strategy} did not answer over HTTP`);
    await response.json();
    const records = await env.usage.list();
    assert.ok(records.length >= 1, `${strategy} wrote no usage record`);
    for (const record of records) {
      for (const field of forbidden) assert.equal(field in record, false, `${strategy} usage leaked ${field}`);
      assert.ok(record.requestId, 'a request id is recorded');
    }
  }
});
