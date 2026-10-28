import { EventEmitter } from "events";
import { getAdapter, getAdapterSync } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { DEFAULT_WORKSPACE_ID } from "../constants.js";
import { getMeta, setMeta } from "../helpers/metaStore.js";
import { chargeTokens, keyIdentity } from "@/shared/utils/rateLimitBucket.js";
import { maskApiKey } from "../helpers/maskApiKey.js";
import { getInternalApiKey } from "@/lib/auth/internalKey.js";

// One masking rule for the whole app: the key table, the usage tables, the
// dashboard and the CLI all show a key through this function.
export { maskApiKey };

const PENDING_TIMEOUT_MS = 60 * 1000;
// Safety net for a client slot that is never released (client vanished
// mid-stream). Longer than the upstream total timeout (30 min) so a legitimate
// long stream keeps its slot for the whole run.
const CLIENT_PENDING_TIMEOUT_MS = 35 * 60 * 1000;
const RING_CAP = 50;
const CONN_CACHE_TTL_MS = 30 * 1000;
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

// The write buffer: a completed request is recorded in memory and written
// with the next batch. Writing per request re-serialised the whole daily
// roll-up blob every time (measured: 4 ms for a 180 KiB day, 43 ms for a
// 1.2 MiB day) — the price of a gateway with a busy day.
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_FLUSH_MAX_ROWS = 200;
// The daily roll-up is written on its own cadence.
//
// The day blob is a read-modify-write of a whole day: parsing and serialising
// it cost 4 ms for a 180 KiB day and 43 ms for a 1.2 MiB day. A batch of rows
// amortised that — but a slow trickle of one request every few seconds did
// not: every request paid for the whole day.
//
// So the rows and the roll-up are written separately. The rows go as they
// always did (every 250 ms); the day blob goes every ROLLUP_FLUSH_INTERVAL_MS
// with everything that accumulated since the last time. The readers merge the
// pending delta, so the dashboard sees no gap — and the roll-up can always be
// rebuilt from the rows, which are written immediately.
const DEFAULT_ROLLUP_FLUSH_INTERVAL_MS = 30_000;

function envInt(name, fallback) {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const USAGE_FLUSH_INTERVAL_MS = envInt("USAGE_FLUSH_INTERVAL_MS", DEFAULT_FLUSH_INTERVAL_MS);
const USAGE_FLUSH_MAX_ROWS = envInt("USAGE_FLUSH_MAX_ROWS", DEFAULT_FLUSH_MAX_ROWS);
const USAGE_ROLLUP_FLUSH_INTERVAL_MS = envInt(
  "USAGE_ROLLUP_FLUSH_INTERVAL_MS",
  DEFAULT_ROLLUP_FLUSH_INTERVAL_MS,
);

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
// Client-scoped in-flight counters live next to the upstream ones so both
// survive a hot reload together.
if (!global._pendingRequests.client) global._pendingRequests.client = { total: 0, byScope: {} };
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._clientPendingTimers) global._clientPendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };
if (!global._usageWriteBuffer) {
  global._usageWriteBuffer = { items: [], timer: null, flushing: null };
}
// The roll-up buffer: the day aggregates that are not written into the day
// blob yet. It holds what the rows contributed since the last roll-up flush.
if (!global._usageRollupBuffer) {
  global._usageRollupBuffer = { days: new Map(), timer: null, flushing: null };
}

const pendingRequests = global._pendingRequests;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const clientPendingTimers = global._clientPendingTimers;
const recentRing = global._recentRing;
const connCache = global._connectionMapCache;
const statsEmitTimers = global._statsEmitTimers;
const usageBuffer = global._usageWriteBuffer;
const rollupBuffer = global._usageRollupBuffer;

// The in-memory buffers belong to the database that is open. A new adapter
// means a new database file — a fresh install, a restored backup, a test that
// replaces the file — and the rows buffered for the old one must not be
// written into the new one. The driver calls this when it opens a database.
global._usageResetBuffers = () => {
  usageBuffer.items = [];
  clearUsageFlushTimer();
  rollupBuffer.days = new Map();
  clearUsageRollupFlushTimer();
};

export const statsEmitter = global._statsEmitter;

