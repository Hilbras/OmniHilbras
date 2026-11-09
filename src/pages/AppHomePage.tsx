import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Copy, Play, RotateCcw, Server, Square, Terminal } from 'lucide-react';
import { DashboardShell } from '../components/DashboardShell';
import { openGatewayLogStream, type GatewayLogEvent } from '../lib/gatewayClient';
import { desktopBridge, type DesktopServerLog, type DesktopServerSnapshot } from '../lib/electronBridge';

const MAX_PROCESS_LINES = 200;
const MAX_EVENTS = 100;

function timeOf(value: string | undefined) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleTimeString();
}

const STATE_TONE: Record<DesktopServerSnapshot['state'], string> = {
  running: 'border-success/25 bg-success/10 text-success',
  starting: 'border-gold/30 bg-gold-soft text-gold-text',
  stopping: 'border-gold/30 bg-gold-soft text-gold-text',
  stopped: 'border-line bg-bg-soft text-muted',
  failed: 'border-danger/25 bg-danger/10 text-danger',
};

/**
 * The desktop main page: the gateway's lifecycle and the two logs that explain it.
 *
 * Process output is what a failed start says; the request feed is what the gateway served. They were
 * two separate pages in the browser dashboard, and the one fact a desktop app must show — "is the
 * server up, and why not" — was on neither.
 */
