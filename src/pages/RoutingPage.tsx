import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  CircleAlert,
  CircleCheck,
  Clock,
  Gauge,
  GitBranch,
  RefreshCw,
  ShieldCheck,
  Timer,
  TimerOff,
} from 'lucide-react';
import { DashboardShell } from '../components/DashboardShell';
import { getGatewayRoutingState, type GatewayRoutingState } from '../lib/gatewayClient';
import { routingVerdict, eligibleCount } from '../lib/routingVerdict';

/**
 * The routing control plane, showing what routing can actually use.
 *
 * ## What this page used to be
 *
 * Three clickable policies with invented request counts, four togglable rules with invented traffic
 * and invented fallbacks, a "Create policy" dialog for a feature that **does not exist anywhere in the
 * gateway** — there is no policy, no strategy setting, and no rules store — and a simulator whose
 * `simulate()` was a `setTimeout` that reported success without simulating anything.
 *
 * The summary cards above it were worse than invented: "Fallback events 18 · last 24 hours" and
 * "Decision time 4 ms p95". Neither number is measured by anything. The gateway keeps no request log,
 * no counter, and no timing history, so `4 ms` was a literal.
 *
 * And the "Test policies" button flashed **"All active policies passed the preview health check"** —
 * a health-check *result*, reported without a health check. That is the same defect as the Check button
 * in `AddProviderModal` (fixed in 1.35.0), in a second component, found because the first one made me
 * look.
 *
 * There was a footer disclosure — "These policies are local UI previews" — which was honest, and it is
 * the reason this was ever in doubt. A page that says it is a preview is not lying the way a page that
 * says **live** is lying. But the measurements were still presented as measurements, and the buttons
 * still reported results.
 *
 * ## What it shows now
 *
 * `GET /v1/routing` already exists, `service.describeRouting()` already answers it, the client already
 * wraps it as `getGatewayRoutingState`, and `ProviderDetailPage` already calls it. **The real routing
 * state was available and working the whole time, on a different page, while this one showed
 * fiction.** So this page shows that: per connection, whether it is enabled, whether it holds a
 * credential, its health verdict, the latency the last poll measured, its failure and success counts,
 * whether it has been ejected, the last error it produced, and its resilience budget — plus the failure
 * threshold that decides ejection.
 *
 * That answers the question the page exists to answer — *what can routing use right now, and why not the
 * other thing* — with values the gateway actually holds. The invented half is not replaced with a
 * different invention: there is no policy to select, so there is no policy control.
 */

type Health = 'healthy' | 'degraded' | 'unavailable' | 'unknown';

const HEALTH_TONE: Record<Health, { label: string; className: string }> = {
  healthy: { label: 'healthy', className: 'border-success/25 bg-success/10 text-success' },
  degraded: { label: 'degraded', className: 'border-gold/30 bg-gold-soft text-gold-text' },
  unavailable: { label: 'unavailable', className: 'border-danger/25 bg-danger/10 text-danger' },
  unknown: { label: 'not checked yet', className: 'border-line bg-bg-soft text-muted' },
};

/**
 * Why routing would not choose the connection, named.
 *
 * The verdict itself lives in `lib/routingVerdict.ts`, derived from the same record fields routing
 * reads, so it can be called by a test rather than read. This returns the reason string for the
 * message row; an eligible connection has no reason and renders the confirmation instead.
 *
 * The reasons are the gateway's own `RouteSkipReason` values, so this is a rendering of a decision the
 * gateway already makes and records — not a second opinion about it.
 */
function whyNotUsable(connection: GatewayRoutingState['connections'][number], threshold: number): string | undefined {
  const verdict = routingVerdict(connection, threshold);
  return verdict.eligible ? undefined : verdict.reason;
}

