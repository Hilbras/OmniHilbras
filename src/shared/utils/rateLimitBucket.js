// Token buckets for the gateway's client-facing request limits.
//
// Deliberately dependency-free (only node:crypto): the SSE service layer owns
// the policy (which limits apply to which identity), this module owns only the
// bucket math. Keeping it free of app imports lets the DB layer charge a
// finished request's completion tokens back to the bucket without importing
// the service layer, which would be a cycle (service → DB → service).
//
// Buckets refill lazily: tokens accrue at capacity/minute and are capped at
// capacity, so a burst is allowed after a quiet period but the long-run rate
// never exceeds the configured per-minute ceiling.
import { createHash } from "node:crypto";

const MINUTE_MS = 60_000;

// identity → { requests: bucket, tokens: bucket }
const buckets = new Map();

/**
 * Stable, non-reversible identity for a presented API key.
 * The raw key never becomes a map key, so a heap dump or a stray debug log
 * cannot leak a credential.
 */
export function keyIdentity(apiKey) {
  const hash = createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 32);
  return `key:${hash}`;
}

/** Identity for a request that carried no key: the peer IP bucket. */
export function ipIdentity(ip) {
  return `ip:${ip || "unknown"}`;
}

function createBucket(capacity, tokens) {
  return { capacity, tokens, lastRefill: Date.now() };
}

/**
 * Fetch (or create) the bucket of one kind for one identity.
 * A capacity change (settings edited, per-key override applied) keeps the
 * already-spent amount instead of handing out a free refill.
 */
function getBucket(identity, kind, capacity) {
  let entry = buckets.get(identity);
  if (!entry) {
    entry = { requests: null, tokens: null };
    buckets.set(identity, entry);
  }
  const existing = entry[kind];
  if (!existing) {
    entry[kind] = createBucket(capacity, capacity);
    return entry[kind];
  }
  if (existing.capacity !== capacity) {
    const spent = Math.max(0, existing.capacity - existing.tokens);
    existing.capacity = capacity;
    existing.tokens = Math.max(0, capacity - spent);
    existing.lastRefill = Date.now();
  }
  return existing;
}

function refill(bucket, now) {
  if (!bucket || !(bucket.capacity > 0)) return;
  const elapsed = now - bucket.lastRefill;
  if (elapsed <= 0) return;
  const rate = bucket.capacity / MINUTE_MS;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * rate);
  bucket.lastRefill = now;
}

/**
 * Try to spend `count` request tokens.
 * A capacity of 0 (or less) means "no limit" — the bucket is not consulted.
 * @returns {{allowed: boolean, retryAfterMs: number}}
 */
export function spendRequests(identity, capacity, count = 1) {
  if (!(capacity > 0)) return { allowed: true, retryAfterMs: 0 };
  const bucket = getBucket(identity, "requests", capacity);
  const now = Date.now();
  refill(bucket, now);
  if (bucket.tokens < count) {
    const rate = bucket.capacity / MINUTE_MS;
    return {
      allowed: false,
      retryAfterMs: rate > 0 ? Math.ceil((count - bucket.tokens) / rate) : MINUTE_MS,
    };
  }
  bucket.tokens -= count;
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Try to spend `count` tokens from the token bucket.
 * Same "capacity 0 = unlimited" rule as spendRequests.
 * @returns {{allowed: boolean, retryAfterMs: number}}
 */
export function spendTokens(identity, capacity, count) {
  if (!(capacity > 0)) return { allowed: true, retryAfterMs: 0 };
  if (!(count > 0)) return { allowed: true, retryAfterMs: 0 };
  const bucket = getBucket(identity, "tokens", capacity);
  const now = Date.now();
  refill(bucket, now);
  if (bucket.tokens < count) {
    const rate = bucket.capacity / MINUTE_MS;
    return {
      allowed: false,
      retryAfterMs: rate > 0 ? Math.ceil((count - bucket.tokens) / rate) : MINUTE_MS,
    };
  }
  bucket.tokens -= count;
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Charge tokens to an already-open bucket (no-op when the identity has none).
 *
 * Used for the completion tokens of a request that was admitted earlier: the
 * prompt size is only known as an estimate at admission time, the generated
 * tokens are only known once the upstream answered. A request that never went
 * through the limiter (local CLI traffic, limiter switched off) has no bucket,
 * so nothing is charged.
 */
export function chargeTokens(identity, count) {
  if (!(count > 0)) return;
  const bucket = buckets.get(identity)?.tokens;
  if (!bucket) return;
  refill(bucket, Date.now());
  bucket.tokens = Math.max(0, bucket.tokens - count);
}

/** Current bucket state — used by tests and by the dashboard read-out. */
export function getBucketSnapshot(identity) {
  const entry = buckets.get(identity);
  if (!entry) return null;
  const snap = (b) => (b ? { capacity: b.capacity, tokens: Math.floor(b.tokens) } : null);
  return { requests: snap(entry.requests), tokens: snap(entry.tokens) };
}

/** Drop all bucket state (tests, and a settings change that must not leak). */
export function resetBuckets() {
  buckets.clear();
}