function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    // Key by connectionId|model|provider (same convention as byApiKey/byEndpoint)
    // so a connection that used several models keeps one accurate row per model
    // instead of one collapsed row whose label is whatever came last.
    const byAccountKey = `${entry.connectionId}|${entry.model}|${entry.provider || "unknown"}`;
    addToCounter(day.byAccount, byAccountKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

function pushToRing(entry) {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

// A day with nothing in it — the shape the daily roll-up starts from.
function emptyDayAggregate() {
  return {
    requests: 0, promptTokens: 0, completionTokens: 0, cost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
  };
}

// A buffered request in the shape of a usageHistory row, so the readers can
// treat it like one.
function usageEntryToRow(entry) {
  const tokens = entry.tokens || {};
  return {
    timestamp: entry.timestamp,
    provider: entry.provider || null,
    model: entry.model || null,
    connectionId: entry.connectionId || null,
    apiKey: entry.apiKey || null,
    endpoint: entry.endpoint || null,
    promptTokens: tokens.prompt_tokens || tokens.input_tokens || 0,
    completionTokens: tokens.completion_tokens || tokens.output_tokens || 0,
    cost: entry.cost || 0,
    status: entry.status || "ok",
    tokens,
  };
}

// Add the days of the requests that are not written yet to the days the
// chart reads.
function mergePendingDays(dayMap, pendingDays) {
  for (const [dateKey, day] of pendingDays) {
    const existing = dayMap[dateKey];
    if (!existing) {
      dayMap[dateKey] = day;
      continue;
    }
    existing.requests = (existing.requests || 0) + (day.requests || 0);
    existing.promptTokens = (existing.promptTokens || 0) + (day.promptTokens || 0);
    existing.completionTokens = (existing.completionTokens || 0) + (day.completionTokens || 0);
    existing.cachedTokens = (existing.cachedTokens || 0) + (day.cachedTokens || 0);
    existing.cost = (existing.cost || 0) + (day.cost || 0);
  }
}

// The requests that are recorded but not written yet. The readers merge them,
// so the dashboard sees a request the moment it completes and not when the
// next batch lands.
function pendingUsageSnapshot() {
  return usageBuffer.items.slice();
}

function pendingRowsFrom(items) {
  return items.map((item) => usageEntryToRow(item.entry));
}

// The same aggregation the flush writes to usageDaily, so the numbers a
// reader sees before the flush are the numbers the flush will store.
function pendingDaysFrom(items) {
  const days = new Map();
  for (const item of items) {
    const entry = item.entry;
    const dateKey = getLocalDateKey(entry.timestamp);
    let day = days.get(dateKey);
    if (!day) {
      day = emptyDayAggregate();
      days.set(dateKey, day);
    }
    aggregateEntryToDay(day, entry);
  }
  return days;
}

// A copy of a day aggregate, so a reader cannot change the buffer it reads.
function cloneDayAggregate(day) {
  const clone = { ...day };
  for (const group of ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint"]) {
    if (!day[group]) continue;
    clone[group] = {};
    for (const [key, counter] of Object.entries(day[group])) {
      clone[group][key] = { ...counter };
    }
  }
  return clone;
}

/**
 * The days a reader must add on top of the stored blobs.
 *
 * Two sets, and they are disjoint: the requests that are recorded but not
 * written yet (not in the rows table either), and the day aggregates that are
 * in the rows table but not yet merged into the day blob. They add up.
 */
function pendingDaysForReaders(items) {
  const days = pendingDaysFrom(items);
  for (const [dateKey, delta] of rollupBuffer.days) {
    const existing = days.get(dateKey);
    if (!existing) {
      days.set(dateKey, cloneDayAggregate(delta));
      continue;
    }
    mergeDayAggregate(existing, delta);
  }
  return days;
}

async function getConnectionMapCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const all = await getProviderConnections();
    const map = {};
    for (const c of all) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`, [RING_CAP]);
    recentRing.items = rows.reverse().map((r) => ({
      timestamp: r.timestamp, provider: r.provider, model: r.model, connectionId: r.connectionId,
      apiKey: r.apiKey, endpoint: r.endpoint, cost: r.cost, status: r.status,
      tokens: parseJson(r.tokens, {}),
    }));
  } catch {}
}

async function calculateCost(provider, model, tokens) {
  if (!tokens || !provider || !model) return 0;
  try {
    const { getPricingForModel } = await import("./pricingRepo.js");
    const pricing = await getPricingForModel(provider, model);
    if (!pricing) return 0;

    // Delegate the actual math to the single source of truth (avoids the two
    // copies drifting apart — see open-sse/providers/pricing.js for the
    // cache-inclusive prompt_tokens convention this assumes).
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    return calculateCostFromTokens(tokens, pricing);
  } catch (e) {
    console.error("Error calculating cost:", e);
    return 0;
  }
}

// Per-connection totals over a recent window, straight from usageHistory.
// Feeds the quota tracker's "local history" fallback for providers whose
// upstream exposes no usage API: we show what this router observed itself.
export async function getUsageTotalsForConnection(connectionId, durationMs = 30 * 86400000) {
  if (!connectionId) return null;
  try {
    const db = await getAdapter();
    const since = new Date(Date.now() - durationMs).toISOString();
    const row = db.get(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(promptTokens), 0) AS promptTokens,
              COALESCE(SUM(completionTokens), 0) AS completionTokens,
              COALESCE(SUM(cost), 0) AS cost
       FROM usageHistory WHERE connectionId = ? AND timestamp >= ?`,
      [connectionId, since],
    );
    let requests = row?.requests || 0;
    let tokens = (row?.promptTokens || 0) + (row?.completionTokens || 0);
    let cost = row?.cost || 0;
    // The requests that are recorded but not written yet count as well.
    for (const r of pendingRowsFrom(pendingUsageSnapshot())) {
      if (r.connectionId !== connectionId) continue;
      if (r.timestamp < since) continue;
      requests += 1;
      tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      cost += r.cost || 0;
    }
    if (!(requests > 0)) return null;
    return {
      windowMs: durationMs,
      requests,
      tokens,
      cost,
    };
  } catch (e) {
    console.error("getUsageTotalsForConnection failed:", e.message);
    return null;
  }
}

export function trackPendingRequest(model, provider, connectionId, started, error = false) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(0, pendingRequests.byModel[modelKey] + (started ? 1 : -1));
  if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];

  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey]) pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(0, pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1));
    if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
      delete pendingRequests.byAccount[connectionId][modelKey];
      if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
        delete pendingRequests.byAccount[connectionId];
      }
    }
  }

  if (started) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0;
      if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
        pendingRequests.byAccount[connectionId][modelKey] = 0;
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
  } else {
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  // [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
  scheduleStatsEvent("pending");
}

/**
 * Client-scoped in-flight counter — the granularity the gateway's concurrency
 * cap needs.
 *
 * trackPendingRequest() above counts UPSTREAM calls per model/account, which
 * is the wrong unit for a client bound: one client request can fan out into
 * many upstream calls, and each of them holds a buffered request body (up to
 * 128 MB). This counts CLIENT requests in flight, globally and per scope
 * (the API key id, or the peer-IP bucket when no key was presented).
 *
 * Same in-memory pattern and same global as the upstream counter, so both
 * survive a hot reload together and the dashboard can show both.
 */
export function trackClientRequest(scope, started) {
  const client = pendingRequests.client;
  const key = scope || "unknown";

  if (started) {
    client.total += 1;
    client.byScope[key] = (client.byScope[key] || 0) + 1;
    clearTimeout(clientPendingTimers[key]);
    clientPendingTimers[key] = setTimeout(() => {
      delete clientPendingTimers[key];
      // Safety net: a client that vanished mid-stream must not hold its slot
      // forever. Release every slot of this scope (same shape as the upstream
      // counter's auto-reset).
      const leaked = client.byScope[key] || 0;
      if (leaked > 0) {
        client.byScope[key] = 0;
        client.total = Math.max(0, client.total - leaked);
      }
      scheduleStatsEvent("pending");
    }, CLIENT_PENDING_TIMEOUT_MS);
    clientPendingTimers[key]?.unref?.();
  } else {
    client.total = Math.max(0, client.total - 1);
    client.byScope[key] = Math.max(0, (client.byScope[key] || 0) - 1);
    if (client.byScope[key] === 0) delete client.byScope[key];
    clearTimeout(clientPendingTimers[key]);
    delete clientPendingTimers[key];
  }

  scheduleStatsEvent("pending");
}

