/**
 * `omnihilbras routing` — who is ejected, who is waiting, and how each provider shares traffic.
 *
 * `GET /v1/routing` is the gateway's own view of the live routing state, so this is a read of the
 * gateway's decision rather than a reconstruction of it from the dashboard.
 */

export const routing = {
  name: 'routing',
  summary: 'Live routing state: ejection, waits, strategies',
  usage: 'omnihilbras routing [--problems] [--json]',
  flags: ['--problems'],
  async run({ client, out, flags }) {
    const state = await client.request('/v1/routing');
    const connections = Array.isArray(state?.connections) ? state.connections : [];
    const strategies = state?.strategies ?? {};

    const rows = connections.map((entry) => ({
      connectionId: entry.connectionId,
      providerId: entry.providerId,
      enabled: entry.enabled !== false,
      failures: entry.failures ?? 0,
      successes: entry.successes ?? 0,
      ...(entry.ejected ? { ejected: true } : {}),
      ...(entry.rateLimitWaitMs ? { rateLimitWaitMs: entry.rateLimitWaitMs } : {}),
      ...(entry.lastLatencyMs === undefined ? {} : { lastLatencyMs: entry.lastLatencyMs }),
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
    }));

    const problems = rows.filter((row) => row.ejected || row.rateLimitWaitMs || row.failures > 0);
    out.data({ failureThreshold: state?.failureThreshold, strategies, total: rows.length, problems });
    if (out.json) return 0;

    out.title(`Routing: ${rows.length} connection${rows.length === 1 ? '' : 's'}, failure threshold ${state?.failureThreshold ?? '?'}`);
    const strategyNames = Object.entries(strategies);
    out.line(strategyNames.length === 0
      ? out.muted('Every provider is on the default: priority order.')
      : `Strategies: ${strategyNames.map(([provider, name]) => `${provider}=${name}`).join('  ')}`);
    out.line();

    const shown = flags.problems ? problems : rows;
    if (shown.length === 0) {
      out.line(out.ok('Nothing ejected, nothing waiting, no recorded failures.'));
      return 0;
    }
    out.table(shown.map((row) => [
      row.connectionId,
      row.enabled ? '' : out.warn('paused'),
      `f${row.failures}/s${row.successes}`,
      row.ejected ? out.bad('ejected') : '',
      row.rateLimitWaitMs ? out.warn(`${Math.round(row.rateLimitWaitMs / 1000)}s wait`) : '',
      row.lastLatencyMs === undefined ? '' : `${row.lastLatencyMs} ms`,
      row.lastError ? out.muted(String(row.lastError).slice(0, 44)) : '',
    ]), ['account', '', 'f/s', '', '', 'latency', 'last error']);
    return 0;
  },
};
