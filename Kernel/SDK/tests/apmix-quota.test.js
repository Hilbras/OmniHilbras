import assert from 'node:assert/strict';
import test from 'node:test';
import { ApmixAdapter } from '../apmix/dist/adapter/index.js';

/**
 * apmix's usage read.
 *
 * The allowance shape is dumped raw from the live account (2026-11): `plan`, `allowance`, `used`,
 * `remaining`, optional daily and weekly limits, and a key-level counter that has no ceiling and is
 * therefore not rendered. The balance shape is the reference's BeatAPI measurement of the same
 * gateway family: a USD credit balance with no ceiling, beside an optional concurrency cap.
 */

function transportFor(data) {
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      return { status: 200, headers: new Headers(), data };
    },
    async *stream() { throw new Error('not used'); },
  };
}

const OAUTH = { type: 'oauth', value: 'token-1' };

// The live body, verbatim.
const LIVE_ALLOWANCE = {
  object: 'usage',
  plan: 'free',
  allowance: 0,
  used: 0,
  remaining: 0,
  topup_remaining: 0,
  resets_at: null,
  limits: { daily: null, daily_used: 0, weekly: null, weekly_used: 0 },
  key: { name: 'z', usage_limit: null, used: 3062263, remaining: null },
};

test('quota reads /usage with the bearer token', async () => {
  const transport = transportFor(LIVE_ALLOWANCE);
  await new ApmixAdapter({ transport }).quota({ credential: OAUTH });
  assert.equal(transport.calls[0].url, 'https://api.apmix.ai/v1/usage');
  assert.equal(transport.calls[0].headers.Authorization, 'Bearer token-1');
  assert.equal(transport.calls[0].method, 'GET');
});

test('a zero allowance reads as the figures the provider stated, without an invented bar', async () => {
  const transport = transportFor(LIVE_ALLOWANCE);
  const quota = await new ApmixAdapter({ transport }).quota({ credential: OAUTH });

  assert.deepEqual(quota.resources.Allowance, { used: 0, limit: 0, remaining: 0 });
  assert.equal(quota.plan, 'free');
  // The key-level counter has no ceiling: a "3062263 of 0 left" row would be a lie, so it is absent.
  assert.deepEqual(Object.keys(quota.resources), ['Allowance']);
});

test('daily and weekly limits render as rows only when the provider states a cap', async () => {
  const transport = transportFor({
    plan: 'pro',
    allowance: 5000,
    used: 1200,
    remaining: 3800,
    resets_at: 1795124679,
    limits: { daily: 500, daily_used: 120, weekly: null, weekly_used: 0 },
  });
  const quota = await new ApmixAdapter({ transport }).quota({ credential: OAUTH });

  assert.deepEqual(quota.resources.Allowance, { used: 1200, limit: 5000, remaining: 3800, resetsAt: '2026-11-19T21:44:39.000Z' }, 'a numeric reset is Unix seconds, not milliseconds');
  assert.deepEqual(quota.resources['Daily limit'], { used: 120, limit: 500, remaining: 380, resetsAt: '2026-11-19T21:44:39.000Z' });
  assert.equal(quota.resources['Weekly limit'], undefined, 'a cap the provider leaves null is not a row that reads as exhausted');
});

test('the balance shape renders a wallet, and the concurrency cap renders beside it', async () => {
  // The reference's BeatAPI measurement: a USD credit balance with no ceiling.
  const transport = transportFor({ credit_balance: 12.5, concurrency: { limit: 4, active: 2 } });
  const quota = await new ApmixAdapter({ transport }).quota({ credential: OAUTH });

  assert.deepEqual(quota.resources['Credit balance'], { used: 0, limit: 12.5, remaining: 12.5 }, 'a balance is both limit and remaining; there is no ceiling to compare against');
  assert.deepEqual(quota.resources['Concurrent tasks'], { used: 2, limit: 4, remaining: 2 });
});

test('an empty body has no rows and the plan falls back to the provider\u2019s name', async () => {
  const transport = transportFor({});
  const quota = await new ApmixAdapter({ transport }).quota({ credential: OAUTH });
  assert.deepEqual(quota.resources, {});
  assert.equal(quota.plan, 'APMix');
});
