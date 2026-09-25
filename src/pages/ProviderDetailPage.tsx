import { useEffect, useMemo, useRef, useState } from 'react';
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
import { addGatewayConnectionModels, getGatewayHealth, listGatewayConnections, saveOpenRouterConnection, testGatewayModel, type GatewayConnection } from '../lib/gatewayClient';
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

function modelReference(providerId: string, model: string) {
  return providerId === 'openrouter' ? model : `${providerId}/${model}`;
}

type ModelTestState = 'idle' | 'testing' | 'ok' | 'error';

function DetailStat({ label, value, icon: Icon, tone = 'muted' }: { label: string; value: string; icon: typeof Activity; tone?: 'muted' | 'green' | 'gold' | 'blue' }) {
  const toneClass = { muted: 'text-muted', green: 'text-success', gold: 'text-gold-text', blue: 'text-[#5d98e8]' }[tone];
  return <div className="rounded-xl border border-line bg-bg-soft/70 p-3.5"><Icon className={`h-4 w-4 ${toneClass}`} aria-hidden="true" /><p className="muted mt-3 text-[10px] uppercase tracking-[0.1em]">{label}</p><p className="mt-1 truncate font-mono text-sm font-semibold">{value}</p></div>;
}

function ConnectionRow({ provider, connection, healthy, testing, onTest, onEdit }: { provider: ProviderRecord; connection?: GatewayConnection; healthy: boolean; testing: boolean; onTest: () => void; onEdit: () => void }) {
  const connectionName = connection?.name ?? provider.name;
  const endpoint = connection?.endpoint ?? provider.endpoint;
  const priority = connection?.priority ?? 1;
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-line bg-bg-soft/55 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-success/20 bg-success/10 text-success"><KeyRound className="h-4 w-4" aria-hidden="true" /></span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{connectionName} · local connection</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[9px] ${healthy ? 'border-success/20 bg-success/10 text-success' : 'border-gold/30 bg-gold-soft text-gold-text'}`}><span className={`h-1.5 w-1.5 rounded-full ${healthy ? 'bg-success' : 'bg-gold'}`} />{healthy ? 'healthy' : 'health pending'}</span>
            <span className="rounded-full border border-line-strong px-2 py-0.5 font-mono text-[9px] text-muted">{provider.auth}</span>
            <span className="font-mono text-[10px] text-muted">priority #{priority}</span>
            {connection && <span className="rounded-full border border-line-strong px-2 py-0.5 font-mono text-[9px] text-muted">{connection.modelPolicy === 'free' ? 'free import' : 'all import'}</span>}
          </div>
          <p className="muted mt-2 truncate font-mono text-[10px]">{endpoint}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" onClick={onTest} disabled={testing} className="btn-ghost !px-3 !py-2 !text-xs">{testing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}{testing ? 'Testing' : 'Test provider'}</button>
        <button type="button" onClick={onEdit} className="btn-quiet !px-2 !py-2 text-xs"><SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />Edit</button>
      </div>
    </div>
  );
}

