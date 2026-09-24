import { useMemo, useState } from 'react';
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
  X,
} from 'lucide-react';
import { AddProviderModal, providerOptions, type NewProvider } from '../components/AddProviderModal';
import { DashboardShell } from '../components/DashboardShell';
import { ProviderCard, type ProviderRecord, type ProviderStatus } from '../components/ProviderCard';

const initialProviders: ProviderRecord[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT, Responses, embeddings, and audio through the official API.',
    category: 'Multi-model provider',
    status: 'connected',
    auth: 'API key',
    models: '42 models',
    latency: '286 ms',
    requests: '8,921',
    lastUsed: '12 sec ago',
    health: 100,
    color: '#6fdb9b',
    initial: 'O',
    endpoint: 'https://api.openai.com/v1',
    modelList: ['gpt-4.1-mini', 'gpt-4.1', 'text-embedding-3-small'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models with reliable tool use and long-context support.',
    category: 'Multi-model provider',
    status: 'connected',
    auth: 'API key',
    models: '12 models',
    latency: '438 ms',
    requests: '5,284',
    lastUsed: '18 sec ago',
    health: 100,
    color: '#d97757',
    initial: 'A',
    endpoint: 'https://api.anthropic.com/v1',
    modelList: ['claude-sonnet-4', 'claude-opus-4', 'claude-haiku-3-5'],
  },
  {
    id: 'google',
    name: 'Google',
    description: 'Gemini models for multimodal reasoning and fast developer workflows.',
    category: 'Multi-model provider',
    status: 'connected',
    auth: 'API key',
    models: '28 models',
    latency: '512 ms',
    requests: '2,870',
    lastUsed: '41 sec ago',
    health: 98,
    color: '#83b7ff',
    initial: 'G',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    modelList: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-embedding-001'],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Private local inference for coding models and offline development.',
    category: 'Local runtime',
    status: 'attention',
    auth: 'No key',
    models: '6 models',
    latency: '92 ms',
    requests: '1,417',
    lastUsed: '2 min ago',
    health: 72,
    color: '#e2bd52',
    initial: 'L',
    endpoint: 'http://localhost:11434/v1',
    modelList: ['qwen3-coder', 'llama3.2', 'nomic-embed-text'],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    description: 'Efficient open and hosted models for fast, focused responses.',
    category: 'Multi-model provider',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#f97316',
    initial: 'M',
    endpoint: 'https://api.mistral.ai/v1',
    modelList: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'One connection for a broad catalog of hosted models and providers.',
    category: 'Model catalog',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#b995e8',
    initial: 'R',
    endpoint: 'https://openrouter.ai/api/v1',
    modelList: [],
  },
  {
    id: 'custom',
    name: 'Custom endpoint',
    description: 'Connect any OpenAI-compatible gateway, proxy, or local server.',
    category: 'Custom endpoint',
    status: 'available',
    auth: 'API key',
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: '#9c9584',
    initial: 'C',
    endpoint: 'http://localhost:8000/v1',
    modelList: [],
  },
];

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

function ProviderDetails({ provider, onClose }: { provider: ProviderRecord; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 p-0 backdrop-blur-sm sm:items-center sm:p-5" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="provider-detail-title" className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-t-2xl border border-line bg-bg shadow-2xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl border text-xs font-bold" style={{ borderColor: `${provider.color}35`, background: `${provider.color}14`, color: provider.color }}>{provider.initial}</span>
            <div>
              <h2 id="provider-detail-title" className="text-lg font-semibold tracking-tight">{provider.name}</h2>
              <p className="muted mt-1 text-xs">{provider.category}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close provider details" className="muted grid h-9 w-9 place-items-center rounded-lg hover:bg-bg-soft hover:text-gold-text"><X className="h-4 w-4" aria-hidden="true" /></button>
        </div>
        <div className="space-y-5 px-5 py-5 sm:px-6 sm:py-6">
          <p className="muted text-sm leading-relaxed">{provider.description}</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Status', provider.status === 'available' ? 'Available' : provider.status === 'attention' ? 'Attention' : 'Healthy'],
              ['Auth', provider.auth],
              ['Latency', provider.latency],
              ['Requests', provider.requests],
            ].map(([label, value]) => <div key={label} className="rounded-lg border border-line bg-bg-soft p-3"><span className="mono-label block">{label}</span><strong className="mt-1 block truncate font-mono text-xs">{value}</strong></div>)}
          </div>
          <div>
            <span className="mono-label">Endpoint</span>
            <code className="mt-2 block overflow-x-auto rounded-lg border border-line bg-bg-soft px-3 py-2.5 font-mono text-[11px] text-muted">{provider.endpoint}</code>
          </div>
          <div>
            <span className="mono-label">Models</span>
            {provider.modelList.length > 0 ? <div className="mt-2 flex flex-wrap gap-2">{provider.modelList.map((model) => <span key={model} className="rounded-full border border-line bg-bg-soft px-2.5 py-1 font-mono text-[10px] text-muted">{model}</span>)}</div> : <p className="muted mt-2 text-xs">Models will appear after the first connection sync.</p>}
          </div>
          <div className="flex justify-end border-t border-line pt-5"><button type="button" onClick={onClose} className="btn-ghost">Done</button></div>
        </div>
      </div>
    </div>
  );
}

