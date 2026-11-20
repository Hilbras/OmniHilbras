import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalConnectionStore, quotaTierOrder } from '../dist/src/core/connections.js';
import { HealthRegistry, resolveRoute } from '../dist/src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Quota tiers (Phase 6) let a cheap/free account wait behind a paid one when both can serve the same model.
// Auto-fallback already exists through health ejection + failover; this adds the *preference* order.
// Combos need no new type here: a virtual model (Kernel/API/src/core/virtual-models.ts) already resolves one
// id to an ordered, strategy-driven list of connections, which is exactly a combo.

function connection(id, tier, priority = 1) {
  return {
    id,
    providerId: id,
    name: id,
    endpoint: 'https://example.invalid/v1',
    priority,
    proxyPool: 'none',
    enabled: true,
    hasCredential: true,
    modelIds: ['shared/model'],
    ...(tier === undefined ? {} : { quotaTier: tier }),
    resilience: {},
  };
}

const health = new HealthRegistry(() => Date.now(), 30_000, 300_000);
const route = (connections) => resolveRoute({ connections, connectionsModel: 'shared/model', model: 'shared/model', health, failureThreshold: 3 }).candidates.map((c) => c.connectionId);

test('tier order is paid, cheap, free — matching the fallback ladder', () => {
  assert.deepEqual(quotaTierOrder, { paid: 0, cheap: 1, free: 2 });
});

test('a paid account is preferred over cheap and free regardless of name', () => {
  const order = route([connection('z-free', 'free'), connection('m-paid', 'paid'), connection('a-cheap', 'cheap')]);
  assert.deepEqual(order, ['m-paid', 'a-cheap', 'z-free']);
});

test('priority still breaks ties inside a tier', () => {
  const order = route([connection('b-paid', 'paid', 5), connection('a-paid', 'paid', 1)]);
  assert.deepEqual(order, ['a-paid', 'b-paid']);
});

test('a record with no tier keeps its old placement (sorts as paid)', () => {
  const order = route([connection('z-legacy', undefined), connection('a-paid', 'paid')]);
  assert.deepEqual(order.slice(0, 2).sort(), ['a-paid', 'z-legacy']);
  const withCheap = route([connection('z-cheap', 'cheap'), connection('a-legacy', undefined)]);
  assert.deepEqual(withCheap, ['a-legacy', 'z-cheap']);
});

test('quotaTier survives a save and a store reopen, and an invalid tier is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tier-'));
  try {
    const store = new LocalConnectionStore({ directory: dir });
    await store.save({ id: 'acct', providerId: 'fake', name: 'Acct', endpoint: 'https://example.invalid/v1', priority: 1, proxyPool: 'none', quotaTier: 'cheap', modelIds: ['m'], credential: { type: 'none' } }, { type: 'none' });
    const reopened = new LocalConnectionStore({ directory: dir });
    const record = (await reopened.list()).find((entry) => entry.id === 'acct');
    assert.equal(record?.quotaTier, 'cheap');
    await assert.rejects(
      store.save({ id: 'bad', providerId: 'fake', name: 'Bad', endpoint: 'https://example.invalid/v1', priority: 1, proxyPool: 'none', quotaTier: 'platinum', modelIds: ['m'], credential: { type: 'none' } }, { type: 'none' }),
      /Quota tier/,
    );
    // `in` would accept inherited Object keys ('constructor', '__proto__') as a tier. Object.hasOwn must refuse.
    await assert.rejects(
      store.save({ id: 'proto', providerId: 'fake', name: 'Proto', endpoint: 'https://example.invalid/v1', priority: 1, proxyPool: 'none', quotaTier: 'constructor', modelIds: ['m'], credential: { type: 'none' } }, { type: 'none' }),
      /Quota tier/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
