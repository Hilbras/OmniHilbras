import assert from 'node:assert/strict';
import test from 'node:test';
import { createQoderAdapter } from '../qoder/dist/adapter/index.js';

/**
 * Qoder's quota read.
 *
 * The response is a credit pool, not a time window — absolute figures and the account's own type —
 * dumped raw from the live endpoint (2026-11) before this parser was written. The reference tree
 * advertised the endpoint and never consumed it, so there was no shape to copy and the live body is
 * the only ground truth there is.
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

const LIVE_QUOTA = {
  userId: '01a1772d-40f7-703a-a705-c3589412197f',
  userType: 'personal_standard',
  usageType: 'credits',
  totalUsagePercentage: 0.0,
  isQuotaExceeded: true,
  expiresAt: 253402214400000,
  upgradeUrl: 'https://qoder.com/pricing?client=qoder',
  userQuota: { total: 0.0, used: 0.0, remaining: 0.0, percentage: 0.0, unit: 'credits' },
  isPlanQuotaProrated: false,
};

test('quota reads /api/v2/quota/usage with the bearer token', async () => {
  const transport = transportFor(LIVE_QUOTA);
  const adapter = createQoderAdapter({ transport });

  const quota = await adapter.quota({ credential: OAUTH });

  assert.equal(transport.calls[0].url, 'https://openapi.qoder.sh/api/v2/quota/usage');
  assert.equal(transport.calls[0].headers.Authorization, 'Bearer token-1');
  assert.equal(transport.calls[0].method, 'GET');
});

test('the credit pool is carried as absolute figures, named for the vendor\u2019s unit', async () => {
  const transport = transportFor({ userType: 'personal_standard', userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' } });
  const quota = await createQoderAdapter({ transport }).quota({ credential: OAUTH });

  // A pool with nothing in it reads as empty, not as a fabricated percentage: the limit is 0, so the
  // panel draws no bar and states the figures the provider stated.
  assert.deepEqual(quota.resources.Credits, { used: 0, limit: 0, remaining: 0 });
  assert.equal(quota.plan, 'personal_standard');
});

test('a pool with figures reads as figures, and an absent remaining is derived', async () => {
  const transport = transportFor({ userType: 'enterprise', userQuota: { total: 1000, used: 350, unit: 'credits' } });
  const quota = await createQoderAdapter({ transport }).quota({ credential: OAUTH });

  assert.deepEqual(quota.resources.Credits, { used: 350, limit: 1000, remaining: 650 }, 'remaining absent upstream falls back to total - used, never to 0');
  assert.equal(quota.plan, 'enterprise');
});

test('a unit the vendor renames renames the row, and an unnamed plan falls back to the provider', async () => {
  const renamed = transportFor({ userQuota: { total: 10, used: 4, remaining: 6, unit: 'tokens' } });
  assert.deepEqual((await createQoderAdapter({ transport: renamed }).quota({ credential: OAUTH })).resources.Tokens, { used: 4, limit: 10, remaining: 6 });

  const unnamed = transportFor({ userQuota: { total: 1, used: 0, remaining: 1, unit: 'credits' } });
  assert.equal((await createQoderAdapter({ transport: unnamed }).quota({ credential: OAUTH })).plan, 'Qoder');
});
