import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Copy,
  Cpu,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Zap,
} from 'lucide-react';
import { AddProviderModal, type NewProvider } from '../components/AddProviderModal';
import { DashboardShell } from '../components/DashboardShell';
import { ProviderMark } from '../components/ProviderMark';
import { getGatewayHealth } from '../lib/gatewayClient';
import { getProviderById } from '../data/providers';
import type { ProviderRecord, ProviderStatus } from '../components/ProviderCard';

export const fallbackProvider: ProviderRecord = {
  id: 'custom',
  name: 'Custom provider',
  description: 'An OpenAI-compatible provider connected to the local gateway.',
  category: 'Custom endpoint',
  group: 'custom',
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
};

function providerFromLocation(): ProviderRecord {
  const id = new URLSearchParams(window.location.search).get('provider');
  return getProviderById(id) ?? fallbackProvider;
}

function statusMeta(status: ProviderStatus) {
  if (status === 'connected') return { label: 'Connected', className: 'border-success/25 bg-success/10 text-success', dot: 'bg-success' };
  if (status === 'attention') return { label: 'Needs attention', className: 'border-gold/30 bg-gold-soft text-gold-text', dot: 'bg-gold' };
  return { label: 'Not connected', className: 'border-line-strong bg-surface-2 text-muted', dot: 'bg-muted' };
}

function DetailStat({ label, value, icon: Icon, tone = 'muted' }: { label: string; value: string; icon: typeof Activity; tone?: 'muted' | 'green' | 'gold' | 'blue' }) {
  const toneClass = { muted: 'text-muted', green: 'text-success', gold: 'text-gold-text', blue: 'text-[#5d98e8]' }[tone];
  return <div className="rounded-xl border border-line bg-bg-soft/70 p-3.5"><Icon className={`h-4 w-4 ${toneClass}`} aria-hidden="true" /><p className="muted mt-3 text-[10px] uppercase tracking-[0.1em]">{label}</p><p className="mt-1 truncate font-mono text-sm font-semibold">{value}</p></div>;
}

function ConnectionRow({ provider, testing, onTest, onEdit }: { provider: ProviderRecord; testing: boolean; onTest: () => void; onEdit: () => void }) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-bg-soft/55 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-success/20 bg-success/10 text-success"><KeyRound className="h-4 w-4" aria-hidden="true" /></span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{provider.name} · local connection</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/20 bg-success/10 px-2 py-0.5 font-mono text-[9px] text-success"><span className="h-1.5 w-1.5 rounded-full bg-success" />healthy</span>
            <span className="rounded-full border border-line-strong px-2 py-0.5 font-mono text-[9px] text-muted">{provider.auth}</span>
            <span className="font-mono text-[10px] text-muted">priority #1</span>
          </div>
          <p className="muted mt-2 truncate font-mono text-[10px]">{provider.endpoint}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" onClick={onTest} disabled={testing} className="btn-ghost !px-3 !py-2 !text-xs">{testing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}{testing ? 'Testing' : 'Test'}</button>
        <button type="button" onClick={onEdit} className="btn-quiet !px-2 !py-2 text-xs"><SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />Edit</button>
      </div>
    </div>
  );
}

