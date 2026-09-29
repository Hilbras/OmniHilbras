import { ArrowUpRight, CheckCircle2, CircleAlert, Clock3, Cpu, KeyRound, Server, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ProviderMark } from './ProviderMark';

/**
 * `planned` is a card whose provider is real and catalogued but has no working connection.
 *
 * It is a distinct status rather than a flavour of `available` because the two need opposite
 * behaviour: `available` should invite you to connect, and this one must not, because there is
 * nothing to connect to. Presenting a known-blocked provider as an ordinary option is the
 * thing a status like this exists to prevent.
 */
export type ProviderStatus = 'connected' | 'attention' | 'available' | 'planned';
export type ProviderGroup = 'oauth' | 'api-key' | 'web-cookie' | 'free-tier' | 'hosted' | 'local' | 'custom';
export type ProviderCardMode = 'simple' | 'advanced';

export const providerGroupOrder: ProviderGroup[] = ['oauth', 'api-key', 'web-cookie', 'hosted', 'free-tier', 'local', 'custom'];

export const providerGroupLabels: Record<ProviderGroup, string> = {
  oauth: 'OAuth Providers',
  'api-key': 'API Key Providers',
  'web-cookie': 'Web Cookie Providers',
  'free-tier': 'Free Tier Providers',
  hosted: 'Hosted API Providers',
  local: 'Local Providers',
  custom: 'Custom Endpoints',
};

export type ProviderRecord = {
  id: string;
  catalogId?: string;
  name: string;
  description: string;
  category: string;
  group: ProviderGroup;
  status: ProviderStatus;
  auth: string;
  models: string;
  latency: string;
  requests: string;
  lastUsed: string;
  health: number;
  color: string;
  initial: string;
  logo?: string;
  endpoint: string;
  modelList: string[];
  /**
   * A standing caution about using this provider at all, shown on the card and again on
   * its page. It exists for providers whose terms or reliability do not support being
   * presented as an ordinary option, and it is not dismissible.
   */
  riskNotice?: string;
  /**
   * `high` marks a notice that is about the credential itself rather than the provider's
   * terms — a session that grants account-wide access reads differently from a ToS flag,
   * and the card says so.
   */
  riskSeverity?: 'standard' | 'high';
  /**
   * Why this provider cannot be connected yet, in one sentence the user can act on.
   *
   * Required whenever `status` is `planned`: a card that says "not available" without saying
   * why is a dead end, and one that hides the reason is worse.
   */
  unavailableReason?: string;
};

function statusMeta(status: ProviderStatus) {
  if (status === 'connected') {
    return {
      label: 'Connected',
      icon: CheckCircle2,
      className: 'border-success/25 bg-success/10 text-success',
      dot: 'bg-success',
    };
  }
  if (status === 'attention') {
    return {
      label: 'Needs attention',
      icon: CircleAlert,
      className: 'border-gold/30 bg-gold-soft text-gold-text',
      dot: 'bg-gold',
    };
  }
  if (status === 'planned') {
    return {
      label: 'Not built yet',
      icon: Clock3,
      className: 'border-line-strong bg-surface-2 text-muted',
      dot: 'bg-muted',
    };
  }
  return {
    label: 'Available',
    icon: Server,
    className: 'border-line-strong bg-surface-2 text-muted',
    dot: 'bg-muted',
  };
}

