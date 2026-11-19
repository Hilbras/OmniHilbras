import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Pause, Play, Search, X } from 'lucide-react';
import { getGatewayUsage, openGatewayLogStream, type GatewayLogEvent, type GatewayUsageRecord } from '../lib/gatewayClient';

/** The most recent events kept on the page. Older ones are dropped, so a long swarm run does not grow the page. */
const keptEvents = 500;

type RecordRow = GatewayLogEvent | GatewayUsageRecord;

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

export function LogsContent() {
  const [history, setHistory] = useState<RecordRow[]>([]);
  const [live, setLive] = useState<RecordRow[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [paused, setPaused] = useState(false);
  const [outcome, setOutcome] = useState<'all' | 'success' | 'failure' | 'cancelled'>('all');
  const [query, setQuery] = useState('');
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

  const rows = useMemo(() => {
    const merged = mergeRows([...live, ...history]);
    const needle = query.trim().toLowerCase();
    return merged.filter((row) => {
      if (outcome !== 'all' && row.outcome !== outcome) return false;
      if (!needle) return true;
      return [row.model, row.providerId, row.connectionId, 'requestId' in row ? row.requestId : undefined, 'errorCode' in row ? row.errorCode : undefined]
        .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
    });
  }, [history, live, outcome, query]);

  const exportRows = () => {
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
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
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search model, provider, account or request id" aria-label="Search request log" className="input !h-9 !py-0 !pl-8 !text-xs" />
        </label>
        <select value={outcome} onChange={(event) => setOutcome(event.target.value as typeof outcome)} aria-label="Filter by outcome" className="input !h-9 !w-auto !py-0 !text-xs">
          <option value="all">All outcomes</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <button type="button" onClick={() => paused ? resume() : setPaused(true)} className="btn-ghost !h-9 !px-3 !py-0 !text-xs">
          {paused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
          {paused ? `Resume${buffered.current.length ? ` (${buffered.current.length})` : ''}` : 'Pause'}
        </button>
        <button type="button" onClick={exportRows} disabled={rows.length === 0} className="btn-ghost !h-9 !px-3 !py-0 !text-xs disabled:opacity-40">
          <Download className="h-3.5 w-3.5" aria-hidden="true" />Export
        </button>
      </div>

      {error && <p role="alert" className="rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
      {paused && <p className="text-[10px] text-gold-text">Paused — {buffered.current.length} event{buffered.current.length === 1 ? '' : 's'} buffered.</p>}

      <section className="card overflow-hidden" aria-label="Request log">
        {rows.length === 0 ? (
          <p className="muted px-4 py-10 text-center text-xs">
            {loading ? 'Reading the usage store…' : 'No requests match this filter. Send one through the gateway, or widen the search.'}
          </p>
        ) : (
          <ul className="divide-y divide-line font-mono text-[11px]">
            {rows.map((row) => (
              <li key={'id' in row && row.id ? row.id : `${row.at}-${row.model}-${row.attempts}-${row.latencyMs}-${row.outcome}`}>
                <button type="button" onClick={() => setSelected(row)} className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2 text-left hover:bg-bg-soft">
                  <span className="muted tabular-nums">{new Date(row.at).toLocaleTimeString()}</span>
                  <span className="truncate">
                    {row.model} · {row.providerId ?? 'no provider'} · {row.attempts} {row.attempts === 1 ? 'attempt' : 'attempts'}
                    {'errorCode' in row && row.errorCode ? ` · ${row.errorCode}` : ''}
                  </span>
                  <span className={row.outcome === 'success' ? 'text-success' : row.outcome === 'failure' ? 'text-danger' : 'muted'}>
                    {row.outcome} · {row.latencyMs} ms
                  </span>
                </button>
              </li>
            ))}
          </ul>
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
        </section>
      )}
    </div>
  );
}
