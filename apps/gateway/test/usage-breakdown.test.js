import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUsageBreakdown, resolveUsagePeriod, usagePeriods } from '../dist/usage-breakdown.js';

/**
 * The usage page's charts are arithmetic over the same records its cards sum. These tests are about the two
 * ways that arithmetic can lie:
 *
 * 1. **A missing measurement shown as zero.** A record whose provider reported no tokens must not add a `0`
 *    to a token sum — it adds nothing and moves `tokensMeasured`, so a group of only such records reads as an
 *    absence. Same for cost: no published price is `unpricedRequests`, not `$0`.
 * 2. **A chart disagreeing with the card above it.** The breakdown is built from the same priced array the
 *    totals are, so a group's summed figures must equal the totals over the same records.
 */

/** A record with the fields the breakdown reads, so a test states only what it is about. */
function record(over = {}) {
  return {
    at: '2026-10-12T10:00:00.000Z',
    model: 'm',
    providerId: 'p',
    outcome: 'success',
    inputTokens: 100,
    outputTokens: 20,
    ...over,
  };
}

test('every period resolves to a window, and only `all` has none', () => {
  const now = new Date('2026-10-12T15:30:00.000Z');
  assert.equal(resolveUsagePeriod('all', now).since, undefined, 'all is bounded by the store, not by a date');
  for (const period of usagePeriods.filter((value) => value !== 'all')) {
    assert.ok(resolveUsagePeriod(period, now).since instanceof Date, `${period} must have a start`);
  }
  assert.equal(resolveUsagePeriod('24h', now).bucket, 'hour');
  assert.equal(resolveUsagePeriod('7d', now).bucket, 'day');
});

test('“today” starts at local midnight, so it is the operator’s day and not a rolling 24 hours', () => {
  const now = new Date('2026-10-12T15:30:00.000Z');
  const { since } = resolveUsagePeriod('today', now);
  assert.equal(since.getHours(), 0);
  assert.equal(since.getMinutes(), 0);
  assert.equal(since.getSeconds(), 0);
});

test('a group with no reported tokens is an absence, not a measured zero', () => {
  const breakdown = buildUsageBreakdown([
    record({ inputTokens: undefined, outputTokens: undefined, providerId: 'unmetered' }),
    record({ inputTokens: undefined, outputTokens: undefined, providerId: 'unmetered' }),
  ], { period: '7d' });
  const group = breakdown.byProvider.find((entry) => entry.id === 'unmetered');
  assert.equal(group.requests, 2);
  assert.equal(group.tokensMeasured, 0, 'nothing reported tokens, so nothing is measured');
  assert.equal(group.inputTokens, 0, 'the sum is zero and the page must read tokensMeasured to know why');
});

test('a mixed group sums only the records that reported tokens, and counts how many did', () => {
  const breakdown = buildUsageBreakdown([
    record({ providerId: 'p', inputTokens: 100, outputTokens: 10 }),
    record({ providerId: 'p', inputTokens: undefined, outputTokens: undefined }),
  ], { period: '7d' });
  const group = breakdown.byProvider.find((entry) => entry.id === 'p');
  assert.equal(group.requests, 2);
  assert.equal(group.tokensMeasured, 1, 'one of the two was measured');
  assert.equal(group.inputTokens, 100, 'the unmeasured record adds nothing rather than a zero');
  assert.equal(group.outputTokens, 10);
});

test('a request with no provider is its own group, never attributed to one that did not serve it', () => {
  const breakdown = buildUsageBreakdown([record({ providerId: undefined })], { period: '7d' });
  assert.deepEqual(breakdown.byProvider.map((group) => group.id), ['unattributed']);
});

test('a group with no published price is unpriced, not free', () => {
  const breakdown = buildUsageBreakdown([
    record({ providerId: 'unpriced', pricing: undefined }),
  ], { period: '7d' });
  const group = breakdown.byProvider.find((entry) => entry.id === 'unpriced');
  assert.equal(group.pricedRequests, 0);
  assert.equal(group.unpricedRequests, 1);
  assert.equal(group.costUsd, 0, 'zero dollars with zero priced requests means unknown');
});