function SimpleProviderCard({ provider, detailTo, onManage, onConnect, simpleEnabled, onToggle }: { provider: ProviderRecord; detailTo: string; onManage: () => void; onConnect: () => void; simpleEnabled: boolean; onToggle?: (enabled: boolean) => void }) {
  const connected = provider.status === 'connected';
  const attention = provider.status === 'attention';
  // A planned provider says so in place of "No connections", because "no connections" reads
  // as "you have not connected it yet" — which implies there is something to connect.
  const planned = provider.status === 'planned';
  const statusLabel = planned
    ? 'Not built yet'
    : connected
      ? simpleEnabled ? '1 Connected' : 'Disabled'
      : attention ? 'Needs attention' : 'No connections';

  return (
    <article className="group relative isolate flex min-h-[84px] cursor-pointer items-center justify-between gap-3 rounded-xl border border-line bg-surface-2/75 p-3 transition-colors hover:border-line-strong hover:bg-surface-2">
      <Link to={detailTo} aria-label={`Open ${provider.name} provider`} className="absolute inset-0 z-0 rounded-xl" />
      <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-3">
        <ProviderMark logo={provider.logo} initial={provider.initial} color={provider.color} className="h-10 w-10 shrink-0 rounded-xl" />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-text transition-colors group-hover:text-gold-text">{provider.name}</span>
            {/* A standing caution has to be visible here as well as on the full card and
                the provider page. A warning that only appears in one view is not a
                warning. */}
            {provider.riskNotice && (
              <span
                title={provider.riskNotice}
                className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${
                  provider.riskSeverity === 'high' ? 'border-danger/50 bg-danger/15 text-danger' : 'border-[#ff6b35]/40 bg-[#ff6b35]/10 text-[#ff6b35]'
                }`}
              >
                <CircleAlert className="h-2.5 w-2.5" aria-hidden="true" />
                {provider.riskSeverity === 'high' ? 'Account session' : 'Terms'}
              </span>
            )}
          </span>
          <span className={`mt-1 flex items-center gap-1.5 text-[11px] ${connected && simpleEnabled ? 'text-success' : attention ? 'text-gold-text' : 'text-muted'}`}>
            {connected && simpleEnabled && <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />}
            {statusLabel}
          </span>
        </span>
      </div>
      {/*
        A planned provider gets the reason where the Connect button would be, and no button at
        all. Both the simple and advanced cards needed this, and the first one I guarded was
        not the one this list actually renders.
      */}
      {planned ? (
        <span
          title={provider.unavailableReason}
          className="relative z-20 max-w-[11rem] shrink-0 truncate text-right text-[10px] leading-tight text-muted"
        >
          {provider.unavailableReason}
        </span>
      ) : connected ? (
        <button type="button" role="switch" aria-checked={simpleEnabled} aria-label={`${simpleEnabled ? 'Disable' : 'Enable'} ${provider.name}`} onClick={() => onToggle?.(!simpleEnabled)} disabled={!onToggle} className={`relative z-20 h-6 w-11 shrink-0 rounded-full p-1 opacity-100 transition-[colors,opacity] sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 ${simpleEnabled ? 'bg-[#f0643b]' : 'bg-line-strong'} disabled:cursor-not-allowed disabled:opacity-60`}>
          <span className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${simpleEnabled ? 'translate-x-5' : 'translate-x-0'}`} aria-hidden="true" />
        </button>
      ) : attention ? (
        <button type="button" onClick={onManage} className="btn-quiet relative z-20 shrink-0 !px-2 !py-1.5 !text-[11px]">Review</button>
      ) : (
        <button type="button" onClick={onConnect} className="btn-quiet relative z-20 shrink-0 !px-2 !py-1.5 !text-[11px]">Connect</button>
      )}
    </article>
  );
}