function ModelRow({ model, providerId, onCopy, onTest, testing, disabled, testState, testDetail }: { model: string; providerId: string; onCopy: () => void; onTest: () => void; testing: boolean; disabled: boolean; testState: ModelTestState; testDetail?: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-bg-soft/45 p-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${testState === 'ok' ? 'border-success/25 bg-success/10 text-success' : testState === 'error' ? 'border-danger/25 bg-danger/10 text-danger' : 'border-line bg-surface text-muted'}`}>
          {testState === 'ok' ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : testState === 'error' ? <CircleAlert className="h-4 w-4" aria-hidden="true" /> : <Cpu className="h-4 w-4" aria-hidden="true" />}
        </span>
        <div className="min-w-0"><p className="truncate text-xs font-semibold">{model}</p><code className="mt-1 block truncate font-mono text-[10px] text-muted">{modelReference(providerId, model)}</code>{testDetail && <p title={testDetail} className={`mt-1 truncate text-[10px] ${testState === 'error' ? 'text-danger' : 'text-success'}`}>{testDetail}</p>}</div>
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onCopy} aria-label={`Copy ${model} model ID`} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface hover:text-gold-text"><Copy className="h-3.5 w-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={onTest} disabled={disabled || testing} aria-label={`Test ${model}`} aria-busy={testing} className="btn-quiet !px-2 !py-2 text-[11px]">{testing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Zap className="h-3.5 w-3.5" aria-hidden="true" />}{testing ? 'Testing' : 'Test'}</button>
      </div>
    </div>
  );
}

function AddModelForm({ onAdd, providerId }: { onAdd: (model: string) => void | Promise<void>; providerId: string }) {
  const [model, setModel] = useState('');
  const [adding, setAdding] = useState(false);

  async function submit() {
    const value = model.trim();
    if (!value || adding) return;
    setAdding(true);
    try {
      await onAdd(value);
      setModel('');
    } catch {
      // The page-level callback presents the actionable error and keeps the input for retry.
    } finally {
      setAdding(false);
    }
  }

  const placeholder = providerId === 'openrouter' ? 'e.g. openai/gpt-4.1-mini' : 'e.g. gpt-4.1-mini';
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="block flex-1"><span className="mono-label mb-2 block">Add custom model ID</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder={placeholder} disabled={adding} className="input font-mono !text-xs disabled:cursor-not-allowed disabled:opacity-60" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }} /></label>
      <button type="button" onClick={() => { void submit(); }} disabled={!model.trim() || adding} aria-busy={adding} className="btn-ghost !px-3 !py-2.5 !text-xs disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-3.5 w-3.5" aria-hidden="true" />{adding ? 'Adding' : 'Add model'}</button>
    </div>
  );
}

export function ProviderDetailContent({ provider }: { provider: ProviderRecord }) {
  const [addOpen, setAddOpen] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connection, setConnection] = useState<GatewayConnection | undefined>();
  const [connectionHealthy, setConnectionHealthy] = useState(false);
  const [connectionAdded, setConnectionAdded] = useState(provider.status !== 'available');
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [modelTests, setModelTests] = useState<Record<string, ModelTestState>>({});
  const [modelTestDetails, setModelTestDetails] = useState<Record<string, string>>({});
  const modelTestAbortRef = useRef<AbortController | null>(null);
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [strategy, setStrategy] = useState('balanced');
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const [copiedModel, setCopiedModel] = useState<string | null>(null);
  const meta = statusMeta(connectionAdded ? (provider.id === 'openrouter' && !connectionHealthy ? 'attention' : provider.status === 'available' ? 'connected' : provider.status) : 'available');

  useEffect(() => {
    if (provider.id !== 'openrouter') return;
    let active = true;
    void listGatewayConnections()
      .then((connections) => {
        if (!active) return;
        const savedConnection = connections.find((item) => item.providerId === 'openrouter' && item.hasCredential);
        setConnection(savedConnection);
        setConnectionAdded(Boolean(savedConnection));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [provider.id]);
  useEffect(() => () => modelTestAbortRef.current?.abort(), []);

  const importedModels = connection?.modelIds ?? provider.modelList;
  const allModels = useMemo(() => [...new Set([...importedModels, ...customModels])], [customModels, importedModels]);

  function flash(message: string, tone: 'success' | 'error' = 'success') {
    setNotice(message);
    setNoticeError(tone === 'error');
    window.setTimeout(() => setNotice(''), 3200);
  }

  async function testConnection() {
    if (testingConnection || testingModel) return;
    setTestingConnection(true);
    try {
      const health = await getGatewayHealth();
      const providerHealth = health.providers.find((item) => item.providerId === provider.id);
      const healthy = providerHealth?.status === 'healthy';
      setConnectionHealthy(healthy);
      if (!healthy) throw new Error(`${provider.name} is not connected to the local gateway.`);
      const latency = providerHealth?.latencyMs === undefined ? '' : ` in ${providerHealth.latencyMs} ms`;
      flash(`${provider.name} provider is healthy${latency}.`);
    } catch (error) {
      flash(error instanceof Error ? error.message : 'The local gateway could not verify this connection.', 'error');
    } finally {
      setTestingConnection(false);
    }
  }

  async function handleAddConnection(newProvider: NewProvider, apiKey?: string) {
    let savedModelCount: number | undefined;
    let savedModelPolicy: 'free' | 'all' | undefined;
    if (newProvider.providerId === 'openrouter') {
      if (!apiKey) throw new Error('Enter the OpenRouter API key before saving.');
      const savedConnection = await saveOpenRouterConnection({
        name: newProvider.name,
        apiKey,
        priority: newProvider.priority ?? 1,
        proxyPool: newProvider.proxyPool ?? 'none',
        modelPolicy: newProvider.modelPolicy ?? 'all',
      });
      setConnection(savedConnection);
      savedModelCount = savedConnection.modelIds.length;
      savedModelPolicy = savedConnection.modelPolicy;
      setConnectionHealthy(false);
    }
    setConnectionAdded(true);
    setAddOpen(false);
    flash(newProvider.providerId === 'openrouter' ? `OpenRouter saved with ${savedModelCount ?? 0} models (${savedModelPolicy === 'free' ? 'free import' : 'all import'}).` : `${newProvider.name} connection added.`);
  }

  function handleAddConnections(newProviders: NewProvider[]) {
    setConnectionAdded(true);
    setAddOpen(false);
    flash(`${newProviders.length} ${newProviders.length === 1 ? 'connection' : 'connections'} added.`);
  }

  async function addModel(model: string) {
    if (allModels.includes(model)) {
      flash('That model is already in the list.');
      return;
    }
    if (provider.id === 'openrouter' && !connection) {
      const message = 'Connect OpenRouter before adding a model to its saved catalog.';
      flash(message, 'error');
      throw new Error(message);
    }
    let persisted = false;
    if (provider.id === 'openrouter' && connection) {
      try {
        const updated = await addGatewayConnectionModels(connection.id, [model]);
        setConnection(updated);
        persisted = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The model could not be saved.';
        flash(message, 'error');
        throw error instanceof Error ? error : new Error(message);
      }
    }
    if (!persisted) setCustomModels((current) => [...current, model]);
    flash(`${model} added to the provider catalog.`);
  }

  async function testModel(model: string) {
    if (testingModel || testingConnection) return;
    const controller = new AbortController();
    modelTestAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    setTestingModel(model);
    setModelTests((current) => ({ ...current, [model]: 'testing' }));
    setModelTestDetails((current) => {
      const next = { ...current };
      delete next[model];
      return next;
    });
    try {
      const result = await testGatewayModel(provider.id, model, controller.signal);
      const preview = result.content.trim().replace(/\s+/g, ' ').slice(0, 80);
      const detail = `Responded in ${result.latencyMs} ms${preview ? `: ${preview}` : ''}`;
      setModelTests((current) => ({ ...current, [model]: 'ok' }));
      setModelTestDetails((current) => ({ ...current, [model]: detail }));
      setConnectionHealthy(true);
      flash(`${model} responded successfully in ${result.latencyMs} ms.`);
    } catch (error) {
      const detail = controller.signal.aborted ? 'Model test timed out or was cancelled.' : error instanceof Error ? error.message : 'The model test failed.';
      setModelTests((current) => ({ ...current, [model]: 'error' }));
      setModelTestDetails((current) => ({ ...current, [model]: detail }));
      flash(detail, 'error');
    } finally {
      window.clearTimeout(timeout);
      if (modelTestAbortRef.current === controller) modelTestAbortRef.current = null;
      setTestingModel(null);
    }
  }

  async function copyModel(model: string) {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(modelReference(provider.id, model));
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
          <div className="flex shrink-0 items-center gap-2"><button type="button" onClick={testConnection} disabled={testingConnection || testingModel !== null} className="btn-ghost !px-3 !py-2.5 !text-xs">{testingConnection ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}{testingConnection ? 'Testing' : 'Test provider'}</button><button type="button" onClick={() => setAddOpen(true)} className="btn-gold !px-3 !py-2.5 !text-xs"><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add connection</button></div>
        </div>
      </div>

      {notice && <div role={noticeError ? 'alert' : 'status'} className={`mb-5 flex items-center gap-2 rounded-xl border px-3.5 py-3 text-xs ${noticeError ? 'border-danger/25 bg-danger/10 text-danger' : 'border-success/25 bg-success/10 text-success'}`}>{noticeError ? <CircleAlert className="h-4 w-4" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}{notice}</div>}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <DetailStat label="Connections" value={connectionAdded ? '1 active' : '0'} icon={KeyRound} tone={connectionAdded ? 'green' : 'muted'} />
        <DetailStat label="Models" value={allModels.length > 0 ? String(allModels.length) : '—'} icon={Cpu} tone="blue" />
        <DetailStat label="Latency" value={connectionHealthy ? 'Checked just now' : provider.latency} icon={Clock3} tone="gold" />
        <DetailStat label="Route health" value={connectionHealthy ? '100%' : connectionAdded ? 'Pending' : '—'} icon={Activity} tone={connectionHealthy ? 'green' : connectionAdded ? 'gold' : 'muted'} />
      </div>

      <section className="card mt-5 overflow-hidden" aria-labelledby="connections-title">
        <div className="flex flex-col justify-between gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:p-5"><div><h2 id="connections-title" className="text-sm font-semibold">Connections</h2><p className="muted mt-1 text-xs">Credentials and endpoints used by this provider.</p></div><span className="rounded-full border border-line bg-bg-soft px-2.5 py-1 font-mono text-[10px] text-muted">{connectionAdded ? '1 connection' : 'No connection'}</span></div>
        <div className="p-4 sm:p-5">
          {connectionAdded ? <ConnectionRow provider={provider} connection={connection} healthy={connectionHealthy} testing={testingConnection || testingModel !== null} onTest={testConnection} onEdit={() => setAddOpen(true)} /> : <div className="flex flex-col items-center justify-between gap-4 rounded-xl border border-dashed border-line-strong p-6 text-center sm:flex-row sm:text-left"><div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text"><Server className="h-4 w-4" aria-hidden="true" /></span><div><p className="text-sm font-semibold">No connection yet</p><p className="muted mt-1 text-xs">Add an API key or point OmniHilbras at a local endpoint.</p></div></div><button type="button" onClick={() => setAddOpen(true)} className="btn-gold !px-3 !py-2 !text-xs">Add connection <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></button></div>}
        </div>
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
        <section className="card min-w-0 p-4 sm:p-5" aria-labelledby="models-title">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start"><div><h2 id="models-title" className="text-sm font-semibold">Available models</h2><p className="muted mt-1 text-xs">Models currently exposed by this provider route. Test sends one real minimal request.</p></div><span className="rounded-full border border-line bg-bg-soft px-2.5 py-1 font-mono text-[10px] text-muted">{allModels.length} models</span></div>
          <div className="mt-5 space-y-2">{allModels.length > 0 ? allModels.map((model) => <ModelRow key={model} model={model} providerId={provider.id} onCopy={() => void copyModel(model)} onTest={() => void testModel(model)} testing={testingModel === model} disabled={testingModel !== null || testingConnection} testState={modelTests[model] ?? 'idle'} testDetail={modelTestDetails[model]} />) : <div className="rounded-xl border border-dashed border-line-strong px-5 py-9 text-center"><Cpu className="mx-auto h-6 w-6 text-muted" aria-hidden="true" /><p className="mt-3 text-sm font-semibold">No models discovered</p><p className="muted mt-1 text-xs">Connect the provider or add a custom model ID below.</p></div>}</div>
          <div className="mt-5 border-t border-line pt-5"><AddModelForm onAdd={addModel} providerId={provider.id} /></div>
          {copiedModel && <p role="status" className="mt-3 flex items-center gap-1.5 text-[11px] text-success"><Check className="h-3.5 w-3.5" aria-hidden="true" />Copied {modelReference(provider.id, copiedModel)}</p>}
        </section>

        <section className="card min-w-0 p-4 sm:p-5" aria-labelledby="policy-title">
          <div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text"><SlidersHorizontal className="h-4 w-4" aria-hidden="true" /></span><div><h2 id="policy-title" className="text-sm font-semibold">Routing policy</h2><p className="muted mt-0.5 text-xs">How this provider participates.</p></div></div>
          <label className="mt-6 block"><span className="mono-label mb-2 block">Strategy</span><select value={strategy} onChange={(event) => { setStrategy(event.target.value); flash(`Policy changed to ${event.target.value}.`); }} className="input !py-2.5 !text-xs"><option value="balanced">Balanced · quality and cost</option><option value="fast">Fastest response</option><option value="cheap">Lowest cost</option><option value="private">Prefer private routes</option></select></label>
          <div className="mt-5 space-y-3 border-t border-line pt-5"><div className="flex items-center justify-between text-xs"><span className="muted">Endpoint</span><button type="button" onClick={() => document.getElementById('endpoint')?.scrollIntoView({ behavior: 'smooth' })} className="max-w-[180px] truncate text-left font-mono text-[10px] text-gold-text hover:underline">{connection?.endpoint ?? provider.endpoint}</button></div><div className="flex items-center justify-between text-xs"><span className="muted">Priority</span><span className="font-mono text-[10px]">#{connection?.priority ?? 1}</span></div><div className="flex items-center justify-between text-xs"><span className="muted">Credentials</span><span className="flex items-center gap-1.5 font-mono text-[10px] text-success"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />local only</span></div></div>
          <div className="mt-5 rounded-lg border border-gold/20 bg-gold-soft/45 p-3 text-[11px] leading-relaxed text-muted"><Sparkles className="mr-1 inline h-3.5 w-3.5 text-gold-text" aria-hidden="true" />{provider.id === 'openrouter' ? 'OpenRouter credentials are managed by the local gateway.' : 'Policy changes are preview-only until a provider management API is connected.'}</div>
        </section>
      </div>

      <section id="endpoint" className="card mt-5 p-4 sm:p-5"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><h2 className="text-sm font-semibold">Endpoint details</h2><p className="muted mt-1 text-xs">The base URL OmniHilbras will use for this provider.</p></div><code className="max-w-full overflow-x-auto rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-[11px] text-muted sm:max-w-[420px]">{connection?.endpoint ?? provider.endpoint}</code></div></section>

      <AddProviderModal open={addOpen} initialProviderId={provider.id} initialModelPolicy={connection?.modelPolicy} onClose={() => setAddOpen(false)} onSave={handleAddConnection} onSaveMany={handleAddConnections} />
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
