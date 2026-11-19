import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Coins, Cpu, Database } from 'lucide-react';
import { DashboardShell } from '../components/DashboardShell';
import { getGatewayTokenSaverStats, type GatewayTokenSaverStats } from '../lib/gatewayClient';
import { useGatewayReload } from '../lib/useGatewayStatus';
import { Skeleton, TableSkeleton } from '../ui/Skeleton';

const PERIODS = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['all', 'All'],
] as const;

function formatTokens(value: number) {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
}

function formatBytes(value: number) {
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
}

export function TokenSaverContent() {
  const [period, setPeriod] = useState('7d');
  const [stats, setStats] = useState<GatewayTokenSaverStats | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    getGatewayTokenSaverStats(period, signal)
      .then((next) => { setStats(next); setError(undefined); })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : 'The gateway did not answer.');
      })
      .finally(() => setLoading(false));
  }, [period]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  useGatewayReload(load);

  // A response can omit a section without being a failed request: an older gateway, a partial read, or an
  // endpoint that has not gathered that table yet. The page must say "no data", not blank the shell — the same
  // class of crash that blanked the usage page when `summary.totals` was missing (3.66.2).
  const cache = stats?.cache;
  const savers = Array.isArray(stats?.savers) ? stats.savers : [];
  const byProvider = Array.isArray(stats?.byProvider) ? stats.byProvider : [];

  return (
    <div id="token-saver" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="muted text-xs leading-relaxed">
          What the context saver changed, from the gateway's own request records. Tokens are estimates; the
          saver's estimator is bytes/4, not a provider tokenizer.
        </p>
        <div className="flex items-center gap-1">
          {PERIODS.map(([value, label]) => (
            <button key={value} type="button" onClick={() => setPeriod(value)} className={`rounded-md border px-2 py-1 text-[10px] ${period === value ? 'border-gold/40 bg-gold-soft text-gold-text' : 'border-line text-muted hover:text-text'}`}>{label}</button>
          ))}
        </div>
      </div>

      {error && <p role="alert" className="rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Savings">
        <div className="card p-4"><p className="muted text-[10px] uppercase tracking-wide">Estimated saved</p><p className="mt-1 font-mono text-xl">{loading ? <Skeleton className="h-6 w-20" /> : formatTokens(stats?.totalTokensSaved ?? 0)}</p><p className="muted mt-1 text-[10px]">tokens</p></div>
        <div className="card p-4"><p className="muted text-[10px] uppercase tracking-wide">Bytes avoided</p><p className="mt-1 font-mono text-xl">{loading ? <Skeleton className="h-6 w-20" /> : formatBytes(stats?.totalBytesSaved ?? 0)}</p><p className="muted mt-1 text-[10px]">prompt payload</p></div>
        <div className="card p-4"><p className="muted text-[10px] uppercase tracking-wide">Requests compressed</p><p className="mt-1 font-mono text-xl">{loading ? <Skeleton className="h-6 w-24" /> : `${stats?.requestsWithSavings ?? 0} / ${stats?.requests ?? 0}`}</p><p className="muted mt-1 text-[10px]">with savings / all requests</p></div>
        <div className="card p-4"><p className="muted text-[10px] uppercase tracking-wide">Provider cache</p><p className="mt-1 font-mono text-xl">{loading ? <Skeleton className="h-6 w-24" /> : `${formatTokens(cache?.read ?? 0)} / ${formatTokens(cache?.write ?? 0)}`}</p><p className="muted mt-1 text-[10px]">read / write tokens</p></div>
      </section>

      <section className="card overflow-hidden" aria-label="Savings by saver">
        <div className="flex items-center gap-2 border-b border-line p-4"><BarChart3 className="h-4 w-4 text-muted" aria-hidden="true" /><h2 className="text-sm font-semibold">By saver</h2></div>
        {loading ? <TableSkeleton rows={4} /> : savers.length === 0 ? (
          <p className="muted px-4 py-8 text-center text-xs">No compression telemetry in this period. Enable a saver and send a request with tool output.</p>
        ) : (
          <table className="w-full text-left text-[11px]">
            <thead className="muted border-b border-line text-[10px] uppercase tracking-wide"><tr><th className="px-4 py-2">Saver</th><th className="px-4 py-2">Saved / requests</th><th className="px-4 py-2">Ran / skipped</th><th className="px-4 py-2">Bytes before → after</th><th className="px-4 py-2">Saved</th></tr></thead>
            <tbody className="divide-y divide-line font-mono">
              {savers.map((saver) => (
                <tr key={saver.id}>
                  <td className="px-4 py-2 align-top">
                    <span>{saver.id} <span className="muted">· {saver.kind}</span></span>
                    {saver.details && Object.keys(saver.details).length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-[10px] text-muted">
                        {Object.entries(saver.details).sort((left, right) => right[1] - left[1]).slice(0, 3).map(([reason, count]) => (
                          <li key={reason}>{count} × {reason}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-2 align-top">{saver.requestsWithSavings} / {saver.requests}</td>
                  <td className="px-4 py-2 align-top">{saver.ran ?? saver.requests} / {saver.skipped ?? 0}</td>
                  <td className="px-4 py-2 align-top">{saver.bytesBefore === undefined ? '—' : `${formatBytes(saver.bytesBefore)} → ${formatBytes(saver.bytesAfter ?? 0)}`}</td>
                  <td className="px-4 py-2 align-top">{formatTokens(saver.tokensSaved)} <span className="muted">({formatBytes(saver.bytesSaved)})</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card overflow-hidden" aria-label="Savings by provider">
        <div className="flex items-center gap-2 border-b border-line p-4"><Database className="h-4 w-4 text-muted" aria-hidden="true" /><h2 className="text-sm font-semibold">By provider</h2></div>
        {byProvider.length === 0 ? (
          <p className="muted px-4 py-8 text-center text-xs">No per-provider savings in this period.</p>
        ) : (
          <ul className="divide-y divide-line text-[11px]">
            {byProvider.map((provider) => (
              <li key={provider.providerId} className="grid grid-cols-3 gap-3 px-4 py-2 font-mono"><span>{provider.providerId}</span><span>{formatTokens(provider.tokensSaved)} tokens</span><span className="muted">{formatBytes(provider.bytesSaved)}</span></li>
            ))}
          </ul>
        )}
      </section>

      <p className="muted flex items-center gap-1.5 text-[10px]"><Cpu className="h-3 w-3" aria-hidden="true" />Retrieval originals are in a bounded in-memory store; they are lost when the gateway restarts.</p>
      <p className="muted flex items-center gap-1.5 text-[10px]"><Coins className="h-3 w-3" aria-hidden="true" />Cost avoided is not claimed here: saved tokens are estimated, and pricing varies by provider.</p>
    </div>
  );
}

export function TokenSaverPage() {
  return <DashboardShell activePage="token-saver" pageTitle="Token Saver" pageDescription="Measured savings from context compression"><TokenSaverContent /></DashboardShell>;
}
