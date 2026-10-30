/**
 * Per-request token-saver telemetry.
 *
 * Every saver (RTK, Headroom, Caveman, Ponytail, PXPIPE, history trimming)
 * already knows what it changed, but until now that knowledge only reached a
 * console line and was then discarded — so an operator could not answer "is
 * this saver actually saving anything?" for any of them.
 *
 * One collector is created per request in chatCore, each saver records its
 * delta, and the summary is persisted to the usageHistory.meta column (which
 * existed but was always written as `{}`). The stats endpoint aggregates it.
 *
 * Two conventions worth stating up front:
 *
 *  - A saver reports BYTES (the unit it actually measures) and we derive
 *    tokens at ~4 chars/token, the same estimate usageTracking.js already uses
 *    for the rate limiter. It is an estimate and is labelled as one; the
 *    provider's own usage numbers remain authoritative for billing.
 *  - A saver that does not run records NOTHING. Absence means "did not fire",
 *    which is what lets the stats surface a saver that is switched on but
 *    never matches anything.
 */

/** ~4 chars per token — the estimate the rate limiter and usage fallback use. */
export const CHARS_PER_TOKEN = 4;

export function bytesToTokens(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / CHARS_PER_TOKEN);
}

/** The saver ids that may appear in a summary. Kept explicit so a typo is loud. */
export const SAVER_IDS = Object.freeze([
  "rtk",
  "headroom",
  "caveman",
  "ponytail",
  "pxpipe",
  "historyTrim",
]);

function emptyEntry() {
  return {
    bytesBefore: 0,
    bytesAfter: 0,
    bytesSaved: 0,
    tokensSaved: 0,
    // How many discrete things the saver changed (filter hits, images, turns).
    units: 0,
    // Free-form per-saver detail (filter names, image count, level, ...).
    detail: null,
  };
}

/**
 * Create a collector for one request.
 *
 * Never throws: telemetry must not be able to fail a request. Every public
 * method swallows its own errors.
 */
export function createSaverTelemetry() {
  const entries = new Map();
  let touched = false;

  function record(saver, payload = {}) {
    try {
      if (!saver || typeof saver !== "string") return;
      const bytesBefore = Number(payload.bytesBefore) || 0;
      const bytesAfter = Number(payload.bytesAfter) || 0;
      // A saver that grew the body is not a saving; clamp to zero rather than
      // reporting a negative that would poison the aggregate.
      const bytesSaved = Math.max(0, bytesBefore - bytesAfter);

      const existing = entries.get(saver) || emptyEntry();
      existing.bytesBefore += bytesBefore;
      existing.bytesAfter += bytesAfter;
      existing.bytesSaved += bytesSaved;
      existing.tokensSaved = bytesToTokens(existing.bytesSaved);
      existing.units += Number(payload.units) || 0;
      if (payload.detail !== undefined && payload.detail !== null) {
        existing.detail = payload.detail;
      }
      entries.set(saver, existing);
      if (bytesSaved > 0 || payload.ran === true) touched = true;
    } catch {
      // Never let telemetry break a request.
    }
  }

  /**
   * Mark a saver as having run even when it saved nothing.
   *
   * This is the difference between "switched off" and "switched on but found
   * nothing to compress", and the stats page needs both.
   */
  function markRan(saver, detail = null) {
    record(saver, { ran: true, detail });
  }

  function summary() {
    try {
      if (!touched && entries.size === 0) return null;
      const out = {};
      let totalBytes = 0;
      let totalTokens = 0;
      for (const [saver, entry] of entries) {
        out[saver] = { ...entry };
        totalBytes += entry.bytesSaved;
        totalTokens += entry.tokensSaved;
      }
      return {
        saver: out,
        totalBytesSaved: totalBytes,
        totalTokensSaved: totalTokens,
      };
    } catch {
      return null;
    }
  }

  return { record, markRan, summary, hasData: () => touched || entries.size > 0 };
}

/**
 * Attach cache figures from the provider's own usage report.
 *
 * Cache reads are not a "saver" in the same sense (the gateway does the work),
 * but they are the single largest cost lever for Claude traffic and the stats
 * page shows them next to the savers, so they ride in the same blob.
 */
export function withCacheFigures(summary, usage) {
  if (!summary) return null;
  try {
    const cacheRead = usage?.cache_read_input_tokens
      ?? usage?.cached_tokens
      ?? usage?.prompt_tokens_details?.cached_tokens
      ?? 0;
    const cacheCreate = usage?.cache_creation_input_tokens ?? 0;
    if (!cacheRead && !cacheCreate) return summary;
    return { ...summary, cache: { read: cacheRead, create: cacheCreate } };
  } catch {
    return summary;
  }
}

/** The compact log fragment for the single "⚙" line. */
export function formatTelemetryLine(summary) {
  if (!summary || !summary.totalBytesSaved) return null;
  return `SAVED ${summary.totalBytesSaved}B (~${summary.totalTokensSaved}tok)`;
}