/** Current client-scoped in-flight counts (global total + per scope). */
/**
 * The in-flight request counters (per model and per account).
 *
 * Cheap: they live in memory. The dashboard shows them next to the live
 * requests, and the usage stream pushes them — it must not have to compute
 * the whole statistics to show that something is running.
 */
export function getPendingRequests() {
  return {
    byModel: { ...pendingRequests.byModel },
    byAccount: { ...pendingRequests.byAccount },
  };
}

export function getClientRequestCounts() {
  const client = pendingRequests.client;
  return { total: client.total, byScope: { ...client.byScope } };
}

export async function getActiveRequests() {
  const activeRequests = [];
  const connectionMap = await getConnectionMapCached();

  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  await ensureRingInitialized();
  const seen = new Set();
  const recentRequests = [...recentRing.items]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => {
      const t = e.tokens || {};
      return {
        timestamp: e.timestamp, model: e.model, provider: e.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        status: e.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const errorProvider = (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "";
  return { activeRequests, recentRequests, errorProvider };
}

export async function saveRequestUsage(entry) {
  try {
    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    entry.cost = await calculateCost(entry.provider, entry.model, entry.tokens);

    const tokens = entry.tokens || {};
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;

    // Charge the generated tokens to the client's rate-limit token bucket.
    // The prompt size was only an estimate when the request was admitted; the
    // completion is only known now. A request that never went through the
    // limiter (local CLI traffic, limiter switched off) has no bucket, so this
    // is a no-op for it.
    if (entry.apiKey && completionTokens > 0) {
      try {
        chargeTokens(keyIdentity(entry.apiKey), completionTokens);
      } catch {
        // Rate accounting must never break usage recording.
      }
    }

    // From here on the key is stored as its display form: the usage tables
    // must not hand out a working credential either. The charge above used
    // the raw key, so the rate-limit bucket still belongs to that key.
    if (entry.apiKey) entry.apiKey = maskApiKey(entry.apiKey);

    // The row goes into the buffer and is written with the next batch. The
    // call resolves as soon as the row is recorded: the request path fires and
    // forgets, and a caller that awaits must not wait a whole flush interval
    // per row. The row is not lost — the readers merge the pending rows, and
    // the prune flushes before it deletes anything.
    usageBuffer.items.push({ entry, resolve: () => {} });

    // The in-memory path stays immediate: the ring and the readers show the
    // request before the batch lands.
    pushToRing(entry);
    scheduleStatsEvent("update", 250);

    scheduleUsageFlush();
    if (usageBuffer.items.length >= USAGE_FLUSH_MAX_ROWS) {
      clearUsageFlushTimer();
      flushUsage().catch((e) => console.error("[usageRepo] usage flush failed:", e));
    }
  } catch (e) {
    console.error("Failed to save usage stats:", e);
  }
}

// ─── The write batch ───────────────────────────────────────────────────────

function clearUsageFlushTimer() {
  if (!usageBuffer.timer) return;
  clearTimeout(usageBuffer.timer);
  usageBuffer.timer = null;
}

function scheduleUsageFlush() {
  if (usageBuffer.timer) return;
  usageBuffer.timer = setTimeout(() => {
    usageBuffer.timer = null;
    flushUsage().catch((e) => console.error("[usageRepo] usage flush failed:", e));
  }, USAGE_FLUSH_INTERVAL_MS);
  usageBuffer.timer.unref?.();
}

/**
 * Write one batch: the history rows and the lifetime counter, in ONE
 * transaction. The daily roll-up is accumulated into the roll-up buffer and
 * written on its own cadence (see flushUsageRollup).
 *
 * @param {object} db - the database adapter
 * @param {object[]} entries - the recorded requests
 * @returns {number} how many rows were stored
 */
function writeUsageBatch(db, entries) {
  let inserted = 0;
  const duplicates = [];

  db.transaction(() => {
    const days = new Map();

    for (const entry of entries) {
      const tokens = entry.tokens || {};
      const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
      const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;

      // Idempotency guard: the same request recorded twice is stored once.
      const existing = db.get(
        `SELECT id, endpoint FROM usageHistory
         WHERE timestamp = ?
           AND COALESCE(provider, '') = COALESCE(?, '')
           AND COALESCE(model, '') = COALESCE(?, '')
           AND COALESCE(connectionId, '') = COALESCE(?, '')
           AND COALESCE(apiKey, '') = COALESCE(?, '')
           AND promptTokens = ?
           AND completionTokens = ?
         ORDER BY id DESC LIMIT 1`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null,
          promptTokens, completionTokens,
        ]
      );

      if (existing) {
        if (!existing.endpoint && entry.endpoint) {
          db.run(`UPDATE usageHistory SET endpoint = ? WHERE id = ?`, [entry.endpoint, existing.id]);
        }
        duplicates.push(entry);
        continue;
      }

      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, workspaceId) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null, entry.endpoint || null,
          promptTokens, completionTokens, entry.cost || 0, entry.status || "ok",
          stringifyJson(tokens), stringifyJson({}),
          entry.workspaceId || "default",
        ]
      );
      inserted++;

      const dateKey = getLocalDateKey(entry.timestamp);
      const dayEntries = days.get(dateKey);
      if (dayEntries) dayEntries.push(entry);
      else days.set(dateKey, [entry]);
    }

    // The day aggregates wait for the roll-up flush: the blob is a whole day,
    // and rewriting it per batch is what made a trickle of requests expensive.
    for (const [dateKey, dayEntries] of days) {
      let day = rollupBuffer.days.get(dateKey);
      if (!day) {
        day = emptyDayAggregate();
        rollupBuffer.days.set(dateKey, day);
      }
      for (const entry of dayEntries) aggregateEntryToDay(day, entry);
    }

    // Atomic counter increment in same transaction
    if (inserted > 0) {
      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + inserted;
      db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);
    }
  });

  // A request that turned out to be a duplicate is not a new one: it does not
  // belong in the recent-requests ring.
  for (const entry of duplicates) {
    const idx = recentRing.items.indexOf(entry);
    if (idx >= 0) recentRing.items.splice(idx, 1);
  }

  return inserted;
}

