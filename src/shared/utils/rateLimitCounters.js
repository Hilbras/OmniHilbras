// What the rate limiter did.
//
// The limiter itself lives in src/sse/services/rateLimit.js: it decides who may
// call what and answers 429/503 when the answer is no. A rejection used to
// leave no trace beyond a console warning, and the request never reached a
// provider, so no usage row existed either — an operator whose agent suddenly
// gets 429s had nothing to look at.
//
// This module records what the limiter did, so it can be seen: how much an
// identity spent in the last minute, what it was allowed, and how often it was
// turned away.
//
// Deliberately dependency-free (like rateLimitBucket.js): the service layer
// writes to it and the dashboard reads from it.
//
// What it never stores: the key. The identity is the scope the limiter already
// uses — "key:<uuid>" for a known key, "key:<hash>" for an unknown one,
// "ip:<ip>" otherwise — plus the key's id and name. The plaintext secret stops
// at the limiter.

const WINDOW_SECONDS = 60;
const WINDOW_MS = WINDOW_SECONDS * 1000;
// An identity that stops calling is forgotten: the map must not grow with
// every key a client ever tried.
const ENTRY_TTL_MS = 15 * 60_000;
// Enough identities for a busy install; the least recently seen goes first.
const MAX_ENTRIES = 512;

// The dimensions a request can be turned away on. The fan-out budget is spent
// in the handlers, not in the limiter, but it is the same answer to the client.
export const REJECTION_DIMENSIONS = ["requests", "tokens", "concurrency", "fanout", "error"];

// scope → entry
const counters = new Map();
// A monotonic counter, so two identities seen in the same millisecond still have
// a defined order.
let sequence = 0;

function createEntry(scope) {
  const now = Date.now();
  return {
    scope,
    keyId: null,
    keyName: null,
    // A sliding window of one second slots. A slot belongs to the second its
    // `second` field names, so a slot that has rolled over counts as zero.
    requests: new Array(WINDOW_SECONDS).fill(0),
    tokens: new Array(WINDOW_SECONDS).fill(0),
    seconds: new Array(WINDOW_SECONDS).fill(0),
    rejections: { requests: 0, tokens: 0, concurrency: 0, fanout: 0, error: 0 },
    admitted: 0,
    rejected: 0,
    firstSeen: now,
    lastSeen: now,
    sequence: ++sequence,
  };
}

function getEntry(scope, meta) {
  let entry = counters.get(scope);
  if (!entry) {
    entry = createEntry(scope);
    counters.set(scope, entry);
  }
  if (meta?.keyId !== undefined && meta.keyId !== null) entry.keyId = meta.keyId;
  if (meta?.keyName) entry.keyName = meta.keyName;
  entry.lastSeen = Date.now();
  return entry;
}

// Drop the entries that have not been seen for a while, and the ones that do
// not fit any more. Called on every write: it is O(n) over a bounded map.
function evict(now) {
  for (const [scope, entry] of counters) {
    if (now - entry.lastSeen > ENTRY_TTL_MS) counters.delete(scope);
  }
  while (counters.size > MAX_ENTRIES) {
    let oldestScope = null;
    let oldestSeen = Infinity;
    for (const [scope, entry] of counters) {
      if (entry.lastSeen < oldestSeen) {
        oldestSeen = entry.lastSeen;
        oldestScope = scope;
      }
    }
    if (!oldestScope) break;
    counters.delete(oldestScope);
  }
}

// Add to the sliding window. The slot of the current second is reset first if
// it belongs to an older second.
function addToWindow(entry, seconds, requests, tokens) {
  const index = ((seconds % WINDOW_SECONDS) + WINDOW_SECONDS) % WINDOW_SECONDS;
  if (entry.seconds[index] !== seconds) {
    entry.seconds[index] = seconds;
    entry.requests[index] = 0;
    entry.tokens[index] = 0;
  }
  entry.requests[index] += requests;
  entry.tokens[index] += tokens;
}

function sumWindow(entry, field, nowSeconds) {
  const oldest = nowSeconds - (WINDOW_SECONDS - 1);
  let total = 0;
  for (let i = 0; i < WINDOW_SECONDS; i++) {
    const second = entry.seconds[i];
    if (second < oldest || second > nowSeconds) continue;
    total += entry[field][i];
  }
  return total;
}

/**
 * Record an admitted request.
 *
 * @param {string} scope - the identity scope ("key:<uuid>", "ip:<ip>")
 * @param {{requests?: number, tokens?: number, keyId?: string, keyName?: string}} meta
 */
export function recordSpend(scope, meta = {}) {
  if (!scope) return;
  const now = Date.now();
  const entry = getEntry(scope, meta);
  const requests = Number(meta.requests) > 0 ? Number(meta.requests) : 0;
  const tokens = Number(meta.tokens) > 0 ? Number(meta.tokens) : 0;
  addToWindow(entry, Math.floor(now / 1000), requests, tokens);
  entry.admitted += requests;
  evict(now);
}

/**
 * Record a request that was turned away.
 *
 * @param {string} scope - the identity scope
 * @param {"requests"|"tokens"|"concurrency"|"fanout"|"error"} dimension
 * @param {{keyId?: string, keyName?: string}} meta
 */
export function recordRejection(scope, dimension, meta = {}) {
  if (!scope) return;
  if (!REJECTION_DIMENSIONS.includes(dimension)) return;
  const now = Date.now();
  const entry = getEntry(scope, meta);
  entry.rejections[dimension] += 1;
  entry.rejected += 1;
  evict(now);
}

/**
 * What one identity did, as the dashboard shows it.
 * @returns {object|null} null when the identity is unknown.
 */
export function getCounterSnapshot(scope) {
  const entry = counters.get(scope);
  if (!entry) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    scope: entry.scope,
    keyId: entry.keyId,
    keyName: entry.keyName,
    requestsPerMinute: sumWindow(entry, "requests", nowSeconds),
    tokensPerMinute: sumWindow(entry, "tokens", nowSeconds),
    admitted: entry.admitted,
    rejected: entry.rejected,
    rejections: { ...entry.rejections },
    firstSeen: entry.firstSeen,
    lastSeen: entry.lastSeen,
    sequence: entry.sequence,
  };
}

/**
 * Every identity the limiter has seen, most recently active first.
 * @returns {object[]}
 */
export function getCounterList() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const list = [];
  for (const entry of counters.values()) {
    list.push({
      scope: entry.scope,
      keyId: entry.keyId,
      keyName: entry.keyName,
      requestsPerMinute: sumWindow(entry, "requests", nowSeconds),
      tokensPerMinute: sumWindow(entry, "tokens", nowSeconds),
      admitted: entry.admitted,
      rejected: entry.rejected,
      rejections: { ...entry.rejections },
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      sequence: entry.sequence,
    });
  }
  list.sort((a, b) => b.lastSeen - a.lastSeen || b.sequence - a.sequence);
  return list;
}

/** Drop every counter (tests, and a settings change that must not leak). */
export function resetCounters() {
  counters.clear();
}

/** The number of identities the limiter is tracking. */
export function getCounterCount() {
  return counters.size;
}
