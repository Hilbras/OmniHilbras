// Periodic prune of the usage tables.
//
// usageHistory grows one row per request and nothing ever deleted one, so a
// long-running gateway accumulated rows without bound; the daily rollup
// (usageDaily) grew one row per day, forever. Both are pruned on a timer,
// with the window taken from the settings
// (src/lib/db/repos/settingsRepo.js → DEFAULT_SETTINGS.usageRetention).
//
// Fails open: a failed prune is logged and the next tick tries again — a
// retention problem must never keep the gateway from serving traffic.
import { getSettings } from "@/lib/localDb";
import { pruneUsageHistory } from "@/lib/usageDb.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_HISTORY_DAYS = 90;
const DEFAULT_DAILY_DAYS = 400;

let timer = null;

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** One prune pass. Returns the deleted row counts, or null when it failed. */
export async function runUsageRetentionOnce() {
  try {
    const settings = await getSettings();
    const cfg = settings?.usageRetention || {};
    if (cfg.enabled === false) return null;
    const result = await pruneUsageHistory(
      positiveNumber(cfg.historyDays, DEFAULT_HISTORY_DAYS),
      positiveNumber(cfg.dailyDays, DEFAULT_DAILY_DAYS),
    );
    if (result && (result.history > 0 || result.daily > 0)) {
      console.log(`[UsageRetention] pruned ${result.history} history rows, ${result.daily} daily rows`);
    }
    return result;
  } catch (error) {
    console.log("[UsageRetention] prune failed:", error?.message || error);
    return null;
  }
}

/** Start the prune timer (idempotent). */
export async function startUsageRetentionScheduler() {
  if (timer) return timer;
  let intervalMs = DEFAULT_INTERVAL_MS;
  try {
    const settings = await getSettings();
    intervalMs = positiveNumber(settings?.usageRetention?.intervalMs, DEFAULT_INTERVAL_MS);
    if (settings?.usageRetention?.enabled === false) return null;
  } catch {
    // Settings unreadable → keep the default interval; the prune itself
    // re-reads the settings on every tick anyway.
  }
  timer = setInterval(() => {
    runUsageRetentionOnce().catch(() => {});
  }, intervalMs);
  timer.unref?.();
  // Catch up right away: a gateway that was left running for months has rows
  // that are already past the window.
  runUsageRetentionOnce().catch(() => {});
  return timer;
}

/** Stop the prune timer. */
export function stopUsageRetentionScheduler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
