import { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  CircleAlert,
  CircleCheck,
  Coins,
  Cpu,
  RefreshCw,
  ScrollText,
  Timer,
  TimerOff,
  Undo2,
} from 'lucide-react';
import { DashboardShell } from '../components/DashboardShell';
import { getGatewayUsage, type GatewayUsage, type GatewayUsageRecord } from '../lib/gatewayClient';

/**
 * Usage, measured.
 *
 * ## Why this page could not exist before 1.61.0
 *
 * Not because it was hard — because the gateway kept **no per-request record at all**. It stored
 * connections, API keys and OAuth sessions, and nothing else. This page is therefore not a view over an
 * existing table; it is the first consumer of a store that did not exist, and the numbers below are the
 * first ones this project has been able to show that were taken by measuring something.
 *
 * That history is why three rules are load-bearing rather than stylistic.
 *
 * ## 1. A missing measurement is shown as missing
 *
 * `tokensUnmeasured` is `true` when **no** record carried token counts, and the page says so rather than
 * rendering `0`. An unmetered provider and a free provider both sum to zero; only one of them is a
 * measurement. The same applies to cost: `cost.unpricedEntirely` means "nobody published a price", and the
 * page says that instead of `$0.00`.
 *
 * This repository deleted a previous Usage-adjacent page for exactly this class of problem — a hardcoded
 * request history behind a range selector that changed a hardcoded number — so the failure mode is not
 * hypothetical.
 *
 * ## 2. A cancelled request is neither a success nor a failure
 *
 * It gets its own column. A client that closed its connection did not make the provider slow, and scoring it
 * as a failure would eject a healthy connection (the v1.52.0 rule, applied to the record).
 *
 * ## 3. Nothing here holds a prompt
 *
 * The gateway's usage record has no field capable of holding a message, so this page cannot display one and
 * there is nothing to redact. That is a property of the store, not a promise this page makes.
 */

type OutcomeFilter = 'all' | 'success' | 'failure' | 'cancelled';

