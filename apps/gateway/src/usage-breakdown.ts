import { requestCostUsd, type PriceableUsage } from './usage-pricing.js';
import type { UsageOutcome } from './usage-store.js';

/**
 * The aggregates behind the usage page's charts, computed from the records the store already holds.
 *
 * ## Why this is a separate, pure module
 *
 * The page needs three shapes the totals object cannot give: a group per provider, a group per model, and a
 * time series. All three are arithmetic over the same records the totals are summed from, and all three must
 * obey the same honesty rules — otherwise a chart and the card above it can disagree about the same window,
 * which is the most confusing thing a usage page can do.
 *
 * Pure and separate so the rules are testable without a gateway: no store, no clock except one passed in, no
 * I/O. `resolveUsagePeriod` is exported because the route needs the same window it filters the store with,
 * and two approximations of "the last 7 days" is exactly how a card and a chart drift apart.
 *
 * ## The rule carried over from the totals
 *
 * A record whose provider reported no tokens contributes **nothing** to a token sum and increments
 * `tokensMeasured` by zero — so a group with `tokensMeasured: 0` is an absence, and the page renders `—`
 * rather than `0`. The same for cost: a record with no published price is counted in `unpricedRequests` and
 * adds no dollars, so a group with `pricedRequests: 0` must be labelled "Not priced", never `$0`.
 */

export const usagePeriods = ['today', '24h', '7d', '30d', '60d', 'all'] as const;

export type UsagePeriod = (typeof usagePeriods)[number];

export type UsageBreakdownRecord = PriceableUsage & {
  at: string;
  model: string;
  /** Absent when no provider was reached, which is a real state and gets its own group. */
  providerId?: string;
  outcome: UsageOutcome;
};

/** One row of `byProvider` / `byModel`, or one bucket of the timeline. */
export type UsageGroup = {
  requests: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  /** Records in this group that reported tokens. Zero means the sums are an absence, not a measured zero. */
  tokensMeasured: number;
  costUsd: number;
  /** Records that could be priced. Zero with a non-zero `requests` means "no published price". */
  pricedRequests: number;
  unpricedRequests: number;
};

export type UsageProviderGroup = UsageGroup & { id: string };
export type UsageModelGroup = UsageGroup & { model: string; lastUsed: string };
export type UsageTimelinePoint = UsageGroup & { label: string; bucketStart: string };

export type UsageBreakdown = {
  period: UsagePeriod;
  /** The window actually applied, or absent for `all`. The page states its charts cover this. */
  since?: string;
  byProvider: UsageProviderGroup[];
  byModel: UsageModelGroup[];
  timeline: UsageTimelinePoint[];
};

/**
 * A period resolved to a start instant and a bucket size.
 *
 * `today` is local midnight because the gateway runs on the operator's own machine and "today" means their
 * day. `all` has no start — it is bounded by what the store retains.
 */
export function resolveUsagePeriod(period: UsagePeriod, now: Date): { since?: Date; bucket: 'hour' | 'day' } {
  switch (period) {
    case 'today': {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      return { since: midnight, bucket: 'hour' };
    }
    case '24h':
      return { since: new Date(now.getTime() - 24 * 3_600_000), bucket: 'hour' };
    case '7d':
      return { since: new Date(now.getTime() - 7 * 86_400_000), bucket: 'day' };
    case '30d':
      return { since: new Date(now.getTime() - 30 * 86_400_000), bucket: 'day' };
    case '60d':
      return { since: new Date(now.getTime() - 60 * 86_400_000), bucket: 'day' };
    case 'all':
      return { bucket: 'day' };
  }
}

/** A bucket key and the label a chart axis shows for it. */
function bucketOf(at: Date, bucket: 'hour' | 'day'): { key: string; label: string; start: Date } {
  const start = new Date(at);
  if (bucket === 'hour') {
    start.setMinutes(0, 0, 0);
    const label = `${String(start.getHours()).padStart(2, '0')}:00`;
    return { key: start.toISOString(), label, start };
  }
  start.setHours(0, 0, 0, 0);
  const label = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { key: start.toISOString(), label, start };
}

/** Steps a bucket start forward by one bucket. */
function nextBucket(start: Date, bucket: 'hour' | 'day'): Date {
  return new Date(start.getTime() + (bucket === 'hour' ? 3_600_000 : 86_400_000));
}

/**
 * The most buckets a timeline will draw, so an `all` window with sparse history cannot produce an axis of
 * thousands of empty points. Past this the oldest buckets are dropped; the window is a tail either way.
 */