/**
 * Write the buffered rows.
 *
 * A failed write is loud and the rows go back into the buffer: a usage row
 * is never dropped. The promise of a recorded request resolves when its row
 * is durable.
 *
 * @returns {Promise<number>} how many rows were written
 */
export async function flushUsage() {
  if (usageBuffer.flushing) {
    // One batch at a time — wait for the running one.
    await usageBuffer.flushing;
  }

  const run = (async () => {
    let items = [];
    try {
      if (!usageBuffer.items.length) return 0;
      const db = await getAdapter();
      // The rows leave the buffer and enter the table in one go: a reader
      // never sees a request in neither place.
      items = usageBuffer.items.splice(0, usageBuffer.items.length);
      if (!items.length) return 0;
      const inserted = writeUsageBatch(db, items.map((item) => item.entry));
      // The day aggregate waits for its own flush.
      if (rollupBuffer.days.size) scheduleUsageRollupFlush();
      for (const item of items) item.resolve(inserted);
      return items.length;
    } catch (e) {
      console.error("[usageRepo] usage flush failed, retrying on the next tick:", e);
      // The rows go back into the buffer: a usage row is never dropped.
      usageBuffer.items = items.concat(usageBuffer.items);
      return 0;
    }
  })();

  usageBuffer.flushing = run;
  try {
    return await run;
  } finally {
    if (usageBuffer.flushing === run) usageBuffer.flushing = null;
    if (usageBuffer.items.length) scheduleUsageFlush();
  }
}

// The rows of the buffer, written synchronously.
function flushUsageRowsSync() {
  if (!usageBuffer.items.length) return 0;

  const items = usageBuffer.items.splice(0, usageBuffer.items.length);
  try {
    const db = getAdapterSync();
    const inserted = writeUsageBatch(db, items.map((item) => item.entry));
    if (rollupBuffer.days.size) scheduleUsageRollupFlush();
    for (const item of items) item.resolve(inserted);
    return items.length;
  } catch (e) {
    console.error("[usageRepo] usage flush on shutdown failed:", e);
    // Put the rows back — a later hook may still write them.
    usageBuffer.items = items.concat(usageBuffer.items);
    return 0;
  }
}

// The exit handler cannot await, so the last write is done synchronously.
function flushUsageSync() {
  clearUsageFlushTimer();
  const written = flushUsageRowsSync();
  // The roll-up follows the rows: writing the rows is what creates the day
  // aggregate the roll-up merges into the blob.
  flushUsageRollupSync();
  return written;
}

/**
 * Write the daily roll-up.
 *
 * The day blob is a read-modify-write: the stored day is read, the delta that
 * accumulated since the last flush is merged into it, and the result is
 * written back. The delta leaves the buffer before the write, so a request
 * that arrives meanwhile lands in the next flush — nothing is lost and
 * nothing is counted twice.
 *
 * @returns {Promise<number>} how many days were written
 */
