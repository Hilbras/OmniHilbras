import { ArrowUpRight, CheckCircle2, CircleAlert, Clock3, Cpu, KeyRound, Server, Zap } from 'lucide-react';
import { ProviderMark } from './ProviderMark';

export type ProviderStatus = 'connected' | 'attention' | 'available';
export type ProviderGroup = 'oauth' | 'api-key' | 'free-tier' | 'hosted' | 'local' | 'custom';
export type ProviderCardMode = 'simple' | 'advanced';

export const providerGroupOrder: ProviderGroup[] = ['oauth', 'api-key', 'hosted', 'free-tier', 'local', 'custom'];

export const providerGroupLabels: Record<ProviderGroup, string> = {
  oauth: 'OAuth Providers',
  'api-key': 'API Key Providers',
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
  return {
    label: 'Available',
    icon: Server,
    className: 'border-line-strong bg-surface-2 text-muted',
    dot: 'bg-muted',
  };
}

function SimpleProviderCard({ provider, detailHref, onManage, onConnect, simpleEnabled, onToggle }: { provider: ProviderRecord; detailHref: string; onManage: () => void; onConnect: () => void; simpleEnabled: boolean; onToggle?: (enabled: boolean) => void }) {
  const connected = provider.status === 'connected';
  const attention = provider.status === 'attention';
  const statusLabel = connected ? (simpleEnabled ? '1 Connected' : 'Disabled') : attention ? 'Needs attention' : 'No connections';

  return (
    <article className="group relative isolate flex min-h-[84px] cursor-pointer items-center justify-between gap-3 rounded-xl border border-line bg-surface-2/75 p-3 transition-colors hover:border-line-strong hover:bg-surface-2">
      <a href={detailHref} aria-label={`Open ${provider.name} provider`} className="absolute inset-0 z-0 rounded-xl" />
      <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-3">
        <ProviderMark logo={provider.logo} initial={provider.initial} color={provider.color} className="h-10 w-10 shrink-0 rounded-xl" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-text transition-colors group-hover:text-gold-text">{provider.name}</span>
          <span className={`mt-1 flex items-center gap-1.5 text-[11px] ${connected && simpleEnabled ? 'text-success' : attention ? 'text-gold-text' : 'text-muted'}`}>
            {connected && simpleEnabled && <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />}
            {statusLabel}
          </span>
        </span>
      </div>
      {connected ? (
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

export function ProviderCard({ provider, detailHref, onManage, onConnect, mode = 'advanced', simpleEnabled = provider.status === 'connected', onToggle }: { provider: ProviderRecord; detailHref: string; onManage: () => void; onConnect: () => void; mode?: ProviderCardMode; simpleEnabled?: boolean; onToggle?: (enabled: boolean) => void }) {
  if (mode === 'simple') return <SimpleProviderCard provider={provider} detailHref={detailHref} onManage={onManage} onConnect={onConnect} simpleEnabled={simpleEnabled} onToggle={onToggle} />;
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
            <a href={detailHref} className="truncate text-sm font-semibold transition-colors hover:text-gold-text">{provider.name}</a>
            <p className="muted mt-1 truncate text-[11px]">{provider.category}</p>
          </div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[9px] ${status.className}`}>
          <StatusIcon className="h-3 w-3" aria-hidden="true" />
          {status.label}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4 sm:p-5">
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
        <button type="button" onClick={isAvailable ? onConnect : onManage} className={`flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${isAvailable ? 'bg-gold-soft text-gold-text hover:bg-gold/20' : 'text-muted hover:bg-bg-soft hover:text-gold-text'}`}>
          {isAvailable ? 'Connect provider' : 'Manage connection'}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}