/** Compact token counts. A count of 0 is not the same as an absent one, and is only shown when present. */
function formatTokens(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** USD with enough precision that a cheap model does not read as free. */
function formatUsd(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

function formatWhen(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
  return new Date(at).toLocaleDateString();
}

const outcomeTone: Record<GatewayUsageRecord['outcome'], string> = {
  success: 'border-success/20 bg-success/10 text-success',
  failure: 'border-danger/25 bg-danger/10 text-danger',
  cancelled: 'border-line bg-bg-soft text-muted',
};

function SummaryCard({ label, value, detail, icon: Icon, tone }: {
  label: string;
  value: string;
  detail: string;
  icon: typeof BarChart3;
  tone: string;
}) {
  return (
    <div className={`card min-w-0 border p-4 ${tone}`}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em]">{label}</p>
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-[-0.03em]">{value}</p>
      <p className="mt-1 truncate text-[11px] opacity-80">{detail}</p>
    </div>
  );
}

function RecordRow({ record }: { record: GatewayUsageRecord }) {
  return (
    <tr className="border-t border-line">
      <td className="px-4 py-3 text-xs whitespace-nowrap">{formatWhen(record.at)}</td>
      <td className="px-4 py-3 text-xs">
        <span className="font-medium">{record.model}</span>
        {/* No provider is shown when none was reached, because a request log that puts a provider on a
            request that provider never saw is the one thing this page must not do. */}
        <span className="muted ml-2">{record.providerId ?? 'unattributed'}</span>
      </td>
      <td className="px-4 py-3 text-xs">
        <span className={`inline-block rounded-md border px-2 py-0.5 text-[11px] font-medium ${outcomeTone[record.outcome]}`}>
          {record.outcome}
        </span>
        {record.errorCode ? <span className="muted ml-2 text-[11px]">{record.errorCode}</span> : null}
      </td>
      <td className="px-4 py-3 text-xs tabular-nums">
        {formatTokens(record.inputTokens)} / {formatTokens(record.outputTokens)}
      </td>
      <td className="px-4 py-3 text-xs tabular-nums">{record.latencyMs} ms</td>
      {/* More than one attempt means failover happened, which is worth seeing without opening the record. */}
      <td className="px-4 py-3 text-xs tabular-nums">{record.attempts}</td>
    </tr>
  );
}

export function UsageContent() {
  const [usage, setUsage] = useState<GatewayUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<OutcomeFilter>('all');

  const load = useCallback(() => {
    setLoading(true);
    getGatewayUsage(filter === 'all' ? undefined : { outcome: filter })
      .then((next) => { setUsage(next); setError(null); })
      // Said plainly, because "the gateway is not running" and "nothing has been recorded" are different
      // states and only one of them is the operator's fault.
      .catch(() => setError('The gateway did not answer. Start it with `pnpm dev:gateway` and refresh.'))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const totals = usage?.totals;
  const cost = usage?.cost;
  const records = usage?.records ?? [];

  return (
    <div id="usage">
      <div className="mb-6 flex flex-col justify-between gap-5 sm:mb-8 sm:flex-row sm:items-end">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Recorded usage</span>
          <h2 className="mt-4 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">What was actually spent.</h2>
          <p className="muted mt-2 max-w-xl text-sm leading-relaxed">
            Every figure below was measured by the gateway and is read from a record it wrote. Nothing here is
            estimated, and anything the gateway could not measure is labelled as such.
          </p>
        </div>
        <button type="button" onClick={load} className="btn-ghost !px-3 !py-2.5 !text-xs">
          <RefreshCw className={`h-3.5 w-3.5${loading ? ' animate-spin' : ''}`} aria-hidden="true" />
          {loading ? 'Reading usage' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <section className="card p-5" role="alert">
          <p className="flex items-center gap-2 text-sm font-semibold text-danger">
            <CircleAlert className="h-4 w-4" aria-hidden="true" />{error}
          </p>
          <p className="muted mt-2 text-xs leading-relaxed">
            Nothing on this page is shown from memory. If the gateway is unreachable there is no usage to
            report, so there is nothing here rather than a stale reading.
          </p>
        </section>
      ) : usage && !usage.recording ? (
        <section className="card p-6 text-center">
          <ScrollText className="mx-auto h-6 w-6 text-muted" aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold">This gateway records no usage</p>
          <p className="muted mt-1 text-xs leading-relaxed">
            {usage.reason ?? 'It was started without a usage store, so no request has been recorded.'}
          </p>
        </section>
      ) : usage && totals && totals.requests === 0 ? (
        <section className="card p-6 text-center">
          <BarChart3 className="mx-auto h-6 w-6 text-muted" aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold">No requests recorded yet</p>
          <p className="muted mt-1 text-xs leading-relaxed">
            Send a request through the gateway and it will appear here. The gateway keeps the most recent
            records only, so this list is a tail rather than a history.
          </p>
        </section>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Usage summary">
            <SummaryCard
              label="Requests"
              value={totals ? String(totals.requests) : '—'}
              detail="recorded"
              icon={BarChart3}
              tone="border-gold/25 bg-gold-soft text-gold-text"
            />
            <SummaryCard
              label="Succeeded"
              value={totals ? String(totals.succeeded) : '—'}
              detail="answered"
              icon={CircleCheck}
              tone="border-success/20 bg-success/10 text-success"
            />
            <SummaryCard
              label="Failed"
              value={totals ? String(totals.failed) : '—'}
              detail="provider fault"
              icon={CircleAlert}
              tone="border-danger/25 bg-danger/10 text-danger"
            />
            {/* Cancellations get their own card because they are neither of the other two, and folding
                them into "failed" is what the v1.52.0 fix removed from the health counter. */}
            <SummaryCard
              label="Cancelled"
              value={totals ? String(totals.cancelled) : '—'}
              detail="client stopped"
              icon={Undo2}
              tone="border-line bg-bg-soft text-muted"
            />
          </section>

          <section className="mt-4 grid gap-3 sm:grid-cols-3" aria-label="Tokens and cost">
            <div className="card p-4">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted" aria-hidden="true" />
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Input tokens</p>
              </div>
              {/* The dash is the point. A provider that reports no usage is not a provider that used zero. */}
              <p className="mt-3 text-xl font-semibold tabular-nums">
                {totals?.tokensUnmeasured ? '—' : formatTokens(totals?.inputTokens)}
              </p>
              {totals?.tokensUnmeasured ? (
                <p className="muted mt-1 text-[11px]">No provider reported usage for these requests.</p>
              ) : null}
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted" aria-hidden="true" />
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Output tokens</p>
              </div>
              <p className="mt-3 text-xl font-semibold tabular-nums">
                {totals?.tokensUnmeasured ? '—' : formatTokens(totals?.outputTokens)}
              </p>
            </div>
            <div className="card p-4">
              <div className="flex items-center gap-2">
                <Coins className="h-4 w-4 text-muted" aria-hidden="true" />
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Cost</p>
              </div>
              {/* Not `$0.00`. "Nobody published a price" and "this was free" are different answers, and a
                  page that cannot tell them apart is the failure this whole page is built against. */}
              <p className="mt-3 text-xl font-semibold tabular-nums">
                {!cost ? '—' : cost.unpricedEntirely ? 'Not priced' : formatUsd(cost.costUsd)}
              </p>
              {cost?.caveat ? <p className="muted mt-1 text-[11px] leading-relaxed">{cost.caveat}</p> : null}
            </div>
          </section>

          <section className="card mt-4 overflow-hidden" aria-label="Recorded requests">
            <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <Timer className="h-4 w-4 text-muted" aria-hidden="true" />
                <h3 className="text-sm font-semibold">Most recent requests</h3>
              </div>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by outcome">
                {(['all', 'success', 'failure', 'cancelled'] as OutcomeFilter[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setFilter(option)}
                    aria-pressed={filter === option}
                    className={`btn-ghost !px-3 !py-2 !text-xs${filter === option ? ' !border-line' : ''}`}
                  >
                    {option === 'all' ? 'All' : option}
                    {option === 'all' && totals ? ` (${totals.requests})` : ''}
                  </button>
                ))}
              </div>
            </div>
            {records.length === 0 ? (
              <p className="muted px-4 py-8 text-center text-xs">
                {filter === 'all'
                  ? 'Nothing recorded yet.'
                  : `No ${filter} requests in the retained window.`}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-[0.12em] text-muted">
                      <th scope="col" className="px-4 py-2.5 font-semibold">When</th>
                      <th scope="col" className="px-4 py-2.5 font-semibold">Model</th>
                      <th scope="col" className="px-4 py-2.5 font-semibold">Outcome</th>
                      <th scope="col" className="px-4 py-2.5 font-semibold">Tokens in / out</th>
                      <th scope="col" className="px-4 py-2.5 font-semibold">Latency</th>
                      <th scope="col" className="px-4 py-2.5 font-semibold">Attempts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((record) => <RecordRow key={record.id} record={record} />)}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="mt-5 flex items-start gap-3 rounded-xl border border-line bg-bg-soft/50 px-4 py-3.5">
            <TimerOff className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            <div>
              <p className="text-xs font-semibold">What this page does not show</p>
              <p className="muted mt-1 text-[11px] leading-relaxed">
                No prompts, no responses, and no headers — the gateway's usage record has no field capable of
                holding any, so there is nothing here to redact. It is also a **tail, not a history**: the
                gateway keeps a bounded number of recent records and drops the rest, so these totals cover
                what is retained rather than everything ever sent. A cancelled request is counted as cancelled
                and never as a provider failure, because a client stopping is not the provider's fault.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function UsagePage() {
  return (
    <DashboardShell>
      <UsageContent />
    </DashboardShell>
  );
}
