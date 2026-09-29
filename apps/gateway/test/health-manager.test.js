import assert from 'node:assert/strict';
import test from 'node:test';
import { HealthManager } from '../dist/health.js';
import { ProviderError } from '@hilbras/omnihilbras';

/**
 * `HealthManager` on its own, with no routing, no connections and no network.
 *
 * This file is the point of the extraction rather than a consequence of it. Health used to be
 * reachable only through `GatewayService`, so testing it meant building a service with stores and
 * adapters — which is why it shipped with the faults it had: a sweep per HTTP request, and four
 * adapters reporting a verdict with no reason.
 */

const healthyAdapter = (id, latencyMs = 5) => ({
  id,
  name: id,
  capabilities: { chat: true, streaming: false, models: true },
  async healthCheck() { return { status: 'healthy', checkedAt: '2026-01-01T00:00:00.000Z', latencyMs }; },
});

const source = (adapters, contexts = {}) => {
  const asked = [];
  const probeSource = {
    asked,
    adapters: async () => { asked.push('adapters'); return adapters; },
    contextFor: async (id) => { asked.push(`context:${id}`); return contexts[id] ?? { credential: { type: 'api-key', value: 'k' } }; },
  };
  return probeSource;
};

test('a sweep reports every adapter, and one unhealthy makes the report degraded', async () => {
  const manager = new HealthManager(source([
    healthyAdapter('one'),
    { id: 'two', name: 'two', capabilities: {}, async healthCheck() { return { status: 'unavailable', checkedAt: '2026-01-01T00:00:00.000Z', message: 'the key was rejected' }; } },
  ]));
  const report = await manager.refresh();
  assert.equal(report.status, 'degraded');
  assert.equal(report.providers.length, 2);
  assert.deepEqual(report.providers.map((p) => p.providerId).sort(), ['one', 'two']);
});

test('the report is served from the last sweep rather than re-probing', async () => {
  // This is the fault that cost eight seconds per dashboard load. Probing every provider on every
  // `/health` also monopolised the browser's six-connection pool, so ordinary requests queued
  // behind health and a six-second chat turn took over a minute.
  let probes = 0;
  const manager = new HealthManager(source([{ id: 'one', name: 'one', capabilities: {}, async healthCheck() { probes += 1; return { status: 'healthy', checkedAt: '2026-01-01T00:00:00.000Z' }; } }]));
  await manager.report();
  await manager.report();
  await manager.report();
  assert.equal(probes, 1, 'three reports must not be three sweeps');
});

test('the report says when it was measured, so its age is visible', async () => {
  const manager = new HealthManager(source([healthyAdapter('one')]));
  const first = await manager.report();
  const second = await manager.report();
  assert.equal(first.checkedAt, second.checkedAt, 'a cached report is the same report');
  assert.ok(!Number.isNaN(Date.parse(first.checkedAt)));
});

test('concurrent callers share one sweep', async () => {
  // Without this, a page reload and the background timer landing together each start their own
  // set of probes — the same multiply-by-request that made the first version slow.
  let sweeps = 0;
  const manager = new HealthManager(source([{ id: 'one', name: 'one', capabilities: {}, async healthCheck() {
    sweeps += 1;
    await new Promise((r) => setTimeout(r, 5));
    return { status: 'healthy', checkedAt: '2026-01-01T00:00:00.000Z' };
  } }]));
  await Promise.all([manager.refresh(), manager.refresh(), manager.refresh()]);
  assert.equal(sweeps, 1, 'three concurrent refreshes must be one sweep');
});

test('an unhealthy result carries a reason, or it is not a result', async () => {
  // The reason is the whole point: "unavailable" cannot tell the user whether the key was
  // rejected, the endpoint was wrong, or the provider is down. Three different fixes.
  const manager = new HealthManager(source([{ id: 'one', name: 'one', capabilities: {}, async healthCheck() { return { status: 'unavailable', checkedAt: '2026-01-01T00:00:00.000Z' }; } }]));
  const report = await manager.refresh();
  assert.equal(report.providers[0].status, 'unavailable');
  assert.ok(report.providers[0].message, 'a verdict with no reason is a guess wearing a status');
});

test('a thrown check keeps the real cause instead of a generic failure', async () => {
  const manager = new HealthManager(source([{ id: 'one', name: 'one', capabilities: {}, async healthCheck() { throw new ProviderError('AUTHENTICATION_FAILED', 'That key was rejected by the provider.'); } }]));
  const report = await manager.refresh();
  assert.equal(report.providers[0].status, 'unavailable');
  assert.match(report.providers[0].message, /key was rejected/);
});

test('an adapter that cannot report health says so, rather than looking fine', async () => {
  const manager = new HealthManager(source([{ id: 'one', name: 'one', capabilities: {} }]));
  const report = await manager.refresh();
  assert.equal(report.providers[0].status, 'unavailable');
  assert.match(report.providers[0].message, /not supported/i);
});

test('a provider that is not connected is named, not reported unhealthy', async () => {
  // "This provider is down" and "you never connected it" are different problems, and the first
  // sends the user to fix a credential that was never the issue.
  const manager = new HealthManager(source([healthyAdapter('one')]));
  await assert.rejects(
    () => manager.forProvider('missing'),
    (error) => error.code === 'NOT_FOUND' && /no active connection for missing/.test(error.publicMessage),
  );
});

test('one provider can be checked without paying for the whole registry', async () => {
  let probes = 0;
  const counting = (id) => ({ id, name: id, capabilities: {}, async healthCheck() { probes += 1; return { status: 'healthy', checkedAt: '2026-01-01T00:00:00.000Z' }; } });
  const manager = new HealthManager(source([counting('one'), counting('two'), counting('three')]));
  const health = await manager.forProvider('two');
  assert.equal(health.providerId, 'two');
  assert.equal(probes, 1, 'asking about one provider must not probe the other two');
});

test('an unavailable answer is recorded as a failure, not a success', async () => {
  // Recording it as success made routing report a healthy provider with zero failures while
  // `/health` said unavailable, and it corrupted the counting that drives ejection.
  const manager = new HealthManager(source([{ id: 'one', name: 'one', capabilities: {}, async healthCheck() { return { status: 'unavailable', checkedAt: '2026-01-01T00:00:00.000Z', message: 'down' }; } }]));
  await manager.refresh();
  const snapshot = manager.snapshot('one');
  assert.ok(snapshot, 'a swept provider has a snapshot');
  assert.ok((snapshot.failures ?? 0) >= 1, 'an unavailable answer must count as a failure');
});

test('the probe is asked in a context carrying a credential', async () => {
  // Health checked without a credential reports the credential's absence, not the provider's
  // health — which is how a provider looks down when the only problem is a missing key.
  const probeSource = source([healthyAdapter('one')], { one: { credential: { type: 'api-key', value: 'real' } } });
  let seen;
  const manager = new HealthManager(probeSource);
  const original = probeSource.contextFor;
  probeSource.contextFor = async (id, signal) => { const c = await original(id, signal); seen = c; return c; };
  await manager.refresh();
  assert.deepEqual(seen?.credential, { type: 'api-key', value: 'real' });
  assert.ok(probeSource.asked.includes('context:one'), 'the manager asks for context per adapter');
});

test('background polling can be turned off with an interval of zero', () => {
  const manager = new HealthManager(source([]));
  manager.start(0);
  manager.stop();
  // Nothing to assert beyond not throwing: a timer that is still alive after `start(0)` is a
  // handle that keeps the process up and polls a gateway nobody asked it to poll.
});
