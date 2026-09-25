import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { AddProviderModal, providerOptions, type NewProvider } from '../components/AddProviderModal';
import { DashboardShell } from '../components/DashboardShell';
import { ProviderCard, providerGroupLabels, providerGroupOrder, type ProviderCardMode, type ProviderGroup, type ProviderRecord, type ProviderStatus } from '../components/ProviderCard';
import { getGatewayHealth, listGatewayConnections, saveOpenRouterConnection, type GatewayConnection, type GatewayHealth } from '../lib/gatewayClient';
import { providerRoute } from '../lib/routes';
import { providerCatalog } from '../data/providers';

type Filter = 'all' | 'connected' | 'attention' | 'available';

const filterOptions: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'connected', label: 'Connected' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'available', label: 'Available' },
];

function matchesStatus(status: ProviderStatus, filter: Filter) {
  if (filter === 'all') return true;
  return status === filter;
}

function groupForNewProvider(providerId: string, auth: string): ProviderGroup {
  if (providerId === 'custom') return 'custom';
  if (providerId === 'ollama' || auth === 'No key') return 'local';
  if (providerId === 'openrouter') return 'api-key';
  if (providerId === 'mistral') return 'free-tier';
  if (auth === 'OAuth') return 'oauth';
  return 'hosted';
}

function recordForNewProvider(newProvider: NewProvider, index = 0): ProviderRecord {
  const option = providerOptions.find((item) => item.id === newProvider.providerId) ?? providerOptions[0];
  return {
    id: `${option.id}-${Date.now()}-${index}`,
    catalogId: option.id,
    name: newProvider.name,
    description: option.description,
    category: option.id === 'custom' ? 'Custom endpoint' : option.auth === 'No key' ? 'Local runtime' : 'New connection',
    group: groupForNewProvider(option.id, option.auth),
    status: 'connected',
    auth: option.auth,
    models: 'Pending sync',
    latency: '—',
    requests: '0',
    lastUsed: 'just now',
    health: 100,
    color: option.color,
    initial: option.initial,
    logo: option.logo,
    endpoint: newProvider.endpoint,
    modelList: [],
  };
}

function mergeGatewayConnections(providers: ProviderRecord[], connections: GatewayConnection[], health?: GatewayHealth) {
  const connectionByProvider = new Map(connections.map((connection) => [connection.providerId, connection]));
  const healthByProvider = new Map(health?.providers.map((provider) => [provider.providerId, provider]));
  return providers.map((provider) => {
    const connection = connectionByProvider.get(provider.catalogId ?? provider.id);
    if (!connection) return provider;
    const providerHealth = healthByProvider.get(connection.providerId);
    const liveHealthy = providerHealth?.status === 'healthy';
    const modelIds = connection.modelIds ?? [];
    return {
      ...provider,
      status: connection.hasCredential && connection.enabled && providerHealth?.status !== 'unavailable' && providerHealth?.status !== 'degraded' ? 'connected' : 'attention',
      endpoint: connection.endpoint,
      lastUsed: liveHealthy ? 'just now' : 'saved locally',
      latency: providerHealth?.latencyMs === undefined ? '—' : `${providerHealth.latencyMs} ms`,
      health: liveHealthy ? 100 : 0,
      models: modelIds.length > 0 ? `${modelIds.length} models · ${connection.modelPolicy === 'free' ? 'free import' : 'all import'}` : connection.hasCredential ? 'No imported models' : '—',
      modelList: modelIds,
    } satisfies ProviderRecord;
  });
}

function SummaryCard({ label, value, detail, icon: Icon, tone }: { label: string; value: string; detail: string; icon: typeof Activity; tone: string }) {
  return (
    <article className="card min-w-0 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${tone}`}><Icon className="h-[17px] w-[17px]" aria-hidden="true" /></span>
        <span className="muted font-mono text-[10px]">{detail}</span>
      </div>
      <p className="muted mt-5 text-[10px] font-semibold uppercase tracking-[0.1em]">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tracking-tight">{value}</p>
    </article>
  );
}