export function AppHomePage() {
  const bridge = desktopBridge();
  const [snapshot, setSnapshot] = useState<DesktopServerSnapshot | undefined>();
  const [processLogs, setProcessLogs] = useState<DesktopServerLog[]>([]);
  const [events, setEvents] = useState<GatewayLogEvent[]>([]);
  const [streamConnected, setStreamConnected] = useState(false);
  const [busy, setBusy] = useState<'start' | 'stop' | 'restart' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.server.getState().then((state) => {
      if (!active) return;
      setSnapshot(state);
      setProcessLogs(state.logs.slice(-MAX_PROCESS_LINES));
    });
    const offState = bridge.server.onState((state) => {
      setSnapshot(state);
      setProcessLogs(state.logs.slice(-MAX_PROCESS_LINES));
    });
    const offLog = bridge.server.onLog((entry) => {
      setProcessLogs((current) => [...current, entry].slice(-MAX_PROCESS_LINES));
    });
    return () => {
      active = false;
      offState();
      offLog();
    };
  }, [bridge]);

  useEffect(() => {
    const close = openGatewayLogStream(
      (event) => setEvents((current) => [event, ...current].slice(0, MAX_EVENTS)),
      setStreamConnected,
    );
    return close;
  }, []);

  useEffect(() => {
    const node = terminalRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [processLogs]);

  const run = useCallback(async (action: 'start' | 'stop' | 'restart') => {
    if (!bridge) return;
    setBusy(action);
    setError(undefined);
    try {
      const next = await bridge.server[action]();
      setSnapshot(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The server action failed.');
    } finally {
      setBusy(undefined);
    }
  }, [bridge]);

  const copyLogs = useCallback(() => {
    const text = processLogs.map((entry) => `[${entry.stream}] ${entry.line}`).join('\n');
    const write = navigator.clipboard?.writeText(text);
    if (!write) return;
    void write.then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }).catch(() => setCopied(false));
  }, [processLogs]);

  const state = snapshot?.state ?? 'stopped';
  const canStart = bridge && (state === 'stopped' || state === 'failed');
  const canStop = bridge && (state === 'running' || state === 'starting');
  const requestCounts = useMemo(() => {
    const counts = { success: 0, failure: 0, cancelled: 0 };
    for (const event of events) if (event.outcome) counts[event.outcome] += 1;
    return counts;
  }, [events]);

  return (
    <DashboardShell activePage="home" pageTitle="Servers" pageDescription="Gateway lifecycle and live logs">
      <div id="app-home" className="space-y-5">
        <section className="card p-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl border border-gold/25 bg-gold-soft text-gold-text">
                <Server className="h-5 w-5" aria-hidden="true" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold">Local gateway</h2>
                  <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${STATE_TONE[state]}`}>{state}</span>
                </div>
                <p className="muted mt-1 text-xs">
                  {snapshot ? `127.0.0.1:${snapshot.port}` : 'Managed by pnpm dev:gateway in the browser dashboard'}
                  {snapshot?.pid ? ` · pid ${snapshot.pid}` : ''}
                </p>
                {snapshot?.lastError && (
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] text-danger"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{snapshot.lastError}</p>
                )}
                {!bridge && (
                  <p className="mt-2 text-[11px] leading-relaxed text-muted">
                    This page controls the server inside the desktop app. In a browser, start it with <code className="font-mono">pnpm dev:gateway</code>.
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void run('start')} disabled={!canStart || Boolean(busy)} className="btn-gold !px-3 !py-2 !text-xs disabled:cursor-not-allowed disabled:opacity-40">
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                {busy === 'start' ? 'Starting' : 'Start'}
              </button>
              <button type="button" onClick={() => void run('stop')} disabled={!canStop || Boolean(busy)} className="btn-ghost !px-3 !py-2 !text-xs disabled:cursor-not-allowed disabled:opacity-40">
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
                {busy === 'stop' ? 'Stopping' : 'Stop'}
              </button>
              <button type="button" onClick={() => void run('restart')} disabled={!bridge || Boolean(busy)} className="btn-ghost !px-3 !py-2 !text-xs disabled:cursor-not-allowed disabled:opacity-40">
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {busy === 'restart' ? 'Restarting' : 'Restart'}
              </button>
            </div>
          </div>
          {error && <p role="alert" className="mt-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">{error}</p>}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-line bg-bg-soft/50 p-3"><p className="muted text-[10px] uppercase tracking-wide">Served</p><p className="mt-1 font-mono text-lg">{requestCounts.success}</p></div>
            <div className="rounded-lg border border-line bg-bg-soft/50 p-3"><p className="muted text-[10px] uppercase tracking-wide">Failed</p><p className="mt-1 font-mono text-lg text-danger">{requestCounts.failure}</p></div>
            <div className="rounded-lg border border-line bg-bg-soft/50 p-3"><p className="muted text-[10px] uppercase tracking-wide">Cancelled</p><p className="mt-1 font-mono text-lg">{requestCounts.cancelled}</p></div>
            <div className="rounded-lg border border-line bg-bg-soft/50 p-3"><p className="muted text-[10px] uppercase tracking-wide">Feed</p><p className={`mt-1 flex items-center gap-1.5 text-xs font-semibold ${streamConnected ? 'text-success' : 'text-muted'}`}>{streamConnected ? <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" /> : <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />}{streamConnected ? 'live' : 'unavailable'}</p></div>
          </div>
        </section>

        <section className="card overflow-hidden" aria-labelledby="process-log-title">
          <div className="flex items-center justify-between gap-3 border-b border-line p-4">
            <div className="flex items-center gap-2"><Terminal className="h-4 w-4 text-muted" aria-hidden="true" /><h2 id="process-log-title" className="text-sm font-semibold">Server output</h2></div>
            <button type="button" onClick={copyLogs} disabled={processLogs.length === 0} className="btn-ghost !px-2.5 !py-1.5 !text-[11px] disabled:opacity-40">
              <Copy className="h-3 w-3" aria-hidden="true" />{copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div ref={terminalRef} className="max-h-[320px] overflow-y-auto bg-[#0a0908] p-4 font-mono text-[11px] leading-relaxed text-[#d8d2c4]">
            {processLogs.length === 0 ? (
              <p className="text-[#888]">No output yet. Start the gateway to see its log here.</p>
            ) : processLogs.map((entry, index) => (
              <p key={`${entry.at}-${index}`} className={entry.stream === 'stderr' ? 'text-[#e8a3a3]' : undefined}>
                <span className="text-[#666]">{timeOf(entry.at)} </span>
                <span className="text-[#8f8a7e]">[{entry.stream}] </span>
                {entry.line}
              </p>
            ))}
          </div>
        </section>

        <section className="card overflow-hidden" aria-label="Live requests">
          <div className="flex items-center justify-between gap-3 border-b border-line p-4">
            <h2 className="text-sm font-semibold">Live requests</h2>
            <span className="muted font-mono text-[10px]">{streamConnected ? 'streaming' : 'no stream'}</span>
          </div>
          {events.length === 0 ? (
            <p className="muted px-4 py-8 text-center text-xs">Finished requests appear here as the gateway records them.</p>
          ) : (
            <ul className="divide-y divide-line font-mono text-[11px]">
              {events.map((event, index) => (
                <li key={`${event.requestId ?? event.at ?? index}-${index}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-2">
                  <span className="muted">{timeOf(event.at)}</span>
                  <span className="truncate">{event.model ?? '—'} · {event.providerId ?? 'no provider'} · {event.attempts ?? '?'} {(event.attempts ?? 0) === 1 ? 'attempt' : 'attempts'}{event.errorCode ? ` · ${event.errorCode}` : ''}</span>
                  <span className={event.outcome === 'success' ? 'text-ok' : event.outcome === 'failure' ? 'text-danger' : 'muted'}>{event.outcome ?? '—'} · {event.latencyMs ?? '?'} ms</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </DashboardShell>
  );
}
