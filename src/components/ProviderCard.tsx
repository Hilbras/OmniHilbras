import { ArrowUpRight, CheckCircle2, CircleAlert, Clock3, Cpu, KeyRound, Server, Zap } from 'lucide-react';
import { ProviderMark } from './ProviderMark';

export type ProviderStatus = 'connected' | 'attention' | 'available';

export type ProviderRecord = {
  id: string;
  catalogId?: string;
  name: string;
  description: string;
  category: string;
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

export function ProviderCard({ provider, detailHref, onManage, onConnect }: { provider: ProviderRecord; detailHref: string; onManage: () => void; onConnect: () => void }) {
  const status = statusMeta(provider.status);
  const StatusIcon = status.icon;
  const isAvailable = provider.status === 'available';

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

        {provider.status !== 'available' && (
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="muted text-[10px]">Route health</span>
              <span className={`font-mono text-[10px] ${provider.status === 'connected' ? 'text-success' : 'text-gold-text'}`}>{provider.health}%</span>
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
