import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendLedger } from '../dist/src/core/spend-ledger.js';
import { budgetWindow, evaluateBudget, usdToMicros } from '../dist/src/core/budgets.js';

async function tempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'omni-spend-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a day bucket is UTC, and a snapshot over a period sums only its own days', async (t) => {
  const directory = await tempDir(t);
  const ledger = new SpendLedger({ directory, flushDelayMs: 0 });
  await ledger.record({ scope: 'key', id: 'key_a', at: new Date('2026-11-25T23:59:59.000Z'), usdMicros: 1_000_000, inputTokens: 10, outputTokens: 20 });
  await ledger.record({ scope: 'key', id: 'key_a', at: new Date('2026-11-26T00:00:01.000Z'), usdMicros: 2_000_000, inputTokens: 30, outputTokens: 40 });

  const day = await ledger.snapshot('key', 'key_a', 'day', new Date('2026-11-26T12:00:00.000Z'));
  assert.equal(day.usdMicros, 2_000_000, 'the day window included yesterday');
  assert.equal(day.tokens, 70);

  const total = await ledger.snapshot('key', 'key_a', 'total', new Date('2026-11-26T12:00:00.000Z'));
  assert.equal(total.usdMicros, 3_000_000);
  assert.equal(total.requests, 2);
});

test('money survives a restart, and the window is computed from the date rather than a counter', async (t) => {
  const directory = await tempDir(t);
  const first = new SpendLedger({ directory, flushDelayMs: 0 });
  await first.record({ scope: 'key', id: 'key_a', at: new Date('2026-11-26T10:00:00.000Z'), usdMicros: usdToMicros(0.25) });
  await first.flush();

  const reopened = new SpendLedger({ directory, flushDelayMs: 0 });
  const snapshot = await reopened.snapshot('key', 'key_a', 'day', new Date('2026-11-26T18:00:00.000Z'));
  assert.equal(snapshot.usdMicros, 250_000);
  assert.equal(snapshot.requests, 1);
});

test('a hold is visible to the next request, and settlement releases it', async (t) => {
  const directory = await tempDir(t);
  const ledger = new SpendLedger({ directory, flushDelayMs: 0 });
  const at = new Date('2026-11-26T10:00:00.000Z');
  await ledger.hold({ scope: 'key', id: 'key_a', requestId: 'req_1', usdMicros: 500_000 });
  const held = await ledger.snapshot('key', 'key_a', 'day', at);
  assert.equal(held.heldUsdMicros, 500_000, 'a reservation is not visible to the next request');

  await ledger.record({ scope: 'key', id: 'key_a', requestId: 'req_1', at, usdMicros: 200_000 });
  const settled = await ledger.snapshot('key', 'key_a', 'day', at);
  assert.equal(settled.heldUsdMicros, 0, 'settlement left the hold behind');
  assert.equal(settled.usdMicros, 200_000);
});

test('an expired hold is released, and a lifetime budget has no reset time', async (t) => {
  const directory = await tempDir(t);
  let now = Date.parse('2026-11-26T10:00:00.000Z');
  const ledger = new SpendLedger({ directory, flushDelayMs: 0, now: () => now });
  await ledger.hold({ scope: 'key', id: 'key_a', requestId: 'req_old', usdMicros: 900_000, ttlMs: 1_000 });
  now += 5_000;
  const snapshot = await ledger.snapshot('key', 'key_a', 'day', new Date(now));
  assert.equal(snapshot.heldUsdMicros, 0, 'an expired hold still counted');

  assert.equal(budgetWindow('total').endMs, undefined);
  assert.equal(budgetWindow('day', new Date('2026-11-26T10:00:00.000Z')).endMs, Date.parse('2026-11-27T00:00:00.000Z'));
  assert.equal(budgetWindow('week', new Date('2026-11-26T10:00:00.000Z')).startMs, Date.parse('2026-11-23T00:00:00.000Z'), 'the week does not start on Monday UTC');
});

test('a budget refuses at the limit and reports the remaining amount', () => {
  const status = evaluateBudget(
    { usd: 1, period: 'day' },
    { usdMicros: usdToMicros(1), tokens: 0, heldUsdMicros: 0, requests: 4, unpricedRequests: 0 },
    new Date('2026-11-26T10:00:00.000Z'),
  );
  assert.equal(status.allowed, false);
  assert.equal(status.kind, 'usd');
  assert.equal(status.remainingUsdMicros, 0);
  assert.equal(status.resetAt, '2026-11-27T00:00:00.000Z');

  const tokenStatus = evaluateBudget(
    { tokens: 100, period: 'month' },
    { usdMicros: 0, tokens: 99, heldUsdMicros: 0, requests: 1, unpricedRequests: 0 },
    new Date('2026-11-26T10:00:00.000Z'),
  );
  assert.equal(tokenStatus.allowed, true, 'one request below the quota was refused');
  assert.equal(tokenStatus.remainingTokens, 1);

  const held = evaluateBudget(
    { usd: 1, period: 'day' },
    { usdMicros: usdToMicros(0.9), tokens: 0, heldUsdMicros: usdToMicros(0.1), requests: 1, unpricedRequests: 0 },
    new Date('2026-11-26T10:00:00.000Z'),
  );
  assert.equal(held.allowed, false, 'an in-flight reservation was not counted against the budget');
});
