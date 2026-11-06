import assert from 'node:assert/strict';
import test from 'node:test';
import { BeatApiAdapter } from '../beatapi/dist/adapter/index.js';

/**
 * BeatAPI's usage read — the reference project's own measurement, ported: `/v1/usage` reports the
 * account's USD credit balance (it may be negative), the task count and the concurrency limit. The
 * same parser also accepts the structured allowance shape its gateway family has since grown.
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

const OAUTH = { type: 'oauth', value: 'sk-key' };

test('quota reads /usage on the beatapi host', async () => {
  const transport = transportFor({ credit_balance: 3.5 });
  await new BeatApiAdapter({ transport }).quota({ credential: OAUTH });
  assert.equal(transport.calls[0].url, 'https://api.beatapi.io/v1/usage');
  assert.equal(transport.calls[0].method, 'GET');
});

test('a negative balance stays negative: it is a balance, not a quota that bottoms at zero', async () => {
  const transport = transportFor({ credit_balance: -0.75, concurrency: { limit: 2, active: 0 } });
  const quota = await new BeatApiAdapter({ transport }).quota({ credential: OAUTH });

  assert.deepEqual(quota.resources['Credit balance'], { used: 0, limit: -0.75, remaining: -0.75 });
  assert.deepEqual(quota.resources['Concurrent tasks'], { used: 0, limit: 2, remaining: 2 });
});

test('balance aliases resolve, because sibling hosts in this family rename the field', async () => {
  for (const [alias, value] of [['balance_usd', 9], ['balance', 9], ['remaining_balance', 9]]) {
    const transport = transportFor({ [alias]: value });
    const quota = await new BeatApiAdapter({ transport }).quota({ credential: OAUTH });
    assert.equal(quota.resources['Credit balance'].limit, 9, `${alias} resolves`);
  }
});

test('the structured allowance shape answers too, whichever the account serves', async () => {
  const transport = transportFor({ plan: 'free', allowance: 0, used: 0, remaining: 0, limits: { daily: null, weekly: null } });
  const quota = await new BeatApiAdapter({ transport }).quota({ credential: OAUTH });
  assert.deepEqual(quota.resources.Allowance, { used: 0, limit: 0, remaining: 0 });
  assert.equal(quota.plan, 'free');
});