export async function flushUsageRollup() {
  if (rollupBuffer.flushing) {
    // One roll-up at a time — wait for the running one.
    await rollupBuffer.flushing;
  }

  const run = (async () => {
    if (!rollupBuffer.days.size) return 0;
    const db = await getAdapter();
    // The delta leaves the buffer now: what arrives while the write runs goes
    // into the next flush.
    const days = rollupBuffer.days;
    rollupBuffer.days = new Map();
    try {
      db.transaction(() => {
        for (const [dateKey, delta] of days) {
          const ws = delta.workspaceId || "default";
          const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ? AND workspaceId = ?`, [dateKey, ws]);
          const day = row ? parseJson(row.data, {}) : emptyDayAggregate();
          mergeDayAggregate(day, delta);
          db.run(
            `INSERT INTO usageDaily(dateKey, data, workspaceId) VALUES(?, ?, ?) ON CONFLICT(dateKey, workspaceId) DO UPDATE SET data = excluded.data`,
            [dateKey, stringifyJson(day), ws],
          );
        }
      });
      return days.size;
    } catch (e) {
      console.error("[usageRepo] usage roll-up flush failed, retrying on the next tick:", e);
      // The delta goes back: the roll-up is derived data, and losing it would
      // make the numbers smaller than the rows say.
      for (const [dateKey, delta] of days) {
        const pending = rollupBuffer.days.get(dateKey);
        if (pending) mergeDayAggregate(pending, delta);
        else rollupBuffer.days.set(dateKey, delta);
      }
      return 0;
    }
  })();

  rollupBuffer.flushing = run;
  try {
    return await run;
  } finally {
    if (rollupBuffer.flushing === run) rollupBuffer.flushing = null;
    if (rollupBuffer.days.size) scheduleUsageRollupFlush();
  }
}

// The exit handler cannot await, so the roll-up is written synchronously.
function flushUsageRollupSync() {
  clearUsageRollupFlushTimer();
  if (!rollupBuffer.days.size) return 0;
  const days = rollupBuffer.days;
  rollupBuffer.days = new Map();
  try {
    const db = getAdapterSync();
    db.transaction(() => {
      for (const [dateKey, delta] of days) {
        const ws = delta.workspaceId || DEFAULT_WORKSPACE_ID;
        const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ? AND workspaceId = ?`, [dateKey, ws]);
        const day = row ? parseJson(row.data, {}) : emptyDayAggregate();
        mergeDayAggregate(day, delta);
        db.run(
          `INSERT INTO usageDaily(dateKey, data, workspaceId) VALUES(?, ?, ?) ON CONFLICT(dateKey, workspaceId) DO UPDATE SET data = excluded.data`,
          [dateKey, stringifyJson(day), ws],
        );
      }
    });
    return days.size;
  } catch (e) {
    console.error("[usageRepo] usage roll-up flush on shutdown failed:", e);
    for (const [dateKey, delta] of days) {
      const pending = rollupBuffer.days.get(dateKey);
      if (pending) mergeDayAggregate(pending, delta);
      else rollupBuffer.days.set(dateKey, delta);
    }
    return 0;
  }
}

// Merge one day's delta into another day aggregate: the totals and the five
// groupings add up, and the bucket metadata is last-write-wins (as it was
// when the day was written in one go).
function mergeDayAggregate(target, delta) {
  target.requests = (target.requests || 0) + (delta.requests || 0);
  target.promptTokens = (target.promptTokens || 0) + (delta.promptTokens || 0);
  target.completionTokens = (target.completionTokens || 0) + (delta.completionTokens || 0);
  target.cachedTokens = (target.cachedTokens || 0) + (delta.cachedTokens || 0);
  target.cost = (target.cost || 0) + (delta.cost || 0);
  for (const group of ["byProvider", "byModel", "byAccount", "byApiKey", "byEndpoint"]) {
    const source = delta[group];
    if (!source) continue;
    if (!target[group]) target[group] = {};
    for (const [key, counter] of Object.entries(source)) {
      const existing = target[group][key];
      if (!existing) {
        target[group][key] = { ...counter };
        continue;
      }
      existing.requests = (existing.requests || 0) + (counter.requests || 0);
      existing.promptTokens = (existing.promptTokens || 0) + (counter.promptTokens || 0);
      existing.completionTokens = (existing.completionTokens || 0) + (counter.completionTokens || 0);
      existing.cachedTokens = (existing.cachedTokens || 0) + (counter.cachedTokens || 0);
      existing.cost = (existing.cost || 0) + (counter.cost || 0);
      // The metadata (model, provider, apiKey) is the same for both — it is
      // part of the bucket key — so the existing one stays.
    }
  }
}

function clearUsageRollupFlushTimer() {
  if (!rollupBuffer.timer) return;
  clearTimeout(rollupBuffer.timer);
  rollupBuffer.timer = null;
}

function scheduleUsageRollupFlush() {
  if (rollupBuffer.timer) return;
  rollupBuffer.timer = setTimeout(() => {
    rollupBuffer.timer = null;
    flushUsageRollup().catch((e) => console.error("[usageRepo] usage roll-up flush failed:", e));
  }, USAGE_ROLLUP_FLUSH_INTERVAL_MS);
  rollupBuffer.timer.unref?.();
}

// The synchronous flush is what the shutdown hooks call.
export const __test__ = { flushUsageSync, flushUsageRollupSync };

// The buffer must not outlive the process. The hooks are registered once:
// the signal handlers go first, because the database adapter closes itself
// on SIGTERM and exits right after. Every hook writes synchronously — the
// exit handlers cannot await, and the adapter is a synchronous driver.
if (!global._usageFlushShutdownHook) {
  const hook = () => {
    // The roll-up can be behind even when no row is pending: the rows are
    // written first, the day blob at its own cadence.
    if (usageBuffer.items.length || rollupBuffer.days.size) flushUsageSync();
  };
  global._usageFlushShutdownHook = hook;
  process.prependListener("SIGINT", hook);
  process.prependListener("SIGTERM", hook);
  process.on("beforeExit", hook);
  process.on("exit", hook);
}

export async function getUsageHistory(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  const workspaceId = filter.workspaceId || "default";
  conds.push("workspaceId = ?");
  params.push(workspaceId);

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ${where} ORDER BY id ASC`, params);

  // The requests that are recorded but not written yet — the dashboard must
  // see them without waiting for the next batch.
  const startDate = filter.startDate ? new Date(filter.startDate).toISOString() : null;
  const endDate = filter.endDate ? new Date(filter.endDate).toISOString() : null;
  for (const row of pendingRowsFrom(pendingUsageSnapshot())) {
    if (filter.provider && row.provider !== filter.provider) continue;
    if (filter.model && row.model !== filter.model) continue;
    if (startDate && row.timestamp < startDate) continue;
    if (endDate && row.timestamp > endDate) continue;
    rows.push(row);
  }

  return rows.map((r) => ({
    timestamp: r.timestamp, provider: r.provider, model: r.model,
    connectionId: r.connectionId, apiKeyMasked: maskApiKey(r.apiKey), endpoint: r.endpoint,
    cost: r.cost, status: r.status, tokens: parseJson(r.tokens, {}),
  }));
}

/**
 * Delete usage rows that fell out of the retention window.
 *
 * usageHistory grows one row per request and nothing ever deleted one, so a
 * long-running gateway accumulated rows without bound; the daily rollup
 * (usageDaily) grew one row per day forever. Both are pruned here, driven by
 * the retention settings (src/lib/db/repos/settingsRepo.js →
 * DEFAULT_SETTINGS.usageRetention).
 *
 * Fails open: a failed prune is logged and the caller carries on.
 *
 * @param {number} historyDays - Keep this many days of per-request rows.
 * @param {number} dailyDays - Keep this many days of the daily rollup.
 * @returns {Promise<{history: number, daily: number}|null>}
 */
export async function pruneUsageHistory(historyDays = 90, dailyDays = 400) {
  try {
    // The rows that are still in the buffer must land before the prune runs:
    // a row that is written after the delete would survive the window it was
    // recorded in. The same goes for the day aggregates that are not merged
    // into the blob yet.
    await flushUsage();
    await flushUsageRollup();
    const db = await getAdapter();
    const historyCutoff = new Date(Date.now() - historyDays * 86400000).toISOString();
    const dailyCutoff = getLocalDateKey(new Date(Date.now() - dailyDays * 86400000).toISOString());
    const removedHistory = db.run(`DELETE FROM usageHistory WHERE timestamp < ?`, [historyCutoff]);
    const removedDaily = db.run(`DELETE FROM usageDaily WHERE dateKey < ?`, [dailyCutoff]);
    return { history: removedHistory?.changes ?? 0, daily: removedDaily?.changes ?? 0 };
  } catch (e) {
    console.error("pruneUsageHistory failed:", e);
    return null;
  }
}

function loadDaysInRange(adapter, maxDays) {
  if (maxDays == null) {
    return adapter.all(`SELECT dateKey, data FROM usageDaily ORDER BY dateKey ASC`);
  }
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return adapter.all(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? ORDER BY dateKey ASC`, [cutoffKey]);
}

/**
 * Add one day of the daily roll-up to the stats.
 *
 * @param {object} stats - the stats being built
 * @param {string} dateKey - the day the roll-up belongs to
 * @param {object} day - the parsed daily roll-up row
 * @param {object} ctx - the name maps the keys are resolved with
 */