test('a priced group reports its cost and priced count', () => {
  const pricing = { inputPer1M: 1, outputPer1M: 1 };
  const breakdown = buildUsageBreakdown([
    record({ providerId: 'priced', inputTokens: 1_000_000, outputTokens: 0, pricing }),
  ], { period: '7d' });
  const group = breakdown.byProvider.find((entry) => entry.id === 'priced');
  assert.equal(group.pricedRequests, 1);
  assert.equal(group.unpricedRequests, 0);
  assert.equal(group.costUsd, 1, '1,000,000 input tokens at $1 per 1M is $1');
});

test('the per-provider and per-model sums equal the totals over the same records', () => {
  const records = [
    record({ providerId: 'a', model: 'x', inputTokens: 100, outputTokens: 10 }),
    record({ providerId: 'b', model: 'y', inputTokens: 200, outputTokens: 20, outcome: 'failure' }),
    record({ providerId: 'a', model: 'y', inputTokens: 300, outputTokens: 30, outcome: 'cancelled' }),
  ];
  const breakdown = buildUsageBreakdown(records, { period: '7d' });
  // Stated explicitly rather than re-derived, so the test cannot agree with a bug in the code by sharing one.
  const expected = { requests: 3, succeeded: 1, failed: 1, cancelled: 1, inputTokens: 600, outputTokens: 60, tokensMeasured: 3 };
  const sum = (groups, field) => groups.reduce((total, group) => total + group[field], 0);
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(sum(breakdown.byProvider, field), value, `byProvider ${field} must match the totals`);
    assert.equal(sum(breakdown.byModel, field), value, `byModel ${field} must match the totals`);
  }
});

test('the timeline buckets hourly for a day and daily for a week, oldest first', () => {
  const hourly = buildUsageBreakdown([record({ at: '2026-10-12T10:00:00.000Z' })], { period: '24h', now: new Date('2026-10-12T12:00:00.000Z') });
  assert.ok(hourly.timeline.every((point) => /^\d{2}:00$/.test(point.label)), '24h buckets read as hours');
  const daily = buildUsageBreakdown([record({ at: '2026-10-12T10:00:00.000Z' })], { period: '7d', now: new Date('2026-10-12T12:00:00.000Z') });
  assert.ok(daily.timeline.every((point) => !/^\d{2}:00$/.test(point.label)), '7d buckets read as dates');
  const starts = daily.timeline.map((point) => point.bucketStart);
  assert.deepEqual(starts, [...starts].sort(), 'the timeline is oldest first, as a chart reads');
});

test('a window with no records still has its buckets, all at zero, so the axis is drawn and empty rather than absent', () => {
  const breakdown = buildUsageBreakdown([], { period: '7d', now: new Date('2026-10-12T12:00:00.000Z') });
  assert.equal(breakdown.byProvider.length, 0);
  assert.equal(breakdown.byModel.length, 0);
  // Seven days back plus today is eight daily buckets; the point is that the axis spans the window and every
  // bucket is zero, which a chart draws as a flat line rather than as nothing.
  assert.ok(breakdown.timeline.length >= 7, 'the window is spanned even with no records');
  assert.ok(breakdown.timeline.every((point) => point.requests === 0), 'every bucket is zero, none invented');
});

test('a gap in the middle of the window is a zero bucket, not a missing one', () => {
  const breakdown = buildUsageBreakdown([
    record({ at: '2026-10-10T09:00:00.000Z' }),
    record({ at: '2026-10-12T09:00:00.000Z' }),
  ], { period: '7d', now: new Date('2026-10-12T12:00:00.000Z') });
  const days = breakdown.timeline.map((point) => point.label);
  assert.equal(new Set(days).size, days.length, 'no duplicate buckets');
  assert.ok(breakdown.timeline.some((point) => point.requests === 0), 'the quiet day is present at zero');
});