function ModelRow({ model, providerId, onCopy, onTest, testing, testState }: { model: string; providerId: string; onCopy: () => void; onTest: () => void; testing: boolean; testState: 'idle' | 'testing' | 'ok' | 'error' }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-bg-soft/45 p-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${testState === 'ok' ? 'border-success/25 bg-success/10 text-success' : testState === 'error' ? 'border-danger/25 bg-danger/10 text-danger' : 'border-line bg-surface text-muted'}`}>
          {testState === 'ok' ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : testState === 'error' ? <CircleAlert className="h-4 w-4" aria-hidden="true" /> : <Cpu className="h-4 w-4" aria-hidden="true" />}
        </span>
        <div className="min-w-0"><p className="truncate text-xs font-semibold">{model}</p><code className="mt-1 block truncate font-mono text-[10px] text-muted">{providerId}/{model}</code></div>
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onCopy} aria-label={`Copy ${model} model ID`} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface hover:text-gold-text"><Copy className="h-3.5 w-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={onTest} disabled={testing} className="btn-quiet !px-2 !py-2 text-[11px]">{testing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Zap className="h-3.5 w-3.5" aria-hidden="true" />}Test</button>
      </div>
    </div>
  );
}

function AddModelForm({ onAdd }: { onAdd: (model: string) => void }) {
  const [model, setModel] = useState('');
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="block flex-1"><span className="mono-label mb-2 block">Add custom model ID</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="e.g. gpt-4.1-mini" className="input font-mono !text-xs" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (model.trim()) { onAdd(model.trim()); setModel(''); } } }} /></label>
      <button type="button" onClick={() => { if (model.trim()) { onAdd(model.trim()); setModel(''); } }} disabled={!model.trim()} className="btn-ghost !px-3 !py-2.5 !text-xs"><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add model</button>
    </div>
  );
}

export function ProviderDetailContent({ provider }: { provider: ProviderRecord }) {
  const [addOpen, setAddOpen] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionAdded, setConnectionAdded] = useState(provider.status !== 'available');
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [modelTests, setModelTests] = useState<Record<string, 'idle' | 'testing' | 'ok' | 'error'>>({});
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [strategy, setStrategy] = useState('balanced');
  const [notice, setNotice] = useState('');
  const [copiedModel, setCopiedModel] = useState<string | null>(null);
  const meta = statusMeta(connectionAdded ? (provider.status === 'available' ? 'connected' : provider.status) : 'available');
  const allModels = useMemo(() => [...provider.modelList, ...customModels], [customModels, provider.modelList]);

  function flash(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 3200);
  }

  async function testConnection() {
    setTestingConnection(true);
    try {
      const health = await getGatewayHealth();
      const providerHealth = health.providers.find((item) => item.providerId === provider.id);
      if (!providerHealth || providerHealth.status !== 'healthy') throw new Error(`${provider.name} is not connected to the local gateway.`);
      flash(`${provider.name} connection is healthy.`);
    } catch (error) {
      flash(error instanceof Error ? error.message : 'The local gateway could not verify this connection.');
    } finally {
      setTestingConnection(false);
    }
  }

  function handleAddConnection(newProvider: NewProvider) {
    setConnectionAdded(true);
    setAddOpen(false);
    flash(`${newProvider.name} connection added.`);
  }

  function handleAddConnections(newProviders: NewProvider[]) {
    setConnectionAdded(true);
    setAddOpen(false);
    flash(`${newProviders.length} ${newProviders.length === 1 ? 'connection' : 'connections'} added.`);
  }

  function addModel(model: string) {
    if (allModels.includes(model)) {
      flash('That model is already in the list.');
      return;
    }
    setCustomModels((current) => [...current, model]);
    flash(`${model} added to the provider catalog.`);
  }

  function testModel(model: string) {
    if (testingModel) return;
    setTestingModel(model);
    setModelTests((current) => ({ ...current, [model]: 'testing' }));
    window.setTimeout(() => {
      setModelTests((current) => ({ ...current, [model]: 'ok' }));
      setTestingModel(null);
    }, 700);
  }

  async function copyModel(model: string) {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(`${provider.id}/${model}`);
      setCopiedModel(model);
      window.setTimeout(() => setCopiedModel(null), 1600);
    } catch {
      setCopiedModel(null);
    }
  }

  return (
    <>
      <div className="mb-6">
        <a href="#/providers" className="btn-quiet -ml-2 mb-4 !px-2 !py-1.5 text-xs"><ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />Back to providers</a>
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
          <div className="flex min-w-0 items-start gap-3.5 sm:gap-4">
            <ProviderMark logo={provider.logo} initial={provider.initial} color={provider.color} className="h-12 w-12 rounded-xl text-sm" />
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2.5"><h2 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">{provider.name}</h2><span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[9px] ${meta.className}`}><span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />{meta.label}</span></div><p className="muted mt-1 text-sm">{provider.description}</p></div>
          </div>
          <div className="flex shrink-0 items-center gap-2"><button type="button" onClick={testConnection} disabled={testingConnection} className="btn-ghost !px-3 !py-2.5 !text-xs">{testingConnection ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}{testingConnection ? 'Testing' : 'Test connection'}</button><button type="button" onClick={() => setAddOpen(true)} className="btn-gold !px-3 !py-2.5 !text-xs"><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add connection</button></div>
        </div>
      </div>

      {notice && <div role="status" className="mb-5 flex items-center gap-2 rounded-xl border border-success/25 bg-success/10 px-3.5 py-3 text-xs text-success"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />{notice}</div>}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <DetailStat label="Connections" value={connectionAdded ? '1 active' : '0'} icon={KeyRound} tone={connectionAdded ? 'green' : 'muted'} />
        <DetailStat label="Models" value={allModels.length > 0 ? String(allModels.length) : '—'} icon={Cpu} tone="blue" />
        <DetailStat label="Latency" value={provider.latency} icon={Clock3} tone="gold" />
        <DetailStat label="Route health" value={connectionAdded ? `${provider.health || 100}%` : '—'} icon={Activity} tone={connectionAdded ? 'green' : 'muted'} />
      </div>

      <section className="card mt-5 overflow-hidden" aria-labelledby="connections-title">
        <div className="flex flex-col justify-between gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:p-5"><div><h2 id="connections-title" className="text-sm font-semibold">Connections</h2><p className="muted mt-1 text-xs">Credentials and endpoints used by this provider.</p></div><span className="rounded-full border border-line bg-bg-soft px-2.5 py-1 font-mono text-[10px] text-muted">{connectionAdded ? '1 connection' : 'No connection'}</span></div>
        <div className="p-4 sm:p-5">
          {connectionAdded ? <ConnectionRow provider={provider} testing={testingConnection} onTest={testConnection} onEdit={() => setAddOpen(true)} /> : <div className="flex flex-col items-center justify-between gap-4 rounded-xl border border-dashed border-line-strong p-6 text-center sm:flex-row sm:text-left"><div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text"><Server className="h-4 w-4" aria-hidden="true" /></span><div><p className="text-sm font-semibold">No connection yet</p><p className="muted mt-1 text-xs">Add an API key or point OmniHilbras at a local endpoint.</p></div></div><button type="button" onClick={() => setAddOpen(true)} className="btn-gold !px-3 !py-2 !text-xs">Add connection <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></button></div>}
        </div>
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
        <section className="card min-w-0 p-4 sm:p-5" aria-labelledby="models-title">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><h2 id="models-title" className="text-sm font-semibold">Available models</h2><p className="muted mt-1 text-xs">Models currently exposed by this provider route.</p></div><span className="rounded-full border border-line bg-bg-soft px-2.5 py-1 font-mono text-[10px] text-muted">{allModels.length} models</span></div>
          <div className="mt-5 space-y-2">{allModels.length > 0 ? allModels.map((model) => <ModelRow key={model} model={model} providerId={provider.id} onCopy={() => void copyModel(model)} onTest={() => testModel(model)} testing={testingModel === model} testState={modelTests[model] ?? 'idle'} />) : <div className="rounded-xl border border-dashed border-line-strong px-5 py-9 text-center"><Cpu className="mx-auto h-6 w-6 text-muted" aria-hidden="true" /><p className="mt-3 text-sm font-semibold">No models discovered</p><p className="muted mt-1 text-xs">Connect the provider or add a custom model ID below.</p></div>}</div>
          <div className="mt-5 border-t border-line pt-5"><AddModelForm onAdd={addModel} /></div>
          {copiedModel && <p role="status" className="mt-3 flex items-center gap-1.5 text-[11px] text-success"><Check className="h-3.5 w-3.5" aria-hidden="true" />Copied {provider.id}/{copiedModel}</p>}
        </section>

        <section className="card min-w-0 p-4 sm:p-5" aria-labelledby="policy-title">
          <div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text"><SlidersHorizontal className="h-4 w-4" aria-hidden="true" /></span><div><h2 id="policy-title" className="text-sm font-semibold">Routing policy</h2><p className="muted mt-0.5 text-xs">How this provider participates.</p></div></div>
          <label className="mt-6 block"><span className="mono-label mb-2 block">Strategy</span><select value={strategy} onChange={(event) => { setStrategy(event.target.value); flash(`Policy changed to ${event.target.value}.`); }} className="input !py-2.5 !text-xs"><option value="balanced">Balanced · quality and cost</option><option value="fast">Fastest response</option><option value="cheap">Lowest cost</option><option value="private">Prefer private routes</option></select></label>
          <div className="mt-5 space-y-3 border-t border-line pt-5"><div className="flex items-center justify-between text-xs"><span className="muted">Endpoint</span><button type="button" onClick={() => document.getElementById('endpoint')?.scrollIntoView({ behavior: 'smooth' })} className="max-w-[180px] truncate text-left font-mono text-[10px] text-gold-text hover:underline">{provider.endpoint}</button></div><div className="flex items-center justify-between text-xs"><span className="muted">Priority</span><span className="font-mono text-[10px]">#1</span></div><div className="flex items-center justify-between text-xs"><span className="muted">Credentials</span><span className="flex items-center gap-1.5 font-mono text-[10px] text-success"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />local only</span></div></div>
          <div className="mt-5 rounded-lg border border-gold/20 bg-gold-soft/45 p-3 text-[11px] leading-relaxed text-muted"><Sparkles className="mr-1 inline h-3.5 w-3.5 text-gold-text" aria-hidden="true" />Policy changes are preview-only until the local gateway API is connected.</div>
        </section>
      </div>

      <section id="endpoint" className="card mt-5 p-4 sm:p-5"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><h2 className="text-sm font-semibold">Endpoint details</h2><p className="muted mt-1 text-xs">The base URL OmniHilbras will use for this provider.</p></div><code className="max-w-full overflow-x-auto rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-[11px] text-muted sm:max-w-[420px]">{provider.endpoint}</code></div></section>

      <AddProviderModal open={addOpen} initialProviderId={provider.id} onClose={() => setAddOpen(false)} onSave={handleAddConnection} onSaveMany={handleAddConnections} />
    </>
  );
}

export default function ProviderDetailPage() {
  const provider = useMemo(providerFromLocation, []);

  useEffect(() => {
    document.title = `${provider.name} — OmniHilbras`;
  }, [provider.name]);

  return <DashboardShell activePage="providers" pageTitle={provider.name} pageDescription="Provider connection details"><ProviderDetailContent provider={provider} /></DashboardShell>;
}