function accumulateDayStats(stats, dateKey, day, ctx) {
  const { connectionMap, providerNodeNameMap, apiKeyMap } = ctx;

  stats.totalPromptTokens += day.promptTokens || 0;
  stats.totalCompletionTokens += day.completionTokens || 0;
  stats.totalCachedTokens += day.cachedTokens || 0;
  stats.totalCost += day.cost || 0;

  for (const [prov, p] of Object.entries(day.byProvider || {})) {
    if (!stats.byProvider[prov]) stats.byProvider[prov] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
    stats.byProvider[prov].requests += p.requests || 0;
    stats.byProvider[prov].promptTokens += p.promptTokens || 0;
    stats.byProvider[prov].completionTokens += p.completionTokens || 0;
    stats.byProvider[prov].cachedTokens += p.cachedTokens || 0;
    stats.byProvider[prov].cost += p.cost || 0;
  }

  for (const [mk, m] of Object.entries(day.byModel || {})) {
    const rawModel = m.rawModel || mk.split("|")[0];
    const provider = m.provider || mk.split("|")[1] || "";
    const statsKey = provider ? `${rawModel} (${provider})` : rawModel;
    const providerDisplayName = providerNodeNameMap[provider] || provider;
    if (!stats.byModel[statsKey]) {
      stats.byModel[statsKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, lastUsed: dateKey };
    }
    stats.byModel[statsKey].requests += m.requests || 0;
    stats.byModel[statsKey].promptTokens += m.promptTokens || 0;
    stats.byModel[statsKey].completionTokens += m.completionTokens || 0;
    stats.byModel[statsKey].cachedTokens += m.cachedTokens || 0;
    stats.byModel[statsKey].cost += m.cost || 0;
    if (dateKey > (stats.byModel[statsKey].lastUsed || "")) stats.byModel[statsKey].lastUsed = dateKey;
  }

  for (const [entry, a] of Object.entries(day.byAccount || {})) {
    // New keys are `${connectionId}|${model}|${provider}`; legacy rows
    // (pre-rename DBs) stored the bare connectionId with last-write-wins
    // meta — keep rendering them with their stored meta.
    let connId = entry;
    let rawModel = a.rawModel || "";
    let provider = a.provider || "";
    if (entry.includes("|")) {
      const parts = entry.split("|");
      connId = parts[0];
      rawModel = parts[1] ?? rawModel;
      provider = parts[2] ?? provider;
    }
    const accountName = connectionMap[connId] || `Account ${connId.slice(0, 8)}...`;
    const providerDisplayName = providerNodeNameMap[provider] || provider;
    const accountKey = `${rawModel} (${provider} - ${accountName})`;
    if (!stats.byAccount[accountKey]) {
      stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, connectionId: connId, accountName, lastUsed: dateKey };
    }
    stats.byAccount[accountKey].requests += a.requests || 0;
    stats.byAccount[accountKey].promptTokens += a.promptTokens || 0;
    stats.byAccount[accountKey].completionTokens += a.completionTokens || 0;
    stats.byAccount[accountKey].cachedTokens += a.cachedTokens || 0;
    stats.byAccount[accountKey].cost += a.cost || 0;
    if (dateKey > (stats.byAccount[accountKey].lastUsed || "")) stats.byAccount[accountKey].lastUsed = dateKey;
  }

  for (const [akKey, ak] of Object.entries(day.byApiKey || {})) {
    const rawModel = ak.rawModel || "";
    const provider = ak.provider || "";
    const providerDisplayName = providerNodeNameMap[provider] || provider;
    const apiKeyVal = ak.apiKey ? ak.apiKey.trim() : null;
    const keyInfo = apiKeyVal ? apiKeyMap[apiKeyVal] : null;
    const apiKeyMasked = maskApiKey(apiKeyVal);
    const keyName = keyInfo?.name || (apiKeyVal ? (apiKeyMasked || apiKeyVal.slice(0, 8) + "...") : "Local (No API Key)");
    const apiKeyKey = apiKeyMasked || "local-no-key";
    if (!stats.byApiKey[akKey]) {
      stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey, lastUsed: dateKey };
    }
    stats.byApiKey[akKey].requests += ak.requests || 0;
    stats.byApiKey[akKey].promptTokens += ak.promptTokens || 0;
    stats.byApiKey[akKey].completionTokens += ak.completionTokens || 0;
    stats.byApiKey[akKey].cachedTokens += ak.cachedTokens || 0;
    stats.byApiKey[akKey].cost += ak.cost || 0;
    if (dateKey > (stats.byApiKey[akKey].lastUsed || "")) stats.byApiKey[akKey].lastUsed = dateKey;
  }

  for (const [epKey, ep] of Object.entries(day.byEndpoint || {})) {
    const endpoint = ep.endpoint || epKey.split("|")[0] || "Unknown";
    const rawModel = ep.rawModel || "";
    const provider = ep.provider || "";
    const providerDisplayName = providerNodeNameMap[provider] || provider;
    if (!stats.byEndpoint[epKey]) {
      stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel, provider: providerDisplayName, lastUsed: dateKey };
    }
    stats.byEndpoint[epKey].requests += ep.requests || 0;
    stats.byEndpoint[epKey].promptTokens += ep.promptTokens || 0;
    stats.byEndpoint[epKey].completionTokens += ep.completionTokens || 0;
    stats.byEndpoint[epKey].cachedTokens += ep.cachedTokens || 0;
    stats.byEndpoint[epKey].cost += ep.cost || 0;
    if (dateKey > (stats.byEndpoint[epKey].lastUsed || "")) stats.byEndpoint[epKey].lastUsed = dateKey;
  }
}