export function ProviderCard({ provider, detailTo, onManage, onConnect, mode = 'advanced', simpleEnabled = provider.status === 'connected', onToggle }: { provider: ProviderRecord; detailTo: string; onManage: () => void; onConnect: () => void; mode?: ProviderCardMode; simpleEnabled?: boolean; onToggle?: (enabled: boolean) => void }) {
  if (mode === 'simple') return <SimpleProviderCard provider={provider} detailTo={detailTo} onManage={onManage} onConnect={onConnect} simpleEnabled={simpleEnabled} onToggle={onToggle} />;
  const status = statusMeta(provider.status);
  const StatusIcon = status.icon;
  const isAvailable = provider.status === 'available';
  const hasLiveHealth = provider.health > 0;

  return (
    <article className="card group flex min-w-0 flex-col overflow-hidden transition-transform duration-200 hover:-translate-y-0.5">
      <div className="flex items-start justify-between gap-3 border-b border-line/70 p-4 sm:p-5">
        <div className="flex min-w-0 items-center gap-3">
          <ProviderMark logo={provider.logo} initial={provider.initial} color={provider.color} className="h-10 w-10 rounded-xl" />
          <div className="min-w-0">
            <Link to={detailTo} className="truncate text-sm font-semibold transition-colors hover:text-gold-text">{provider.name}</Link>
            <p className="muted mt-1 truncate text-[11px]">{provider.category}</p>
          </div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[9px] ${status.className}`}>
          <StatusIcon className="h-3 w-3" aria-hidden="true" />
          {status.label}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4 sm:p-5">
        {provider.unavailableReason && (
          <p className="mb-3 flex items-start gap-1.5 rounded-lg border border-line-strong bg-surface-2 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {provider.unavailableReason}
          </p>
        )}
        {provider.riskNotice && (
          <p className="mb-3 flex items-start gap-1.5 rounded-lg border border-[#ff6b35]/30 bg-[#ff6b35]/10 px-2.5 py-2 text-[11px] leading-relaxed text-[#ff6b35]">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {provider.riskNotice}
          </p>
        )}
        <p className="muted min-h-10 text-xs leading-relaxed">{provider.description}</p>

        <div className="mt-5 grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-line bg-bg-soft/70 px-3 py-2.5">
            <span className="mono-label flex items-center gap-1"><Cpu className="h-3 w-3" aria-hidden="true" />Models</span>
            <strong className="mt-1 block truncate font-mono text-xs">{provider.models}</strong>
          </div>
          <div className="rounded-lg border border-line bg-bg-soft/70 px-3 py-2.5">
            <span className="mono-label flex items-center gap-1"><Clock3 className="h-3 w-3" aria-hidden="true" />Latency</span>
            <strong className="mt-1 block font-mono text-xs">{provider.latency}</strong>
          </div>
        </div>

        {provider.status !== 'available' && hasLiveHealth && (
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="muted text-[10px]">Route health</span>
              <span className={`font-mono text-[10px] ${provider.status === 'connected' ? 'text-success' : 'text-gold-text'}`}>{hasLiveHealth ? `${provider.health}%` : 'Not checked'}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-line/70">
              <div className={`h-full rounded-full ${provider.status === 'connected' ? 'bg-success' : 'bg-gold'}`} style={{ width: `${provider.health}%` }} />
            </div>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line/70 pt-4 text-[10px] text-muted">
          <span className="flex items-center gap-1.5"><KeyRound className="h-3 w-3" aria-hidden="true" />{provider.auth}</span>
          <span className="flex items-center gap-1.5"><Zap className="h-3 w-3" aria-hidden="true" />{provider.requests} req</span>
          <span className="ml-auto">Used {provider.lastUsed}</span>
        </div>
      </div>

      <div className="border-t border-line/70 px-4 py-3 sm:px-5">
        {/*
          A planned provider gets no Connect button at all. The rule the project already has
          for an auth mode with no flow behind it applies here for the same reason: a button
          that opens a dialog which cannot work is worse than no button, and a disabled one is
          still an invitation. The card says why, in `unavailableReason`.
        */}
        <button
          type="button"
          onClick={isAvailable ? onConnect : onManage}
          disabled={provider.status === 'planned'}
          title={provider.status === 'planned' ? provider.unavailableReason : undefined}
          className={`flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
            provider.status === 'planned'
              ? 'cursor-not-allowed text-muted opacity-50'
              : isAvailable
                ? 'bg-gold-soft text-gold-text hover:bg-gold/20'
                : 'text-muted hover:bg-bg-soft hover:text-gold-text'
          }`}
        >
          {provider.status === 'planned' ? 'Not available yet' : isAvailable ? 'Connect provider' : 'Manage connection'}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}