export default function ProvidersPage() {
  const [providers, setProviders] = useState(initialProviders);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [addOpen, setAddOpen] = useState(false);
  const [initialProviderId, setInitialProviderId] = useState<string | undefined>();
  const [selectedProvider, setSelectedProvider] = useState<ProviderRecord | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [notice, setNotice] = useState('');

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

  function openAdd(providerId?: string) {
    setInitialProviderId(providerId);
    setAddOpen(true);
  }

  function handleSave(newProvider: NewProvider) {
    const option = providerOptions.find((item) => item.id === newProvider.providerId) ?? providerOptions[0];
    const record: ProviderRecord = {
      id: `${option.id}-${Date.now()}`,
      name: newProvider.name,
      description: option.description,
      category: option.id === 'custom' ? 'Custom endpoint' : option.auth === 'No key' ? 'Local runtime' : 'New connection',
      status: 'connected',
      auth: option.auth,
      models: 'Pending sync',
      latency: '—',
      requests: '0',
      lastUsed: 'just now',
      health: 100,
      color: option.color,
      initial: option.initial,
      endpoint: newProvider.endpoint,
      modelList: [],
    };
    setProviders((current) => [record, ...current]);
    setAddOpen(false);
    setInitialProviderId(undefined);
    setNotice(`${newProvider.name} was added to the local provider list.`);
    window.setTimeout(() => setNotice(''), 3500);
  }

  function testAll() {
    setTestingAll(true);
    window.setTimeout(() => {
      setTestingAll(false);
      setNotice(`${connectedCount + attentionCount} provider connections responded.`);
      window.setTimeout(() => setNotice(''), 3500);
    }, 900);
  }

  return (
    <DashboardShell activePage="providers" pageTitle="Providers" pageDescription="Connect and manage the routes behind your gateway">
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

        <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Provider summary">
          <SummaryCard label="Connected" value={String(connectedCount)} detail="live" icon={Network} tone="border-success/20 bg-success/10 text-success" />
          <SummaryCard label="Needs attention" value={String(attentionCount)} detail="review" icon={CircleAlert} tone="border-gold/25 bg-gold-soft text-gold-text" />
          <SummaryCard label="Available" value={String(availableCount)} detail="ready to add" icon={Server} tone="border-line-strong bg-surface-2 text-muted" />
          <SummaryCard label="Route health" value="92%" detail="last 24 hours" icon={Activity} tone="border-[#83b7ff]/25 bg-[#83b7ff]/10 text-[#5d98e8]" />
        </section>

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
                <div className="flex overflow-x-auto rounded-lg border border-line bg-bg-soft p-0.5" role="tablist" aria-label="Filter providers">
                  {filterOptions.map((option) => <button key={option.value} type="button" role="tab" aria-selected={filter === option.value} onClick={() => setFilter(option.value)} className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-[10px] font-medium transition-colors ${filter === option.value ? 'bg-surface text-gold-text shadow-sm' : 'text-muted hover:text-text'}`}>{option.label}</button>)}
                </div>
              </div>
            </div>

            {filteredProviders.length > 0 ? <div className="grid gap-4 p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-3">{filteredProviders.map((provider) => <ProviderCard key={provider.id} provider={provider} onManage={() => setSelectedProvider(provider)} onConnect={() => openAdd(provider.id)} />)}</div> : <div className="px-5 py-14 text-center"><Search className="mx-auto h-7 w-7 text-muted" aria-hidden="true" /><p className="mt-3 text-sm font-semibold">No providers found</p><p className="muted mt-1 text-xs">Try a different search or status filter.</p></div>}
          </div>
        </section>

        <div className="mt-5 flex flex-col items-start justify-between gap-3 rounded-xl border border-gold/20 bg-gold-soft/45 px-4 py-3.5 sm:flex-row sm:items-center sm:px-5">
          <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" aria-hidden="true" /><div><p className="text-xs font-semibold">Local credentials stay local.</p><p className="muted mt-1 text-[11px]">This preview does not send provider keys anywhere. The real gateway will encrypt and manage them on your machine.</p></div></div>
          <span className="font-mono text-[10px] text-gold-text">BYOK · local mode</span>
        </div>
      </div>

      <AddProviderModal open={addOpen} initialProviderId={initialProviderId} onClose={() => { setAddOpen(false); setInitialProviderId(undefined); }} onSave={handleSave} />
      {selectedProvider && <ProviderDetails provider={selectedProvider} onClose={() => setSelectedProvider(null)} />}
    </DashboardShell>
  );
}