function ConnectionCard({ connection, threshold }: { connection: GatewayRoutingState['connections'][number]; threshold: number }) {
  const blocked = whyNotUsable(connection, threshold);
  const health: Health = blocked ? (connection.ejected || (connection.failures ?? 0) > 0 ? 'degraded' : 'unavailable') : connection.lastCheckedAt ? 'healthy' : 'unknown';
  const tone = HEALTH_TONE[health];
  return (
    <article className="card min-w-0 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text">
            <GitBranch className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{connection.providerId}</h3>
            <p className="muted truncate font-mono text-[10px]">{connection.connectionId}</p>
          </div>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] ${tone.className}`}>{tone.label}</span>
      </div>

      {blocked ? (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-line bg-bg-soft/60 px-3 py-2.5 text-[11px] leading-relaxed text-gold-text">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {blocked}
        </p>
      ) : (
        <p className="mt-4 flex items-center gap-2 text-[11px] text-success">
          <CircleCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          eligible — routing can choose this
        </p>
      )}

      {/*
        A past failure on an eligible connection is context, not a verdict.

        It used to *be* the verdict: `lastError` with a non-zero presence blocked the route, so a
        single timeout under a threshold of 3 read "last attempt failed" about a candidate the next
        request would take. Shown here instead, it says what happened without claiming routing will
        refuse it — and it is the only place the error text appears, so the reason and the evidence
        cannot be printed by two different rules.
      */}
      {!blocked && connection.lastError && (
        <p className="muted mt-3 font-mono text-[10px] leading-relaxed">last attempt: {connection.lastError}</p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4 sm:grid-cols-4">
        <div>
          <dt className="mono-label">latency</dt>
          {/* The poll's own reading. `—` when nothing has measured it, never a placeholder number. */}
          <dd className="mt-1 font-mono text-sm">{connection.lastLatencyMs === undefined ? '—' : `${connection.lastLatencyMs} ms`}</dd>
        </div>
        <div>
          <dt className="mono-label">successes</dt>
          <dd className="mt-1 font-mono text-sm">{connection.successes ?? 0}</dd>
        </div>
        <div>
          <dt className="mono-label">failures</dt>
          <dd className="mt-1 font-mono text-sm">{connection.failures ?? 0}</dd>
        </div>
        <div>
          <dt className="mono-label">retries</dt>
          <dd className="mt-1 font-mono text-sm">{connection.resilience.maxRetries}</dd>
        </div>
      </dl>
      {connection.lastCheckedAt && <p className="muted mt-3 font-mono text-[10px]">last checked {new Date(connection.lastCheckedAt).toLocaleTimeString()}</p>}
    </article>
  );
}

function SummaryCard({ label, value, detail, icon: Icon, tone }: { label: string; value: string; detail: string; icon: typeof Activity; tone: string }) {
  return <article className="card min-w-0 p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><span className={`grid h-9 w-9 place-items-center rounded-lg border ${tone}`}><Icon className="h-[17px] w-[17px]" aria-hidden="true" /></span><span className="muted font-mono text-[10px]">{detail}</span></div><p className="muted mt-5 text-[10px] font-semibold uppercase tracking-[0.1em]">{label}</p><p className="mt-1 font-mono text-2xl font-semibold tracking-tight">{value}</p></article>;
}

export function RoutingContent() {
  const [state, setState] = useState<GatewayRoutingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getGatewayRoutingState()
      .then((next) => { setState(next); setError(null); })
      // The gateway is not running, or refused. Said plainly, because "no data" and "no gateway" are
      // different states and only one of them is the operator's fault.
      .catch(() => setError('The gateway did not answer. Start it with `pnpm dev:gateway` and refresh.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const connections = state?.connections ?? [];
  // Counted by the same function the cards render, so the number above cannot disagree with the
  // cards below it. It used to be `!whyNotUsable(...)` inline — the same rules, written twice.
  const eligible = eligibleCount(connections, state?.failureThreshold ?? 0);
  const cooling = connections.filter((connection) => (connection.rateLimitWaitMs ?? 0) > 0).length;

  return (
    <div id="routing">
      <div className="mb-6 flex flex-col justify-between gap-5 sm:mb-8 sm:flex-row sm:items-end">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Routing control plane</span>
          <h2 className="mt-4 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Know what routing can use.</h2>
          <p className="muted mt-2 max-w-xl text-sm leading-relaxed">
            Every value here is one the gateway holds: whether a connection is enabled, whether it has a
            credential, what its last health check measured, and the reason it would be skipped.
          </p>
        </div>
        <button type="button" onClick={load} className="btn-ghost !px-3 !py-2.5 !text-xs">
          <RefreshCw className={`h-3.5 w-3.5${loading ? ' animate-spin' : ''}`} aria-hidden="true" />
          {loading ? 'Reading routing state' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <section className="card p-5" role="alert">
          <p className="flex items-center gap-2 text-sm font-semibold text-danger"><CircleAlert className="h-4 w-4" aria-hidden="true" />{error}</p>
          <p className="muted mt-2 text-xs leading-relaxed">Nothing on this page is shown from memory. If the gateway is unreachable, there is no routing state to report, so there is nothing here rather than a stale reading.</p>
        </section>
      ) : state && connections.length === 0 ? (
        <section className="card p-6 text-center">
          <GitBranch className="mx-auto h-6 w-6 text-muted" aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold">No connections saved</p>
          <p className="muted mt-1 text-xs leading-relaxed">Routing chooses between the connections you have, so with none saved there is nothing to choose between. Add one on the providers page.</p>
        </section>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Routing summary">
            <SummaryCard label="Connections" value={state ? String(connections.length) : '—'} detail="saved" icon={GitBranch} tone="border-gold/25 bg-gold-soft text-gold-text" />
            <SummaryCard label="Eligible" value={state ? String(eligible) : '—'} detail="routing may choose" icon={ShieldCheck} tone="border-success/20 bg-success/10 text-success" />
            <SummaryCard label="At their limit" value={state ? String(cooling) : '—'} detail="cooling down" icon={TimerOff} tone="border-gold/30 bg-gold-soft text-gold-text" />
            <SummaryCard label="Failure threshold" value={state ? String(state.failureThreshold) : '—'} detail="consecutive failures" icon={Gauge} tone="border-[#83b7ff]/25 bg-[#83b7ff]/10 text-[#5d98e8]" />
            <SummaryCard label="Health checks" value={state ? String(connections.filter((c) => c.lastCheckedAt).length) : '—'} detail="reported" icon={Timer} tone="border-[#b995e8]/25 bg-[#b995e8]/10 text-[#9b7bd1]" />
          </section>

          <section className="mt-5 grid gap-4 md:grid-cols-2" aria-label="Connections routing can use">
            {connections.map((connection) => <ConnectionCard key={connection.connectionId} connection={connection} threshold={state?.failureThreshold ?? 0} />)}
          </section>

          <div className="mt-5 flex items-start gap-3 rounded-xl border border-line bg-bg-soft/50 px-4 py-3.5">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            <div>
              <p className="text-xs font-semibold">What this page does not show</p>
              <p className="muted mt-1 text-[11px] leading-relaxed">
                No request counts, no fallback totals, no p95. The gateway keeps no request log and no
                timing history, so there is nothing to report — an earlier version of this page showed
                invented figures here, including a health-check result from a button that made no
                request.
              </p>
              <p className="muted mt-1 text-[11px] leading-relaxed">
                "Eligible" means routing would put this connection in the candidate list for a request:
                it is enabled, holds a credential, is not ejected, and is not waiting on a rate limit.
                That is the same rule <span className="font-mono text-[10px]">resolveRoute</span> applies,
                and it used to be a second, looser copy of it here.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function RoutingPage() {
  return <DashboardShell activePage="routing" pageTitle="Routing" pageDescription="What routing can use, and why"><RoutingContent /></DashboardShell>;
}
