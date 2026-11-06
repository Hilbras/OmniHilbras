import { useCallback, useEffect, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import { getProviderQuota, isNotSupported, type GatewayProviderQuota } from '../lib/gatewayClient';

/**
 * What the signed-in account has left.
 *
 * ## Why "not published" is its own state
 *
 * Most providers publish no quota at all. Rendering that as `0` would say *"this account is exhausted"* —
 * the opposite of the truth — and a user reading it would go looking for a billing problem that does not
 * exist. So there are three states, not two: a reading, "not published", and "could not read it just now".
 * They look identical from the outside and mean different things, which is the same rule the gateway's
 * `ProviderQuota` type applies on the server.
 *
 * ## Why it is read on demand rather than on load
 *
 * The quota costs an authenticated provider request. A provider page that fired one on every visit would
 * spend a request per page view for a number that changes hourly. So it loads when the panel is opened and
 * refreshes only when asked.
 */

type QuotaState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'reading'; quota: GatewayProviderQuota }
  | { kind: 'none'; reason: string }
  /** The provider refused the stored sign-in. Distinct from `error`: retrying cannot fix it. */
  | { kind: 'refused'; reason: string }
  | { kind: 'error'; reason: string };

export function ProviderQuotaPanel({ connectionId, providerName }: { connectionId: string | undefined; providerName: string }) {
  const [state, setState] = useState<QuotaState>({ kind: 'idle' });

  const load = useCallback(async (signal?: AbortSignal) => {
    // The hook is declared before the early return, so `connectionId` can be absent here even though the
    // markup never renders without it. Nothing to read, nothing to do.
    if (!connectionId) return;
    setState({ kind: 'loading' });
    try {
      const quota = await getProviderQuota(connectionId, signal);
      setState({ kind: 'reading', quota });
    } catch (error) {
      if (signal?.aborted) return;
      // A provider with no meter and a gateway that is down are different problems, and the client already
      // distinguishes them: `isNotSupported` is the first, everything else is the second.
      // Three outcomes, not two. A provider with no meter is `none`; a refused credential needs a new
      // sign-in and no amount of retrying will help; anything else is a transient read failure.
      const code = (error as { code?: string } | null)?.code;
      if (isNotSupported(error)) {
        setState({ kind: 'none', reason: `${providerName} does not publish a quota for this account.` });
      } else if (code === 'AUTHENTICATION_FAILED' || code === 'PROVIDER_REQUEST_FAILED' || code === 'PROVIDER_UNAVAILABLE') {
        setState({ kind: 'refused', reason: `${providerName} refused the stored sign-in, so its quota cannot be read. Sign in again on the connections page.` });
      } else {
        setState({ kind: 'error', reason: describeReadFailure(error) });
      }
    }
  }, [connectionId, providerName]);

  useEffect(() => {
    if (!connectionId) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, connectionId]);

  /**
   * No connection means no account to describe, so the card is not drawn.
   *
   * **Every hook above this line, unconditionally.** An early `return null` placed before the hooks made
   * the first render call one hook and the next call four — React answered "Rendered more hooks than
   * during the previous render" and unmounted the tree, which is the blank page. The order is the rule;
   * the early return is allowed to skip *markup*, never a hook.
   */
  if (!connectionId) return null;

  const resources = state.kind === 'reading' ? Object.entries(state.quota.resources) : [];

  return (
    <section id="quota" className="card mt-4 p-3.5 sm:mt-5 sm:p-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text">
            <Gauge className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Quota</h2>
            <p className="muted mt-0.5 text-xs">What this account has left, as {providerName} reports it.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={state.kind === 'loading'}
          className="btn-ghost inline-flex h-7 items-center gap-1.5 px-2.5 text-[11px] disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${state.kind === 'loading' ? 'animate-spin' : ''}`} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <div className="mt-4" aria-live="polite">
        {state.kind === 'loading' && <p className="muted text-xs">Reading the account’s quota…</p>}

        {/* Not published and unreadable are stated, never rendered as a zero balance. */}
        {state.kind === 'none' && <p className="muted text-xs">{state.reason}</p>}
        {state.kind === 'refused' && <p className="text-xs text-danger">{state.reason}</p>}
        {state.kind === 'error' && <p className="text-xs text-danger">{state.reason}</p>}

        {state.kind === 'reading' && resources.length === 0 && (
          <p className="muted text-xs">{providerName} answered, but reported no metered resources.</p>
        )}

        {state.kind === 'reading' && state.quota.plan && (
          <p className="muted mb-2 text-xs">
            Plan: <span className="text-text">{state.quota.plan}</span>
          </p>
        )}

        {resources.map(([name, resource]) => {
          // A provider that withholds either figure omits the resource rather than reporting zero, so the
          // percentage is only drawn when both are known — otherwise a bar would invent a proportion.
          const proportion = resource.limit > 0 ? Math.min(1, Math.max(0, resource.used / resource.limit)) : undefined;
          const exhausted = resource.remaining <= 0;
          return (
            <div key={name} className="mt-4 first:mt-1">
              <div className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                <span className="truncate font-medium">{name}</span>
                <span className={`tabular-nums ${exhausted ? 'text-danger' : 'muted'}`}>
                  {formatNumber(resource.used)} / {formatNumber(resource.limit)} used
                  <span className="ml-0 block sm:ml-2 sm:inline">· {formatNumber(resource.remaining)} left</span>
                </span>
              </div>
              {proportion !== undefined && (
                <div
                  className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-bg-soft"
                  role="progressbar"
                  aria-label={`${name} used`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(proportion * 100)}
                >
                  <div
                    className={`h-full rounded-full ${exhausted ? 'bg-danger' : 'bg-gold'}`}
                    style={{ width: `${Math.round(proportion * 100)}%` }}
                  />
                </div>
              )}
              {resource.resetsAt && (
                <p className="muted mt-1 text-[11px]">Resets {formatReset(resource.resetsAt)}.</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * A sentence for a read that failed for a reason we did not classify.
 *
 * "The quota could not be read." alone is honest but useless; the status is what lets a reader tell a
 * gateway problem from a network one.
 */
function describeReadFailure(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  if (typeof status === 'number' && status >= 500) {
    return `The gateway could not read the quota (${status}). The stored sign-in may have been refused — sign in again if this repeats.`;
  }
  return error instanceof Error && error.message
    ? `The quota could not be read: ${error.message}`
    : 'The quota could not be read.';
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? new Intl.NumberFormat().format(value) : '—';
}

/** "in 4 hours" reads better than a timestamp for a refill, with the date kept for a distant one. */
function formatReset(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'at an unreadable time';
  const deltaMinutes = Math.round((at - Date.now()) / 60_000);
  if (deltaMinutes <= 0) return 'now';
  if (deltaMinutes < 60) return `in ${deltaMinutes} min`;
  if (deltaMinutes < 60 * 48) return `in ${Math.round(deltaMinutes / 60)} h`;
  return `on ${new Date(at).toLocaleDateString()}`;
}