const maxTimelineBuckets = 366;

function emptyGroup(): UsageGroup {
  return {
    requests: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    inputTokens: 0,
    outputTokens: 0,
    tokensMeasured: 0,
    costUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
  };
}

/** Folds one record into a group. The token and cost rules live here and nowhere else. */
function addToGroup(group: UsageGroup, record: UsageBreakdownRecord): void {
  group.requests += 1;
  if (record.outcome === 'success') group.succeeded += 1;
  else if (record.outcome === 'failure') group.failed += 1;
  else group.cancelled += 1;

  if (record.inputTokens !== undefined || record.outputTokens !== undefined) {
    group.tokensMeasured += 1;
    group.inputTokens += record.inputTokens ?? 0;
    group.outputTokens += record.outputTokens ?? 0;
  }

  const cost = requestCostUsd(record);
  if (cost === undefined) group.unpricedRequests += 1;
  else {
    group.costUsd = Math.round((group.costUsd + cost) * 1e6) / 1e6;
    group.pricedRequests += 1;
  }
}

/**
 * Builds the three aggregates over the records given. The caller has already applied the window filter (via
 * the store query using the same `resolveUsagePeriod`), so no record here is re-filtered — but the timeline
 * is padded with empty buckets across the window so a gap reads as a gap rather than as missing time.
 */
export function buildUsageBreakdown(
  records: readonly UsageBreakdownRecord[],
  options: { period: UsagePeriod; now?: Date },
): UsageBreakdown {
  const now = options.now ?? new Date();
  const { since, bucket } = resolveUsagePeriod(options.period, now);

  const providerGroups = new Map<string, UsageProviderGroup>();
  const modelGroups = new Map<string, UsageModelGroup>();
  for (const record of records) {
    const id = record.providerId ?? 'unattributed';
    let provider = providerGroups.get(id);
    if (!provider) {
      provider = { id, ...emptyGroup() };
      providerGroups.set(id, provider);
    }
    addToGroup(provider, record);

    let model = modelGroups.get(record.model);
    if (!model) {
      model = { model: record.model, lastUsed: record.at, ...emptyGroup() };
      modelGroups.set(record.model, model);
    }
    addToGroup(model, record);
    if (record.at > model.lastUsed) model.lastUsed = record.at;
  }

  // The timeline spans the window. Its start is the window's, or the oldest record for `all`; its end is the
  // newest record's bucket or now, whichever is later, so the current bucket is always present.
  const bucketMap = new Map<string, UsageTimelinePoint>();
  const ensure = (start: Date): UsageTimelinePoint => {
    const { key, label } = bucketOf(start, bucket);
    let point = bucketMap.get(key);
    if (!point) {
      point = { label, bucketStart: key, ...emptyGroup() };
      bucketMap.set(key, point);
    }
    return point;
  };
  for (const record of records) {
    const at = Date.parse(record.at);
    if (Number.isNaN(at)) continue;
    addToGroup(ensure(new Date(at)), record);
  }

  const newest = records.reduce((latest, record) => {
    const at = Date.parse(record.at);
    return Number.isNaN(at) ? latest : Math.max(latest, at);
  }, Number.NEGATIVE_INFINITY);
  const end = new Date(Math.max(now.getTime(), Number.isFinite(newest) ? newest : now.getTime()));
  const oldest = records.reduce((earliest, record) => {
    const at = Date.parse(record.at);
    return Number.isNaN(at) ? earliest : Math.min(earliest, at);
  }, Number.POSITIVE_INFINITY);
  const start = since ?? (Number.isFinite(oldest) ? new Date(oldest) : now);

  // Every bucket in the span exists, so a quiet hour draws as zero rather than collapsing the axis.
  const timeline: UsageTimelinePoint[] = [];
  for (let cursor = bucketOf(start, bucket).start; cursor.getTime() <= end.getTime(); cursor = nextBucket(cursor, bucket)) {
    timeline.push(ensure(cursor));
    if (timeline.length > maxTimelineBuckets) break;
  }
  // A window with no records still gets its current bucket, so the axis is not empty on a fresh gateway.
  if (timeline.length === 0) timeline.push(ensure(end));

  return {
    period: options.period,
    ...(since ? { since: since.toISOString() } : {}),
    byProvider: [...providerGroups.values()].sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id)),
    byModel: [...modelGroups.values()].sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model)),
    // Oldest first: a chart reads left to right in time.
    timeline: timeline.slice(-maxTimelineBuckets).sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)),
  };
}