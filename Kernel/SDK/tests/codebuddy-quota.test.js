import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodeBuddyAdapter } from '../codebuddy/dist/adapter/index.js';

/**
 * CodeBuddy's quota read.
 *
 * The billing meter answers a Tencent double-wrapped payload mixing two credit types that must not be
 * merged: refill packs (a recurring allowance whose live numbers live in the *Cycle* fields and whose
 * cycle resets long before the resource expires) and bonus packs (one-shot credits, lifetime Capacity
 * fields, expiry == cycle end). Shapes dumped raw from the live intl endpoint (2026-11).
 */

function transportFor(body) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      return { status: 200, headers: new Headers(), data: body };
    },
    async *stream() { throw new Error('not used'); },
  };
}

const OAUTH = { type: 'oauth', value: 'token-1' };

const wrap = (accounts) => ({ code: 0, msg: 'OK', data: { Response: { Data: { TotalCount: accounts.length, Accounts: accounts } } } });

// The live bonus pack, verbatim from the dump (trimmed to the fields the parser reads).
const LIVE_BONUS = {
  CapacityType: 1,
  CapacityUnit: 'credit',
  CycleStartTime: '2026-10-26 17:13:03',
  CycleEndTime: '2026-11-09 17:13:02',
  DeductionEndTime: 1794215582000,
  PackageName: 'Bonus Pack',
  CapacitySize: 250,
  CapacityUsed: 157,
  CapacityRemain: 92,
  CapacitySizePrecise: '250',
  CapacityRemainPrecise: '92.05',
  CapacityUsedPrecise: '157.95',
  TotalCycles: 1,
};

test('quota posts to the region\u2019s billing meter with the bearer token', async () => {
  const transport = transportFor(wrap([LIVE_BONUS]));
  const adapter = createCodeBuddyAdapter('intl', { transport });

  await adapter.quota({ credential: OAUTH });

  assert.equal(transport.calls[0].url, 'https://www.codebuddy.ai/v2/billing/meter/get-user-resource');
  assert.equal(transport.calls[0].method, 'POST');
  assert.equal(transport.calls[0].headers.Authorization, 'Bearer token-1');
  assert.equal(transport.calls[0].body, '{}');
});

test('a bonus pack reads its lifetime balance, named as a one-shot pack', async () => {
  const transport = transportFor(wrap([LIVE_BONUS]));
  const quota = await createCodeBuddyAdapter('intl', { transport }).quota({ credential: OAUTH });

  assert.deepEqual(quota.resources['Bonus Pack 1'], { used: 158, limit: 250, remaining: 92, resetsAt: '2026-11-09T17:13:02.000Z' });
  assert.equal(quota.plan, 'Bonus Pack');
});

test('a refill pack reads its cycle balance and is labelled by cadence, not mistaken for a bonus', async () => {
  // Cycle ends 2026-12-09 but the resource is valid to 2027-01-09 — a 31-day gap = a recurring refill,
  // so the live numbers come from the Cycle fields and the label comes from the cycle length.
  const refill = {
    PackageName: 'AI Code Assistant Monthly',
    CapacitySize: 500,
    CycleStartTime: '2026-11-09 17:13:03',
    CycleEndTime: '2026-12-09 17:13:02',
    DeductionEndTime: 1798803782000,
    CycleCapacitySize: 500,
    CycleCapacityUsed: 120,
    CycleCapacitySizePrecise: '500',
    CycleCapacityUsedPrecise: '120.5',
  };
  const transport = transportFor(wrap([refill]));
  const quota = await createCodeBuddyAdapter('cn', { transport }).quota({ credential: OAUTH });

  assert.deepEqual(quota.resources.Monthly, { used: 121, limit: 500, remaining: 379, resetsAt: '2026-12-09T17:13:02.000Z' });
  assert.equal(quota.plan, 'AI Code Assistant Monthly');
  // And the region reaches the CN host, not the intl one.
  assert.equal(transport.calls[0].url, 'https://copilot.tencent.com/v2/billing/meter/get-user-resource');
});

test('a refill and a bonus are two rows, never merged, bonus ordered soonest-expiring first', async () => {
  const soonBonus = { ...LIVE_BONUS, PackageName: 'Bonus Pack', CycleEndTime: '2026-11-09 17:13:02', DeductionEndTime: 1794215582000 };
  const laterBonus = { ...LIVE_BONUS, CapacitySizePrecise: '100', CapacityUsedPrecise: '10', CycleEndTime: '2026-12-09 17:13:02', DeductionEndTime: 1796807582000 };
  const refill = {
    PackageName: 'Monthly', CycleStartTime: '2026-11-09 17:13:03', CycleEndTime: '2026-12-09 17:13:02',
    DeductionEndTime: 1798803782000, CycleCapacitySize: 500, CycleCapacityUsed: 120,
  };
  const transport = transportFor(wrap([laterBonus, refill, soonBonus]));
  const quota = await createCodeBuddyAdapter('intl', { transport }).quota({ credential: OAUTH });

  assert.deepEqual(Object.keys(quota.resources), ['Monthly', 'Bonus Pack 1', 'Bonus Pack 2']);
  assert.equal(quota.resources['Bonus Pack 1'].limit, 250, 'the soonest-expiring bonus is first');
  assert.equal(quota.resources['Bonus Pack 2'].limit, 100);
  assert.equal(quota.resources.Monthly.limit, 500);
});

test('an error envelope refuses with the vendor\u2019s message, and an empty account has no rows', async () => {
  const errorTransport = transportFor({ code: 1305, msg: 'no active package' });
  await assert.rejects(
    () => createCodeBuddyAdapter('intl', { transport: errorTransport }).quota({ credential: OAUTH }),
    /no active package/,
  );

  const empty = transportFor(wrap([]));
  const quota = await createCodeBuddyAdapter('intl', { transport: empty }).quota({ credential: OAUTH });
  assert.deepEqual(quota.resources, {}, 'no credit packages means no rows, never zeros');
});
