import { useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Copy,
  DollarSign,
  ExternalLink,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';
import { DashboardShell } from '../components/DashboardShell';
import { ProviderMark } from '../components/ProviderMark';
import { getProviderLogo } from '../data/providers';

type Range = '24h' | '7d' | '30d';
type Metric = 'requests' | 'latency' | 'cost';

type Provider = {
  id: string;
  name: string;
  model: string;
  requests: string;
  latency: string;
  status: 'healthy' | 'degraded' | 'offline';
  color: string;
  initial: string;
};

const providers: Provider[] = [
  { id: 'openai', name: 'OpenAI', model: 'gpt-4.1-mini', requests: '8,921', latency: '286 ms', status: 'healthy', color: '#6fdb9b', initial: 'O' },
  { id: 'anthropic', name: 'Anthropic', model: 'claude-sonnet-4', requests: '5,284', latency: '438 ms', status: 'healthy', color: '#d97757', initial: 'A' },
  { id: 'google', name: 'Google', model: 'gemini-2.5-pro', requests: '2,870', latency: '512 ms', status: 'healthy', color: '#83b7ff', initial: 'G' },
  { id: 'ollama', name: 'Ollama', model: 'qwen3-coder', requests: '1,417', latency: '92 ms', status: 'degraded', color: '#e2bd52', initial: 'L' },
];

const chartValues: Record<Range, Record<Metric, number[]>> = {
  '24h': {
    requests: [42, 58, 46, 72, 64, 88, 76, 94, 82, 106, 98, 118],
    latency: [78, 72, 84, 69, 76, 62, 70, 58, 64, 54, 60, 48],
    cost: [30, 38, 34, 48, 42, 56, 50, 64, 58, 72, 66, 78],
  },
  '7d': {
    requests: [48, 62, 55, 78, 70, 96, 88],
    latency: [84, 76, 80, 68, 72, 58, 62],
    cost: [32, 44, 40, 56, 50, 68, 62],
  },
  '30d': {
    requests: [36, 48, 44, 58, 52, 66, 61, 74, 68, 82, 78, 94],
    latency: [92, 86, 88, 80, 82, 72, 76, 68, 70, 62, 66, 56],
    cost: [28, 34, 32, 42, 38, 48, 44, 54, 50, 62, 58, 70],
  },
};

const chartLabels: Record<Range, string[]> = {
  '24h': ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'],
  '7d': ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  '30d': ['1', '5', '10', '15', '20', '25', '30'],
};

const metricConfig: Record<Metric, { label: string; suffix: string; color: string }> = {
  requests: { label: 'Requests', suffix: 'req', color: '#d4af37' },
  latency: { label: 'Latency', suffix: 'ms', color: '#83b7ff' },
  cost: { label: 'Estimated cost', suffix: 'USD', color: '#6fdb9b' },
};

function makeLinePath(values: number[], width = 720, height = 190) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  return values
    .map((value, index) => {
      const x = (index / Math.max(values.length - 1, 1)) * width;
      const y = height - ((value - min) / range) * (height - 22) - 10;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function StatCard({ label, value, change, icon: Icon, tone = 'gold' }: { label: string; value: string; change: string; icon: typeof Activity; tone?: 'gold' | 'green' | 'blue' | 'orange' }) {
  const toneClass = {
    gold: 'border-gold/25 bg-gold-soft text-gold-text',
    green: 'border-success/20 bg-success/10 text-success',
    blue: 'border-[#83b7ff]/25 bg-[#83b7ff]/10 text-[#5d98e8]',
    orange: 'border-[#e6a35c]/25 bg-[#e6a35c]/10 text-[#bd762d]',
  }[tone];

  return (
    <article className="card min-w-0 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${toneClass}`}>
          <Icon className="h-[17px] w-[17px]" aria-hidden="true" />
        </span>
        <span className="flex items-center gap-1 font-mono text-[10px] text-success">
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          {change}
        </span>
      </div>
      <p className="muted mt-5 text-[11px] font-medium uppercase tracking-[0.1em]">{label}</p>
      <p className="mt-1 truncate font-mono text-2xl font-semibold tracking-tight sm:text-[28px]">{value}</p>
    </article>
  );
}

function TrafficChart() {
  const [range, setRange] = useState<Range>('24h');
  const [metric, setMetric] = useState<Metric>('requests');
  const values = chartValues[range][metric];
  const linePath = useMemo(() => makeLinePath(values), [values]);
  const areaPath = `${linePath} L 720 190 L 0 190 Z`;
  const labels = chartLabels[range];
  const config = metricConfig[metric];

  return (
    <section className="card min-w-0 p-4 sm:p-5" aria-labelledby="traffic-title">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="flex items-center gap-2">
            <h2 id="traffic-title" className="text-sm font-semibold">Request activity</h2>
            <span className="flex items-center gap-1.5 rounded-full border border-success/20 bg-success/10 px-2 py-0.5 font-mono text-[9px] text-success">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" aria-hidden="true" />
              live
            </span>
          </div>
          <p className="muted mt-1 text-xs">Traffic across all configured routes</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-line bg-bg-soft p-0.5" role="tablist" aria-label="Chart metric">
            {(Object.keys(metricConfig) as Metric[]).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={metric === item}
                onClick={() => setMetric(item)}
                className={`rounded-md px-2.5 py-1.5 text-[10px] font-medium transition-colors ${metric === item ? 'bg-surface text-gold-text shadow-sm' : 'text-muted hover:text-text'}`}
              >
                {metricConfig[item].label}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border border-line bg-bg-soft p-0.5" role="tablist" aria-label="Chart range">
            {(['24h', '7d', '30d'] as Range[]).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={range === item}
                onClick={() => setRange(item)}
                className={`rounded-md px-2.5 py-1.5 text-[10px] font-medium transition-colors ${range === item ? 'bg-surface text-gold-text shadow-sm' : 'text-muted hover:text-text'}`}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 flex items-end gap-3">
        <strong className="font-mono text-2xl tracking-tight">{range === '24h' ? '18,492' : range === '7d' ? '124.8k' : '486.2k'}</strong>
        <span className="muted pb-1 text-xs">{config.label.toLowerCase()} · {config.suffix}</span>
      </div>

      <div className="mt-4 h-[220px] w-full" role="img" aria-label={`${config.label} over the last ${range}`}>
        <svg viewBox="0 0 720 220" className="h-full w-full overflow-visible" preserveAspectRatio="none">
          <defs>
            <linearGradient id="traffic-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={config.color} stopOpacity="0.25" />
              <stop offset="100%" stopColor={config.color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {[22, 68, 114, 160, 206].map((y) => (
            <line key={y} x1="0" x2="720" y1={y} y2={y} stroke="currentColor" strokeOpacity="0.1" strokeDasharray="3 5" />
          ))}
          <path d={areaPath} fill="url(#traffic-area)" />
          <path d={linePath} fill="none" stroke={config.color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
          {values.map((value, index) => {
            const x = (index / Math.max(values.length - 1, 1)) * 720;
            const max = Math.max(...values, 1);
            const min = Math.min(...values, 0);
            const y = 190 - ((value - min) / Math.max(max - min, 1)) * (190 - 22) - 10;
            return <circle key={`${range}-${metric}-${index}`} cx={x} cy={y} r="3" fill={config.color} stroke="var(--surface)" strokeWidth="2" />;
          })}
        </svg>
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-muted">
        {labels.map((label) => <span key={label}>{label}</span>)}
      </div>
    </section>
  );
}

function LiveTraffic() {
  const traffic = [
    { path: '/v1/chat/completions', providerId: 'anthropic', provider: 'Anthropic', model: 'claude-sonnet-4', latency: '438 ms', status: '200', color: '#d97757' },
    { path: '/v1/responses', providerId: 'openai', provider: 'OpenAI', model: 'gpt-4.1-mini', latency: '286 ms', status: '200', color: '#6fdb9b' },
    { path: '/v1/chat/completions', providerId: 'ollama', provider: 'Ollama', model: 'qwen3-coder', latency: '92 ms', status: '200', color: '#e2bd52' },
  ];

  return (
    <section className="card min-w-0 p-4 sm:p-5" aria-labelledby="live-traffic-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="live-traffic-title" className="text-sm font-semibold">Live traffic</h2>
          <p className="muted mt-1 text-xs">The latest requests through your gateway</p>
        </div>
        <button type="button" disabled aria-label="More live traffic options coming soon" title="More options coming soon" className="muted grid h-7 w-7 place-items-center rounded-lg text-muted/60">
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-5 divide-y divide-line/70">
        {traffic.map((item, index) => (
          <div key={`${item.path}-${index}`} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <ProviderMark logo={getProviderLogo(item.providerId)} initial={item.provider.slice(0, 1)} color={item.color} className="h-7 w-7 rounded-lg text-[9px]" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[10px] text-muted">{item.path}</p>
              <p className="mt-1 truncate text-xs font-medium">{item.provider} <span className="muted font-normal">· {item.model}</span></p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-[10px] text-muted">{item.latency}</p>
              <p className="mt-1 font-mono text-[10px] text-success">{item.status}</p>
            </div>
          </div>
        ))}
      </div>

      <a href="#/overview" onClick={(event) => { event.preventDefault(); document.getElementById('request-log')?.scrollIntoView({ behavior: 'smooth' }); }} className="btn-quiet mt-5 w-full justify-center border border-line text-xs">
        View recent activity
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </section>
  );
}

function ProviderHealth() {
  return (
    <section className="card min-w-0 overflow-hidden" aria-labelledby="provider-health-title">
      <div className="flex flex-col justify-between gap-3 border-b border-line px-4 py-4 sm:flex-row sm:items-center sm:px-5">
        <div>
          <h2 id="provider-health-title" className="text-sm font-semibold">Provider health</h2>
          <p className="muted mt-1 text-xs">Every route OmniHilbras can currently reach</p>
        </div>
        <a href="#/providers" className="btn-ghost !px-3 !py-2 !text-xs">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add provider
        </a>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left">
          <thead className="border-b border-line bg-surface-2/50">
            <tr className="mono-label">
              <th className="px-4 py-3 font-normal sm:px-5">Provider</th>
              <th className="px-3 py-3 font-normal">Model</th>
              <th className="px-3 py-3 font-normal">Requests</th>
              <th className="px-3 py-3 font-normal">Latency</th>
              <th className="px-3 py-3 font-normal">Status</th>
              <th className="px-4 py-3 text-right font-normal sm:px-5">Action</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((provider) => (
              <tr key={provider.name} className="border-b border-line/70 last:border-0 hover:bg-surface-2/30">
                <td className="px-4 py-3.5 sm:px-5">
                  <div className="flex items-center gap-2.5">
                    <ProviderMark logo={getProviderLogo(provider.id)} initial={provider.initial} color={provider.color} className="h-7 w-7 rounded-lg text-[10px]" />
                    <span className="text-xs font-semibold">{provider.name}</span>
                  </div>
                </td>
                <td className="px-3 py-3.5 font-mono text-[10px] text-muted">{provider.model}</td>
                <td className="px-3 py-3.5 font-mono text-xs">{provider.requests}</td>
                <td className="px-3 py-3.5 font-mono text-xs text-muted">{provider.latency}</td>
                <td className="px-3 py-3.5">
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 font-mono text-[10px] ${provider.status === 'healthy' ? 'bg-success/10 text-success' : 'bg-gold-soft text-gold-text'}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${provider.status === 'healthy' ? 'bg-success' : 'bg-gold'}`} aria-hidden="true" />
                    {provider.status === 'healthy' ? 'Healthy' : 'Degraded'}
                  </span>
                </td>
                <td className="px-4 py-3.5 text-right sm:px-5">
                  <button type="button" aria-label={`Open ${provider.name} settings`} className="muted inline-grid h-7 w-7 place-items-center rounded-lg hover:bg-bg-soft hover:text-gold-text">
                    <ChevronDown className="h-3.5 w-3.5 -rotate-90" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-line px-4 py-3 sm:px-5">
        <span className="muted flex items-center gap-1.5 text-[11px]"><CircleAlert className="h-3.5 w-3.5 text-gold" aria-hidden="true" />1 provider needs attention</span>
        <a href="#/providers" className="btn-quiet !px-2 !py-1 text-[11px]">Manage providers <ArrowUpRight className="h-3 w-3" aria-hidden="true" /></a>
      </div>
    </section>
  );
}

function QuickStart() {
  const [copied, setCopied] = useState(false);
  const endpoint = 'http://localhost:8787/v1';

  async function copyEndpoint() {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section id="quick-start" className="card min-w-0 p-4 sm:p-5" aria-labelledby="quick-start-title">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text"><KeyRound className="h-4 w-4" aria-hidden="true" /></span>
        <div>
          <h2 id="quick-start-title" className="text-sm font-semibold">Quick start</h2>
          <p className="muted mt-0.5 text-xs">Point any OpenAI-compatible client here.</p>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-2 rounded-lg border border-line bg-bg-soft p-2">
        <code className="min-w-0 flex-1 truncate px-1 font-mono text-[11px] text-muted">{endpoint}</code>
        <button type="button" onClick={() => void copyEndpoint()} aria-label={copied ? 'Endpoint copied' : 'Copy endpoint'} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-gold-text">
          {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      </div>
      <div className="mt-4 flex items-center gap-2 text-[11px] text-muted">
        <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden="true" />
        Local mode · no account required
      </div>
      <a href="/#docs" className="btn-ghost mt-5 w-full !text-xs">Open API reference <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>
    </section>
  );
}

function RecentActivity() {
  const activity = [
    { icon: Zap, title: 'Automatic route selected', detail: 'auto → Anthropic · claude-sonnet-4', time: '12 sec ago', color: 'text-gold-text' },
    { icon: RefreshCw, title: 'Provider health check completed', detail: '4 providers checked · 1 degraded', time: '1 min ago', color: 'text-success' },
    { icon: Server, title: 'Gateway started', detail: 'listening on localhost:8787', time: '8 min ago', color: 'text-[#83b7ff]' },
  ];

  return (
    <section id="request-log" className="card min-w-0 p-4 sm:p-5" aria-labelledby="activity-title">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="activity-title" className="text-sm font-semibold">Recent activity</h2>
          <p className="muted mt-1 text-xs">A small history of your gateway</p>
        </div>
        <span className="mono-label">3 events</span>
      </div>
      <div className="mt-5 space-y-4">
        {activity.map(({ icon: Icon, title, detail, time, color }) => (
          <div key={title} className="flex gap-3">
            <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-line bg-bg-soft ${color}`}><Icon className="h-3.5 w-3.5" aria-hidden="true" /></span>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p className="truncate text-xs font-semibold">{title}</p>
                <span className="shrink-0 font-mono text-[9px] text-muted">{time}</span>
              </div>
              <p className="muted mt-1 truncate font-mono text-[10px]">{detail}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function OverviewHeader() {
  const [refreshing, setRefreshing] = useState(false);

  function refresh() {
    setRefreshing(true);
    window.setTimeout(() => setRefreshing(false), 900);
  }

  return (
    <div className="mb-6 flex flex-col justify-between gap-5 sm:mb-8 sm:flex-row sm:items-end">
      <div>
        <span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Local gateway overview</span>
        <h2 className="mt-4 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Good morning, builder.</h2>
        <p className="muted mt-2 max-w-xl text-sm leading-relaxed">Your routing layer is healthy. Here is what has moved through OmniHilbras recently.</p>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={refresh} className="btn-ghost !px-3 !py-2.5 !text-xs">
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
        <a href="#/providers" className="btn-gold !px-3 !py-2.5 !text-xs">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Connect provider
        </a>
      </div>
    </div>
  );
}

export function DashboardOverviewContent() {
  return (
    <div id="overview">
      <OverviewHeader />

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Gateway summary">
        <StatCard label="Requests today" value="18,492" change="12.8%" icon={Activity} />
        <StatCard label="Success rate" value="99.98%" change="0.04%" icon={CheckCircle2} tone="green" />
        <StatCard label="Avg. latency" value="412 ms" change="8.1%" icon={Clock3} tone="blue" />
        <StatCard label="Est. spend" value="$42.18" change="4.6%" icon={DollarSign} tone="orange" />
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <TrafficChart />
        <LiveTraffic />
      </div>

      <div className="mt-5">
        <ProviderHealth />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <QuickStart />
        <RecentActivity />
      </div>

      <div className="mt-5 flex flex-col items-start justify-between gap-3 rounded-xl border border-gold/20 bg-gold-soft/45 px-4 py-3.5 sm:flex-row sm:items-center sm:px-5">
        <div className="flex items-start gap-3">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" aria-hidden="true" />
          <div>
            <p className="text-xs font-semibold">This dashboard is showing preview data.</p>
            <p className="muted mt-1 text-[11px]">Connect the gateway API to replace these values with live local metrics.</p>
          </div>
        </div>
        <span className="font-mono text-[10px] text-gold-text">v0.1 · local preview</span>
      </div>
    </div>
  );
}

export default function DashboardOverview() {
  return <DashboardShell><DashboardOverviewContent /></DashboardShell>;
}