export function ProvidersContent() {
  const navigate = useNavigate();
  const [providers, setProviders] = useState(providerCatalog);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [cardMode, setCardMode] = useState<ProviderCardMode>('simple');
  const [disabledProviderIds, setDisabledProviderIds] = useState<Set<string>>(() => new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [initialProviderId, setInitialProviderId] = useState<string | undefined>();
  const [initialModelPolicy, setInitialModelPolicy] = useState<'free' | 'all'>();
  const [testingAll, setTestingAll] = useState(false);
  const [gatewayConnections, setGatewayConnections] = useState<GatewayConnection[]>([]);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void listGatewayConnections()
      .then(async (connections) => {
        let health: GatewayHealth | undefined;
        try { health = await getGatewayHealth(); } catch { /* metadata can load before health */ }
        if (!active) return;
        setGatewayConnections(connections);
        setProviders((current) => mergeGatewayConnections(current, connections, health));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const connectedCount = providers.filter((provider) => provider.status === 'connected').length;
  const attentionCount = providers.filter((provider) => provider.status === 'attention').length;
  const availableCount = providers.filter((provider) => provider.status === 'available').length;
  const filteredProviders = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return providers.filter((provider) => {
      const matchesQuery = !normalized || `${provider.name} ${provider.description} ${provider.category}`.toLowerCase().includes(normalized);
      return matchesQuery && matchesStatus(provider.status, filter);
    });
  }, [filter, providers, query]);
  const groupedProviders = useMemo(() => providerGroupOrder
    .map((group) => ({ group, providers: filteredProviders.filter((provider) => provider.group === group) }))
    .filter((group) => group.providers.length > 0), [filteredProviders]);

  function openAdd(providerId?: string) {
    setInitialProviderId(providerId);
    setInitialModelPolicy(providerId ? gatewayConnections.find((connection) => connection.providerId === providerId)?.modelPolicy : undefined);
    setAddOpen(true);
  }

  function toggleProvider(providerId: string, enabled: boolean) {
    setDisabledProviderIds((current) => {
      const next = new Set(current);
      if (enabled) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
    setNotice(enabled ? 'Provider connection enabled.' : 'Provider connection disabled.');
    window.setTimeout(() => setNotice(''), 2500);
  }

  function finishAdd(added: NewProvider[]) {
    setProviders((current) => [...added.map((provider, index) => recordForNewProvider(provider, index)), ...current]);
    setAddOpen(false);
    setInitialProviderId(undefined);
    setInitialModelPolicy(undefined);
    setNotice(`${added.length} ${added.length === 1 ? 'connection was' : 'connections were'} added to the local provider list.`);
    window.setTimeout(() => setNotice(''), 3500);
  }

  async function handleSave(newProvider: NewProvider, apiKey?: string) {
    if (newProvider.providerId === 'openrouter') {
      if (!apiKey) throw new Error('Enter the OpenRouter API key before saving.');
      const connection = await saveOpenRouterConnection({
        name: newProvider.name,
        apiKey,
        priority: newProvider.priority ?? 1,
        proxyPool: newProvider.proxyPool ?? 'none',
        modelPolicy: newProvider.modelPolicy ?? 'all',
      });
      setGatewayConnections((current) => [...current.filter((item) => item.providerId !== connection.providerId), connection]);
      setProviders((current) => mergeGatewayConnections(current, [connection]));
      setAddOpen(false);
      setInitialProviderId(undefined);
      setInitialModelPolicy(undefined);
      setNotice(`OpenRouter connection saved with ${connection.modelIds.length} models (${connection.modelPolicy === 'free' ? 'free import' : 'all import'}).`);
      window.setTimeout(() => setNotice(''), 3500);
      return;
    }
    finishAdd([newProvider]);
  }

  function handleSaveMany(newProviders: NewProvider[]) {
    finishAdd(newProviders);
  }

  async function testAll() {
    setTestingAll(true);
    try {
      const health = await getGatewayHealth();
      setProviders((current) => mergeGatewayConnections(current, gatewayConnections, health));
      const healthyCount = health.providers.filter((provider) => provider.status === 'healthy').length;
      setNotice(`${healthyCount} of ${health.providers.length} provider connections are healthy.`);
    } catch {
      setNotice('Local gateway unavailable. Start it with pnpm dev:gateway.');
    } finally {
      setTestingAll(false);
      window.setTimeout(() => setNotice(''), 3500);
    }
  }

  function renderProviderCard(provider: ProviderRecord) {
    const detailTo = providerRoute(provider.catalogId ?? provider.id);
    const simpleEnabled = provider.status === 'connected' && !disabledProviderIds.has(provider.id);
    return <ProviderCard key={provider.id} provider={provider} detailTo={detailTo} mode={cardMode} simpleEnabled={simpleEnabled} onToggle={(enabled) => toggleProvider(provider.id, enabled)} onManage={() => navigate(detailTo)} onConnect={() => openAdd(provider.catalogId ?? provider.id)} />;
  }

  return (
    <>
      <div id="providers">
        <div className="mb-6 flex flex-col justify-between gap-5 sm:mb-8 sm:flex-row sm:items-end">
          <div>
            <span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Provider control plane</span>
            <h2 className="mt-4 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Your provider layer.</h2>
            <p className="muted mt-2 max-w-xl text-sm leading-relaxed">Bring every model provider behind one route. Credentials stay in your local workspace while OmniHilbras handles selection and fallback.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={testAll} disabled={testingAll} className="btn-ghost !px-3 !py-2.5 !text-xs"><RefreshCw className={`h-3.5 w-3.5 ${testingAll ? 'animate-spin' : ''}`} aria-hidden="true" />{testingAll ? 'Testing' : 'Test all'}</button>
            <button type="button" onClick={() => openAdd()} className="btn-gold !px-3 !py-2.5 !text-xs"><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add provider</button>
          </div>
        </div>

        {notice && <div role="status" className="mb-5 flex items-center gap-2 rounded-xl border border-success/25 bg-success/10 px-3.5 py-3 text-xs text-success"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{notice}</div>}

        {cardMode === 'advanced' && (
          <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Provider summary">
            <SummaryCard label="Connected" value={String(connectedCount)} detail="live" icon={Network} tone="border-success/20 bg-success/10 text-success" />
            <SummaryCard label="Needs attention" value={String(attentionCount)} detail="review" icon={CircleAlert} tone="border-gold/25 bg-gold-soft text-gold-text" />
            <SummaryCard label="Available" value={String(availableCount)} detail="ready to add" icon={Server} tone="border-line-strong bg-surface-2 text-muted" />
            <SummaryCard label="Route health" value="92%" detail="last 24 hours" icon={Activity} tone="border-[#83b7ff]/25 bg-[#83b7ff]/10 text-[#5d98e8]" />
          </section>
        )}

        <section className="mt-5" aria-labelledby="provider-list-title">
          <div className="card overflow-hidden">
            <div className="flex flex-col gap-4 border-b border-line p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 id="provider-list-title" className="text-sm font-semibold">All providers</h2>
                <p className="muted mt-1 text-xs">Manage connections, inspect health, and add new routes.</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <label className="relative block">
                  <span className="sr-only">Search providers</span>
                  <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search providers" className="input !h-9 !w-full !py-2 !pl-9 !text-xs sm:!w-48" />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex overflow-x-auto rounded-lg border border-line bg-bg-soft p-0.5" role="tablist" aria-label="Filter providers">
                    {filterOptions.map((option) => <button key={option.value} type="button" role="tab" aria-selected={filter === option.value} onClick={() => setFilter(option.value)} className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-[10px] font-medium transition-colors ${filter === option.value ? 'bg-surface text-gold-text shadow-sm' : 'text-muted hover:text-text'}`}>{option.label}</button>)}
                  </div>
                  <div className="flex rounded-lg border border-line bg-bg-soft p-0.5" role="tablist" aria-label="Provider card view">
                    <button type="button" role="tab" aria-selected={cardMode === 'simple'} onClick={() => setCardMode('simple')} className={`rounded-md px-2.5 py-1.5 text-[10px] font-medium transition-colors ${cardMode === 'simple' ? 'bg-surface text-gold-text shadow-sm' : 'text-muted hover:text-text'}`}>Simple</button>
                    <button type="button" role="tab" aria-selected={cardMode === 'advanced'} onClick={() => setCardMode('advanced')} className={`rounded-md px-2.5 py-1.5 text-[10px] font-medium transition-colors ${cardMode === 'advanced' ? 'bg-surface text-gold-text shadow-sm' : 'text-muted hover:text-text'}`}>Advanced</button>
                  </div>
                </div>
              </div>
            </div>

            {filteredProviders.length > 0 ? (
              <div className="space-y-6 p-4 sm:p-5">
                {groupedProviders.map(({ group, providers: grouped }) => (
                  <section key={group} aria-labelledby={`provider-group-${group}`}>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 id={`provider-group-${group}`} className="text-sm font-semibold">{providerGroupLabels[group]}</h3>
                      <span className="muted font-mono text-[10px]">{grouped.length} {grouped.length === 1 ? 'provider' : 'providers'}</span>
                    </div>
                    <div className={`grid gap-3 ${cardMode === 'simple' ? 'sm:grid-cols-2 xl:grid-cols-4' : 'md:grid-cols-2 xl:grid-cols-3'}`}>
                      {grouped.map((provider) => renderProviderCard(provider))}
                    </div>
                  </section>
                ))}
              </div>
            ) : <div className="px-5 py-14 text-center"><Search className="mx-auto h-7 w-7 text-muted" aria-hidden="true" /><p className="mt-3 text-sm font-semibold">No providers found</p><p className="muted mt-1 text-xs">Try a different search or status filter.</p></div>}
          </div>
        </section>

        <div className="mt-5 flex flex-col items-start justify-between gap-3 rounded-xl border border-gold/20 bg-gold-soft/45 px-4 py-3.5 sm:flex-row sm:items-center sm:px-5">
          <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" aria-hidden="true" /><div><p className="text-xs font-semibold">Local credentials stay local.</p><p className="muted mt-1 text-[11px]">OpenRouter keys are validated by the loopback gateway and stored in the local encrypted vault.</p></div></div>
          <span className="font-mono text-[10px] text-gold-text">BYOK · local mode</span>
        </div>
      </div>

      <AddProviderModal open={addOpen} initialProviderId={initialProviderId} initialModelPolicy={initialModelPolicy} onClose={() => { setAddOpen(false); setInitialProviderId(undefined); setInitialModelPolicy(undefined); }} onSave={handleSave} onSaveMany={handleSaveMany} />
    </>
  );
}

export default function ProvidersPage() {
  return <DashboardShell activePage="providers" pageTitle="Providers" pageDescription="Connect and manage the routes behind your gateway"><ProvidersContent /></DashboardShell>;
}
