/**
 * When a crashed server should be restarted, and when to give up.
 *
 * 9router bounds its crash restarts (`MAX_RESTARTS = 2`) and resets the counter once a process has stayed up
 * past a window (`RESTART_RESET_MS = 30000`), so a one-off crash is recovered but a crash loop is not spun
 * forever. This is that decision as a pure function, so it can be tested without crashing a real process:
 * the launcher tracks per-child restart count and uptime and asks here what to do.
 *
 * The rule: a process that stayed up at least `resetMs` earns a fresh budget (its earlier restarts are
 * forgotten); otherwise each restart spends one. At `maxRestarts` spent, stop — a server that keeps dying
 * immediately is a fault to report, not a loop to hide.
 */

export const MAX_RESTARTS = 2;
export const RESTART_RESET_MS = 30_000;

export function restartDecision({ restarts, uptimeMs, maxRestarts = MAX_RESTARTS, resetMs = RESTART_RESET_MS }) {
  const budget = uptimeMs >= resetMs ? 0 : restarts;
  if (budget >= maxRestarts) return { action: 'stop', restarts: budget };
  return { action: 'restart', restarts: budget + 1 };
}