export async function getUsageStats(period = "all") {
  const db = await getAdapter();

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./apiKeysRepo.js"),
    import("./nodesRepo.js"),
  ]);

  let allConnections = [];
  try { allConnections = await getProviderConnections(); } catch {}
  const connectionMap = {};
  for (const c of allConnections) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodeNameMap = {};
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  let allApiKeys = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyMap = {};
  for (const k of allApiKeys) {
    // The usage rows hold the display form of a key, so the map is keyed by
    // it: a map keyed by the secret would resolve no usage row to a name.
    const id = maskApiKey(k.key);
    if (id) apiKeyMap[id] = { name: k.name, id: k.id, createdAt: k.createdAt };
  }
  // The app's own traffic runs on a key that is derived from the local
  // pepper and is deliberately not a row in apiKeys — name it so the usage
  // table does not show a bare display form.
  const internalId = maskApiKey(getInternalApiKey());
  if (internalId) apiKeyMap[internalId] = { name: "Local (internal)", id: null, createdAt: null };

  // The requests that are recorded but not written yet. The snapshot is taken
  // here — after the last await — so it and the rows read below are one
  // consistent view: the flush cannot run in between.
  const pendingItems = pendingUsageSnapshot();
  const pendingRows = pendingRowsFrom(pendingItems);
  const pendingDays = pendingDaysForReaders(pendingItems);

  // recentRequests from live history (last 100 entries enough for 20 deduped)
  const recentRows = [
    ...pendingRows,
    ...db.all(`SELECT timestamp, provider, model, tokens, status FROM usageHistory ORDER BY id DESC LIMIT 100`),
  ];
  const seen = new Set();
  const recentRequests = recentRows
    .map((r) => {
      const t = parseJson(r.tokens, {}) || {};
      return {
        timestamp: r.timestamp, model: r.model, provider: r.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        status: r.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCachedTokens: 0, totalCost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
    last10Minutes: [],
    pending: pendingRequests,
    activeRequests: [],
    recentRequests,
    errorProvider: (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "",
  };

  // Active requests
  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        stats.activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  // last10Minutes — query 10min window
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    stats.last10Minutes.push(bucketMap[ts]);
  }
  const recent10 = [
    ...pendingRows.filter((r) => r.timestamp >= tenMinutesAgo.toISOString() && r.timestamp <= now.toISOString()),
    ...db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
      [tenMinutesAgo.toISOString(), now.toISOString()]
    ),
  ];
  for (const r of recent10) {
    const tt = new Date(r.timestamp).getTime();
    const minuteStart = Math.floor(tt / 60000) * 60000;
    if (bucketMap[minuteStart]) {
      bucketMap[minuteStart].requests++;
      bucketMap[minuteStart].promptTokens += r.promptTokens || 0;
      bucketMap[minuteStart].completionTokens += r.completionTokens || 0;
      bucketMap[minuteStart].cost += r.cost || 0;
    }
  }

  const useDailySummary = period !== "24h" && period !== "today";

  if (useDailySummary) {
    const periodDays = { "7d": 7, "30d": 30, "60d": 60 };
    const maxDays = periodDays[period] || null;
    const dayRows = loadDaysInRange(db, maxDays);
    const ctx = { connectionMap, providerNodeNameMap, apiKeyMap };

    for (const dr of dayRows) {
      accumulateDayStats(stats, dr.dateKey, parseJson(dr.data, {}), ctx);
    }

    // The requests that are recorded but not written yet belong to their day
    // as well: the numbers are the ones the flush will store.
    for (const [dateKey, day] of pendingDays) {
      accumulateDayStats(stats, dateKey, day, ctx);
    }

    // Overlay precise lastUsed timestamps from history.
    // ponytail: overlay scans only a recent window; entries older than that keep
    // day-level lastUsed from usageDaily. Upgrade to a materialized per-key
    // MAX(timestamp) table if exact old timestamps ever matter.
    const OVERLAY_WINDOW_MS = 2 * 86400000;
    const overlayCutoff = Math.max(
      maxDays ? Date.now() - maxDays * 86400000 : 0,
      Date.now() - OVERLAY_WINDOW_MS
    );
    const histRows = [
      ...pendingRows.filter((r) => r.timestamp >= new Date(overlayCutoff).toISOString()),
      ...db.all(
        `SELECT timestamp, provider, model, connectionId, apiKey, endpoint FROM usageHistory WHERE timestamp >= ?`,
        [new Date(overlayCutoff).toISOString()]
      ),
    ];
    for (const e of histRows) {
      const ts = e.timestamp;
      const modelKey = e.provider ? `${e.model} (${e.provider})` : e.model;
      if (stats.byModel[modelKey] && new Date(ts) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = ts;

      if (e.connectionId) {
        const accountName = connectionMap[e.connectionId] || `Account ${e.connectionId.slice(0, 8)}...`;
        const accountKey = `${e.model} (${e.provider} - ${accountName})`;
        if (stats.byAccount[accountKey] && new Date(ts) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = ts;
      }

      const apiKeyKey = (e.apiKey && typeof e.apiKey === "string")
        ? `${e.apiKey}|${e.model}|${e.provider || "unknown"}`
        : "local-no-key";
      if (stats.byApiKey[apiKeyKey] && new Date(ts) > new Date(stats.byApiKey[apiKeyKey].lastUsed)) stats.byApiKey[apiKeyKey].lastUsed = ts;

      const endpoint = e.endpoint || "Unknown";
      const endpointKey = `${endpoint}|${e.model}|${e.provider || "unknown"}`;
      if (stats.byEndpoint[endpointKey] && new Date(ts) > new Date(stats.byEndpoint[endpointKey].lastUsed)) stats.byEndpoint[endpointKey].lastUsed = ts;
    }
  } else {
    // 24h / today: live history
    let cutoff;
    if (period === "today") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      cutoff = startOfDay.toISOString();
    } else {
      cutoff = new Date(Date.now() - PERIOD_MS["24h"]).toISOString();
    }
    const filtered = [
      ...pendingRows.filter((r) => r.timestamp >= cutoff),
      ...db.all(
        `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens FROM usageHistory WHERE timestamp >= ?`,
        [cutoff]
      ),
    ];

    for (const r of filtered) {
      const tokens = parseJson(r.tokens, {}) || {};
      const promptTokens = tokens.prompt_tokens || tokens.input_tokens || r.promptTokens || 0;
      const completionTokens = tokens.completion_tokens || tokens.output_tokens || r.completionTokens || 0;
      const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
      const entryCost = r.cost || 0;
      const providerDisplayName = providerNodeNameMap[r.provider] || r.provider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCachedTokens += cachedTokens;
      stats.totalCost += entryCost;

      if (!stats.byProvider[r.provider]) stats.byProvider[r.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
      stats.byProvider[r.provider].requests++;
      stats.byProvider[r.provider].promptTokens += promptTokens;
      stats.byProvider[r.provider].completionTokens += completionTokens;
      stats.byProvider[r.provider].cachedTokens += cachedTokens;
      stats.byProvider[r.provider].cost += entryCost;

      const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
      if (!stats.byModel[modelKey]) {
        stats.byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      stats.byModel[modelKey].requests++;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cachedTokens += cachedTokens;
      stats.byModel[modelKey].cost += entryCost;
      if (new Date(r.timestamp) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = r.timestamp;

      if (r.connectionId) {
        const accountName = connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
        const accountKey = `${r.model} (${r.provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, connectionId: r.connectionId, accountName, lastUsed: r.timestamp };
        }
        stats.byAccount[accountKey].requests++;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cachedTokens += cachedTokens;
        stats.byAccount[accountKey].cost += entryCost;
        if (new Date(r.timestamp) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = r.timestamp;
      }

      if (r.apiKey && typeof r.apiKey === "string") {
        const apiKeyVal = r.apiKey.trim();
        const keyInfo = apiKeyMap[apiKeyVal];
        const apiKeyMasked = maskApiKey(apiKeyVal);
        const keyName = keyInfo?.name || apiKeyMasked || r.apiKey.slice(0, 8) + "...";
        // Key by the FULL api key (same as the daily rollup + lastUsed overlay)
        // — masking here collided all keys sharing a prefix into one bucket.
        const akKey = `${r.apiKey}|${r.model}|${r.provider || "unknown"}`;
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey: apiKeyMasked, lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey[akKey];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      } else {
        if (!stats.byApiKey["local-no-key"]) {
          stats.byApiKey["local-no-key"] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked: null, keyName: "Local (No API Key)", apiKeyKey: "local-no-key", lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey["local-no-key"];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      }

      const endpoint = r.endpoint || "Unknown";
      const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byEndpoint[epKey]) {
        stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      const epe = stats.byEndpoint[epKey];
      epe.requests++; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens; epe.cost += entryCost;
      if (new Date(r.timestamp) > new Date(epe.lastUsed)) epe.lastUsed = r.timestamp;
    }
  }

  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
  return stats;
}

export async function getChartData(period = "7d") {
  const db = await getAdapter();
  const now = Date.now();

  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const endTime = startTime + bucketCount * bucketMs;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, requests: 0 }));

    const rows = [
      ...pendingRowsFrom(pendingUsageSnapshot()).filter((r) => {
        const t = new Date(r.timestamp).getTime();
        return t >= startTime && t < endTime;
      }),
      ...db.all(
        `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
        [new Date(startTime).toISOString()]
      ),
    ];
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t >= endTime) continue;
      const idx = Math.floor((t - startTime) / bucketMs);
      if (idx >= 0 && idx < bucketCount) {
        buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
        buckets[idx].cost += r.cost || 0;
        buckets[idx].requests += 1;
      }
    }
    return buckets;
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const startTime = now - bucketCount * bucketMs;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, requests: 0 }));

    const rows = [
      ...pendingRowsFrom(pendingUsageSnapshot()).filter((r) => {
        const t = new Date(r.timestamp).getTime();
        return t >= startTime && t <= now;
      }),
      ...db.all(
        `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
        [new Date(startTime).toISOString()]
      ),
    ];
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t > now) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      buckets[idx].cost += r.cost || 0;
      buckets[idx].requests += 1;
    }
    return buckets;
  }

  const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  if (period === "all") {
    const dayRows = loadDaysInRange(db, null);
    const pendingDays = pendingDaysForReaders(pendingUsageSnapshot());
    if (!dayRows.length && !pendingDays.size) return [];
    const dayMap = {};
    for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});
    mergePendingDays(dayMap, pendingDays);

    const firstKey = dayRows.length ? dayRows[0].dateKey : [...pendingDays.keys()].sort()[0];
    const earliest = new Date(firstKey + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.max(1, Math.round((today - earliest) / 86400000) + 1);

    return Array.from({ length: diffDays }, (_, i) => {
      const d = new Date(earliest);
      d.setDate(d.getDate() + i);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dayData = dayMap[dateKey];
      return {
        label: labelFn(d),
        tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
        cost: dayData ? (dayData.cost || 0) : 0,
        requests: dayData ? (dayData.requests || 0) : 0,
      };
    });
  }

  const bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const today = new Date();

  // Build map of dateKey → day data
  const dayRows = loadDaysInRange(db, bucketCount);
  const dayMap = {};
  for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});
  mergePendingDays(dayMap, pendingDaysForReaders(pendingUsageSnapshot()));

  return Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (bucketCount - 1 - i));
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = dayMap[dateKey];
    return {
      label: labelFn(d),
      tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
      cost: dayData ? (dayData.cost || 0) : 0,
      requests: dayData ? (dayData.requests || 0) : 0,
    };
  });
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Record a minimal request log row when no usage was captured (e.g. a stream
// that completed without a usage trailer). The row lands in usageHistory so
// getRecentLogs() sees it on read — previously this was a no-op and the
// request silently vanished from the log.
export async function appendRequestLog(entry = {}) {
  try {
    const db = await getAdapter();
    const tokens = entry.tokens || {};
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.timestamp || new Date().toISOString(),
        entry.provider || null,
        entry.model || null,
        entry.connectionId || null,
        null,
        null,
        tokens.prompt_tokens || tokens.input_tokens || 0,
        tokens.completion_tokens || tokens.output_tokens || 0,
        0,
        entry.status || "200 OK",
        stringifyJson(tokens),
        stringifyJson({}),
      ],
    );
  } catch (e) {
    console.error("Failed to append request log:", e);
  }
}

export async function getRecentLogs(limit = 200) {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    if (!rows.length && !usageBuffer.items.length) return [];

    const connMap = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo.js");
      const connections = await getProviderConnections();
      for (const c of connections) connMap[c.id] = c.name || c.email || "";
    } catch {}

    // The snapshot comes after the rows above: a request that was written in
    // between is in the rows already and must not be counted twice.
    const rowsWithPending = [
      ...pendingRowsFrom(pendingUsageSnapshot()),
      ...rows,
    ];

    return rowsWithPending.map((r) => {
      const ts = formatLogDate(new Date(r.timestamp));
      const p = r.provider?.toUpperCase() || "-";
      const m = r.model || "-";
      const account = connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson(r.tokens, {}) : {};
      const sent = r.promptTokens ?? tk.prompt_tokens ?? "-";
      const received = r.completionTokens ?? tk.completion_tokens ?? "-";
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${r.status || "-"}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e.message);
    return [];
  }
}
