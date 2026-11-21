import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Pause, Play, Search, X } from 'lucide-react';
import { getGatewayUsage, openGatewayLogStream, type GatewayLogEvent, type GatewayUsageRecord } from '../lib/gatewayClient';

/** The most recent events kept on the page. Older ones are dropped, so a long swarm run does not grow the page. */
const keptEvents = 500;

/** Rows per page. The user asked for 20; the numbered pager below is what "pages for logs" means. */
const rowsPerPage = 20;

/** How many page-number chips render before the pager collapses to first … current … last. */
const maxPageChips = 7;

type RecordRow = GatewayLogEvent | GatewayUsageRecord;

/** The time windows the page can cut the log to. `all` is the store's own window (24 hours). */
const timeWindows = [
  { id: 'all', label: 'All time', ms: Number.POSITIVE_INFINITY },
  { id: '1h', label: 'Last hour', ms: 60 * 60_000 },
  { id: '6h', label: 'Last 6 hours', ms: 6 * 60 * 60_000 },
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
] as const;

type OutcomeFilter = 'all' | 'success' | 'failure' | 'cancelled';

function mergeRows(rows: RecordRow[]): RecordRow[] {
  const seen = new Set<string>();
  const merged: RecordRow[] = [];
  for (const row of rows) {
    const key = 'id' in row && row.id ? row.id : `${row.at}|${row.model}|${row.attempts}|${row.latencyMs}|${row.outcome}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

/** Every searchable field of one row, lowercased once. The path ledger is included, so a retry's refused provider is findable. */
function rowHaystack(row: RecordRow): string {
  const parts = [
    row.model,
    row.providerId,
    row.connectionId,
    row.errorCode,
    'requestId' in row ? row.requestId : undefined,
    'path' in row && Array.isArray(row.path) ? row.path.map((attempt) => `${attempt.providerId} ${attempt.connectionId ?? ''} ${attempt.errorCode ?? ''}`) : undefined,
  ];
  return parts.flat().filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
}

/**
 * Page chips for the pager: every page when few, otherwise first, a window around the current page, and last,
 * with ellipsis markers where numbers were dropped.
 */
function pageChips(current: number, count: number): Array<number | '…'> {
  if (count <= maxPageChips) return Array.from({ length: count }, (_, index) => index);
  const window = Array.from({ length: maxPageChips - 2 }, (_, index) => current - ((maxPageChips - 3) >> 1) + index)
    .filter((page) => page > 0 && page < count - 1);
  const chips: Array<number | '…'> = [0, ...window];
  if (window.at(-1)! < count - 2) chips.push('…');
  chips.push(count - 1);
  return chips;
}

export function LogsContent() {
  const [history, setHistory] = useState<RecordRow[]>([]);
  const [live, setLive] = useState<RecordRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [paused, setPaused] = useState(false);
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [errorFilter, setErrorFilter] = useState('all');
  const [windowFilter, setWindowFilter] = useState<(typeof timeWindows)[number]['id']>('24h');
  const [retriesOnly, setRetriesOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<RecordRow | undefined>();
  const buffered = useRef<RecordRow[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    getGatewayUsage({ period: '24h', limit: keptEvents }, controller.signal)
      .then((usage) => {
        // A partial or older response is not a reason to blank the page: the usage endpoint may omit
        // `records`, and the live stream can still fill the list.
        setHistory(Array.isArray(usage.records) ? usage.records : []);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : 'The gateway did not answer.');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => openGatewayLogStream(
    (event) => {
      if (pausedRef.current) {
        buffered.current = [event, ...buffered.current].slice(0, keptEvents);
        return;
      }
      setLive((current) => [event, ...current].slice(0, keptEvents));
    },
    setConnected,
  ), []);

  const resume = useCallback(() => {
    setPaused(false);
    if (buffered.current.length > 0) {
      setLive((current) => [...buffered.current, ...current].slice(0, keptEvents));
      buffered.current = [];
    }
  }, []);

  const filtered = useMemo(() => {
    const merged = mergeRows([...live, ...history]);
    const needle = query.trim().toLowerCase();
    const span = timeWindows.find((entry) => entry.id === windowFilter) ?? timeWindows[3];
    const cutoff = Number.isFinite(span.ms) ? Date.now() - span.ms : Number.NEGATIVE_INFINITY;
    return merged.filter((row) => {
      if (outcome !== 'all' && row.outcome !== outcome) return false;
      if (providerFilter !== 'all' && (row.providerId ?? '') !== providerFilter) return false;
      if (errorFilter !== 'all' && (row.errorCode ?? '') !== errorFilter) return false;
      if (retriesOnly && row.attempts <= 1) return false;
      if (Date.parse(row.at) < cutoff) return false;
      if (!needle) return true;
      return rowHaystack(row).includes(needle);
    });
  }, [history, live, outcome, query, providerFilter, errorFilter, windowFilter, retriesOnly]);

  /**
   * What the filters detected, computed from the filtered set — never from a timer or a placeholder.
   * A summary that counts the unfiltered store would disagree with the rows below it, so every number
   * here is over exactly what the list shows.
   */
  const detection = useMemo(() => {
    let success = 0;
    let failure = 0;
    let cancelled = 0;
    let incomplete = 0;
    let retried = 0;
    let latencyTotal = 0;
    const errors = new Map<string, number>();
    const failingProviders = new Map<string, number>();
    for (const row of filtered) {
      if (row.outcome === 'success') {
        success += 1;
        if ('incomplete' in row && row.incomplete) incomplete += 1;
      }
      else if (row.outcome === 'failure') {
        failure += 1;
        if (row.errorCode) errors.set(row.errorCode, (errors.get(row.errorCode) ?? 0) + 1);
        if (row.providerId) failingProviders.set(row.providerId, (failingProviders.get(row.providerId) ?? 0) + 1);
      } else cancelled += 1;
      if (row.attempts > 1) retried += 1;
      latencyTotal += row.latencyMs;
    }
    const topError = [...errors.entries()].sort((a, b) => b[1] - a[1])[0];
    const topOffender = [...failingProviders.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      success, failure, cancelled, incomplete, retried,
      total: filtered.length,
      avgLatencyMs: filtered.length ? Math.round(latencyTotal / filtered.length) : 0,
      errorCodes: [...errors.keys()].sort(),
      topError,
      topOffender,
    };
  }, [filtered]);

  const providers = useMemo(() => [...new Set(mergeRows([...live, ...history]).map((row) => row.providerId ?? ''))].filter(Boolean).sort(), [history, live]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / rowsPerPage));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * rowsPerPage, (safePage + 1) * rowsPerPage);

  // A filter change can leave the page number past the end; going back to the first page is the honest reset.
  useEffect(() => { setPage(0); }, [outcome, query, providerFilter, errorFilter, windowFilter, retriesOnly]);

  const exportRows = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `omnihilbras-logs-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1_500);
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Activity</p>
          <h1 className="text-lg font-semibold">Request log</h1>
          <p className="muted mt-1 text-xs">
            The last 24 hours from the usage store, plus each finished request as it arrives. No prompt content, no credential.
          </p>
        </div>
        <span className={`font-mono text-[10px] ${connected ? 'text-success' : 'text-muted'}`}>
          {connected ? 'live' : 'history only — stream unavailable'}
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search model, provider, account, request id, error or retry path" aria-label="Search request log" className="input !h-9 !py-0 !pl-8 !text-xs" />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text">
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </label>
        <select value={outcome} onChange={(event) => setOutcome(event.target.value as OutcomeFilter)} aria-label="Filter by outcome" className="input !h-9 !w-auto !py-0 !text-xs">
          <option value="all">All outcomes</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)} aria-label="Filter by provider" className="input !h-9 !w-auto !py-0 !text-xs">
          <option value="all">All providers</option>
          {providers.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <select value={errorFilter} onChange={(event) => setErrorFilter(event.target.value)} aria-label="Filter by error code" className="input !h-9 !w-auto !py-0 !text-xs" disabled={detection.errorCodes.length === 0}>
          <option value="all">All errors</option>
          {detection.errorCodes.map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
        <select value={windowFilter} onChange={(event) => setWindowFilter(event.target.value as typeof windowFilter)} aria-label="Filter by time window" className="input !h-9 !w-auto !py-0 !text-xs">
          {timeWindows.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
        <button
          type="button"
          onClick={() => setRetriesOnly((current) => !current)}
          aria-pressed={retriesOnly}
          className={`btn-ghost !h-9 !px-3 !py-0 !text-xs ${retriesOnly ? '!bg-gold/15 !text-gold-text' : ''}`}
        >
          Retries only
        </button>
        <button type="button" onClick={() => paused ? resume() : setPaused(true)} className="btn-ghost !h-9 !px-3 !py-0 !text-xs">
          {paused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
          {paused ? `Resume${buffered.current.length ? ` (${buffered.current.length})` : ''}` : 'Pause'}
        </button>
        <button type="button" onClick={exportRows} disabled={filtered.length === 0} className="btn-ghost !h-9 !px-3 !py-0 !text-xs disabled:opacity-40">
          <Download className="h-3.5 w-3.5" aria-hidden="true" />Export
        </button>
      </div>

      {error && <p role="alert" className="rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
      {paused && <p className="text-[10px] text-gold-text">Paused — {buffered.current.length} event{buffered.current.length === 1 ? '' : 's'} buffered.</p>}

      <section className="card px-4 py-3" aria-label="Detected activity">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px]">
          <span><span className="mono-label">Detected</span></span>
          <span className="text-success">{detection.success} succeeded</span>
          <span className={detection.failure ? 'text-danger font-semibold' : 'muted'}>{detection.failure} failed</span>
          <span className="muted">{detection.cancelled} cancelled</span>
          <span className={detection.incomplete ? 'text-gold-text font-semibold' : 'muted'}>
            {detection.incomplete} incomplete{/* a stream that ended without a terminal finish — often a halted agent turn */}
          </span>
          <span className="muted">{detection.retried} needed retries</span>
          <span className="muted">avg {detection.avgLatencyMs} ms</span>
          {detection.topError && (
            <span className="text-danger">
              most common error {detection.topError[0]} ×{detection.topError[1]}
            </span>
          )}
          {detection.topOffender && detection.failure > 1 && (
            <span className="text-danger">
              most failing provider {detection.topOffender[0]} ×{detection.topOffender[1]}
            </span>
          )}
        </div>
      </section>

      <section className="card overflow-hidden" aria-label="Request log">
        {visible.length === 0 ? (
          <p className="muted px-4 py-10 text-center text-xs">
            {loading ? 'Reading the usage store…' : 'No requests match this filter. Send one through the gateway, or widen the search.'}
          </p>
        ) : (
          <ul className="divide-y divide-line font-mono text-[11px]">
            {visible.map((row) => (
              <li key={'id' in row && row.id ? row.id : `${row.at}-${row.model}-${row.attempts}-${row.latencyMs}-${row.outcome}`}>
                <button type="button" onClick={() => setSelected(row)} className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2 text-left hover:bg-bg-soft">
                  <span className="muted tabular-nums">{new Date(row.at).toLocaleTimeString()}</span>
                  <span className="truncate">
                    {row.model} · {row.providerId ?? 'no provider'} · {row.attempts} {row.attempts === 1 ? 'attempt' : 'attempts'}
                    {'errorCode' in row && row.errorCode ? ` · ${row.errorCode}` : ''}
                    {'incomplete' in row && row.incomplete ? ' · no terminal finish' : ''}
                  </span>
                  <span className={row.outcome === 'success' ? 'text-success' : row.outcome === 'failure' ? 'text-danger' : 'muted'}>
                    {row.outcome} · {row.latencyMs} ms
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {filtered.length > 0 && (
          <nav className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2.5 text-xs" aria-label="Log pages">
            <span className="muted font-mono">
              {safePage * rowsPerPage + 1}–{Math.min((safePage + 1) * rowsPerPage, filtered.length)} of {filtered.length}
            </span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setPage(safePage - 1)} disabled={safePage === 0} aria-label="Previous page" className="btn-ghost !p-1.5 disabled:opacity-40">
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              {pageChips(safePage, pageCount).map((chip, index) => chip === '…' ? (
                <span key={`ellipsis-${index}`} className="muted px-1">…</span>
              ) : (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setPage(chip)}
                  aria-current={chip === safePage ? 'page' : undefined}
                  className={`min-w-7 rounded-md px-1.5 py-1 font-mono ${chip === safePage ? 'bg-bg-soft font-semibold text-text' : 'text-muted hover:bg-bg-soft hover:text-text'}`}
                >
                  {chip + 1}
                </button>
              ))}
              <button type="button" onClick={() => setPage(safePage + 1)} disabled={safePage >= pageCount - 1} aria-label="Next page" className="btn-ghost !p-1.5 disabled:opacity-40">
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </nav>
        )}
      </section>

      {selected && (
        <section className="card p-4" aria-label="Request detail">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="mono-label">Request detail</p>
              <h2 className="mt-1 text-sm font-semibold">{selected.model}</h2>
            </div>
            <button type="button" onClick={() => setSelected(undefined)} aria-label="Close request detail" className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-bg-soft hover:text-text"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-3">
            <div><dt className="muted">At</dt><dd className="font-mono">{new Date(selected.at).toLocaleString()}</dd></div>
            <div><dt className="muted">Outcome</dt><dd>{selected.outcome}</dd></div>
            <div><dt className="muted">Latency</dt><dd>{selected.latencyMs} ms</dd></div>
            <div><dt className="muted">Provider</dt><dd>{selected.providerId ?? '—'}</dd></div>
            <div><dt className="muted">Account</dt><dd>{selected.connectionId ?? '—'}</dd></div>
            <div><dt className="muted">Attempts</dt><dd>{selected.attempts}</dd></div>
            {'requestId' in selected && selected.requestId && <div><dt className="muted">Request id</dt><dd className="break-all font-mono">{selected.requestId}</dd></div>}
            {'errorCode' in selected && selected.errorCode && <div><dt className="muted">Error</dt><dd>{selected.errorCode}</dd></div>}
            {'inputTokens' in selected && selected.inputTokens !== undefined && <div><dt className="muted">Input tokens</dt><dd>{selected.inputTokens}</dd></div>}
            {'outputTokens' in selected && selected.outputTokens !== undefined && <div><dt className="muted">Output tokens</dt><dd>{selected.outputTokens}</dd></div>}
          </dl>
          {'path' in selected && Array.isArray(selected.path) && selected.path.length > 0 && (
            <div className="mt-3">
              <p className="mono-label">Attempt path</p>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
                {selected.path.map((attempt, index) => (
                  <li key={`${attempt.providerId}-${attempt.connectionId ?? index}-${index}`} className={attempt.outcome === 'success' ? 'text-success' : attempt.outcome === 'failure' ? 'text-danger' : 'muted'}>
                    {index + 1}. {attempt.providerId}{attempt.connectionId ? ` · ${attempt.connectionId}` : ''}{attempt.errorCode ? ` · ${attempt.errorCode}` : ''}{attempt.latencyMs !== undefined ? ` · ${attempt.latencyMs} ms` : ''} · {attempt.outcome}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
