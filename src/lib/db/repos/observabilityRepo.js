import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

// Settings changes must take effect on the next write, not after the cache TTL.
export function invalidateObservabilityConfig() {
  cachedConfig = null;
  cachedConfigTs = 0;
}

// Export the old functions under their legacy names so nothing else breaks.
// Legacy names for backwards compatibility with lib/requestDetailsDb.js imports.
export function saveRequestDetail(detail) {
  return saveRequestDetails(detail);
}
export function getRequestDetails(filter) {
  return getRequestLogEntries(filter);
}
export function getDistinctProviders() {
  return getRequestLogProviders();
}
export function getRequestDetailById(id) {
  return getRequestLogDetailById(id);
}

// The dashboard toggle decides; OBSERVABILITY_ENABLED=false is an operator
// kill switch that forces recording off. ENABLE_REQUEST_LOGS is unrelated —
// it controls the file logs under logs/ (open-sse/utils/requestLogger.js).
export function isObservabilityForcedOff() {
  return process.env.OBSERVABILITY_ENABLED?.toLowerCase() === "false";
}

export async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    cachedConfig = {
      enabled: !isObservabilityForcedOff() && settings.enableObservability === true,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

export const __test__ = { sanitizeHeaders };

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getAdapter();
      const config = await getObservabilityConfig();

      db.transaction(() => {
        for (const item of items) {
          if (!item.id) item.id = generateDetailId(item.model);
          if (!item.timestamp) item.timestamp = new Date().toISOString();
          if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

          const record = {
            id: item.id,
            timestamp: item.timestamp,
            provider: item.provider || null,
            model: item.model || null,
            connectionId: item.connectionId || null,
            status: item.status || null,
            latency: item.latency || {},
            tokens: item.tokens || {},
            request: truncateField(item.request, config.maxJsonSize),
            providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
            providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
            response: truncateField(item.response, config.maxJsonSize),
            pxpipe: item.pxpipe || undefined,
          };

          db.run(
            `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
            [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record)]
          );
        }

        const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
        if (cnt && cnt.c > config.maxRecords) {
          db.run(
            `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
            [cnt.c - config.maxRecords]
          );
        }
      });
    }
  } catch (e) {
    console.error("[observabilityRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetails(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) {
    return;
  }

  writeBuffer.push(detail);

  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushToDatabase().catch((e) => console.error("[observabilityRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestLogEntries(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) {
    conds.push("provider = ?");
    params.push(filter.provider);
  }
  if (filter.model) {
    conds.push("model = ?");
    params.push(filter.model);
  }
  if (filter.connectionId) {
    conds.push("connectionId = ?");
    params.push(filter.connectionId);
  }
  if (filter.status) {
    conds.push("status = ?");
    params.push(filter.status);
  }
  if (filter.startDate) {
    conds.push("timestamp >= ?");
    params.push(new Date(filter.startDate).toISOString());
  }
  if (filter.endDate) {
    conds.push("timestamp <= ?");
    params.push(new Date(filter.endDate).toISOString());
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getRequestLogProviders() {
  const db = await getAdapter();
  const rows = db.all(`SELECT DISTINCT provider FROM requestDetails WHERE provider IS NOT NULL ORDER BY provider ASC`);
  return rows.map((r) => r.provider);
}

export async function getRequestLogDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

export async function deleteRequestLogById(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM requestDetails WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function deleteRequestLogBatch(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return 0;
  }
  const db = await getAdapter();
  const placeholders = ids.map(() => "?").join(",");
  const res = db.run(`DELETE FROM requestDetails WHERE id IN (${placeholders})`, ids);
  return res?.changes ?? 0;
}

export async function clearAllRequestLogs() {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM requestDetails`);
  return res?.changes ?? 0;
}

export async function getDistinctModels() {
  const db = await getAdapter();
  const rows = db.all(`SELECT DISTINCT model FROM requestDetails WHERE model IS NOT NULL ORDER BY model ASC`);
  return rows.map((r) => r.model);
}

export async function getDistinctConnections() {
  const db = await getAdapter();
  const rows = db.all(`SELECT DISTINCT connectionId FROM requestDetails WHERE connectionId IS NOT NULL ORDER BY connectionId ASC`);
  return rows.map((r) => r.connectionId);
}

export async function deleteRequestLogsBefore(date) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM requestDetails WHERE timestamp < ?`, [new Date(date).toISOString()]);
  return res?.changes ?? 0;
}

const STATS_PERIODS_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

// Aggregates over the stored log. The log is capped at maxRecords, so these
// describe the retained window, not lifetime traffic (that lives in usageRepo).
export async function getObservabilityStats(period = "24h") {
  const db = await getAdapter();
  const windowMs = STATS_PERIODS_MS[period];
  const since = windowMs ? new Date(Date.now() - windowMs).toISOString() : null;
  const where = since ? "WHERE timestamp >= ?" : "";
  const params = since ? [since] : [];

  const promptExpr = "COALESCE(json_extract(data, '$.tokens.prompt_tokens'), json_extract(data, '$.tokens.input_tokens'), 0)";
  const completionExpr = "COALESCE(json_extract(data, '$.tokens.completion_tokens'), json_extract(data, '$.tokens.output_tokens'), 0)";
  const latencyExpr = "json_extract(data, '$.latency.total')";
  const errorExpr = "CASE WHEN status = 'error' THEN 1 ELSE 0 END";

  const totals = db.get(
    `SELECT COUNT(*) AS requests, SUM(${errorExpr}) AS errors,
       SUM(${promptExpr}) AS promptTokens, SUM(${completionExpr}) AS completionTokens,
       AVG(${latencyExpr}) AS avgLatency, MIN(timestamp) AS firstAt, MAX(timestamp) AS lastAt
     FROM requestDetails ${where}`,
    params
  ) || {};

  const groupBy = (col) => db.all(
    `SELECT ${col} AS key, COUNT(*) AS requests, SUM(${errorExpr}) AS errors,
       SUM(${promptExpr}) + SUM(${completionExpr}) AS tokens, AVG(${latencyExpr}) AS avgLatency
     FROM requestDetails ${where} GROUP BY ${col} ORDER BY requests DESC LIMIT 20`,
    params
  ).map((r) => ({
    key: r.key || "unknown",
    requests: r.requests,
    errors: r.errors || 0,
    tokens: r.tokens || 0,
    avgLatency: Math.round(r.avgLatency || 0),
  }));

  const retained = db.get(`SELECT COUNT(*) AS c, MIN(timestamp) AS oldest FROM requestDetails`) || {};
  const config = await getObservabilityConfig();

  // Rates use the span actually covered by the rows, so a quiet hour inside a
  // 24h window does not read as a traffic drop.
  const requests = totals.requests || 0;
  const spanMs = totals.firstAt && totals.lastAt
    ? Math.max(new Date(totals.lastAt) - new Date(totals.firstAt), 60 * 1000)
    : 0;
  const minutes = spanMs / 60000;
  const tokens = (totals.promptTokens || 0) + (totals.completionTokens || 0);

  return {
    period: windowMs ? period : "all",
    requests,
    errors: totals.errors || 0,
    errorRate: requests ? (totals.errors || 0) / requests : 0,
    promptTokens: totals.promptTokens || 0,
    completionTokens: totals.completionTokens || 0,
    avgLatency: Math.round(totals.avgLatency || 0),
    requestsPerMinute: minutes ? requests / minutes : 0,
    tokensPerMinute: minutes ? tokens / minutes : 0,
    byProvider: groupBy("provider"),
    byModel: groupBy("model"),
    retention: {
      records: retained.c || 0,
      maxRecords: config.maxRecords,
      oldest: retained.oldest || null,
      enabled: config.enabled,
    },
  };
}

const _shutdownHandler = async () => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (writeBuffer.length > 0) {
    await flushToDatabase();
  }
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();
