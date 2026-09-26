import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Cpu,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { AddProviderModal, type NewProvider } from '../components/AddProviderModal';
import { OauthConnectDialog } from '../components/OauthConnectDialog';
import { DashboardShell } from '../components/DashboardShell';
import { ProviderMark } from '../components/ProviderMark';
import { addGatewayConnectionModels, getGatewayHealth, getGatewayRoutingState, listGatewayConnections, saveOpenRouterConnection, testGatewayModel, updateGatewayConnectionResilience, type GatewayConnection, type GatewayResilience, type GatewayRoutingState } from '../lib/gatewayClient';
import { getProviderById } from '../data/providers';
import { dashboardRoutes } from '../lib/routes';
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

function ConnectionRow({ provider, connection, healthy, pingMs, testing, onTest, onEdit }: { provider: ProviderRecord; connection?: GatewayConnection; healthy: boolean; pingMs?: number; testing: boolean; onTest: () => void; onEdit: () => void }) {
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
            {pingMs !== undefined && <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-2 py-0.5 font-mono text-[9px] text-muted"><Clock3 className="h-3 w-3" aria-hidden="true" />Ping {pingMs} ms</span>}
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

const concurrencyOptions = [1, 2, 4, 8, 16];

function omitKey(record: Record<string, string>, key: string) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function omitNumberKey(record: Record<string, number>, key: string) {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function ModelRow({ model, providerId, onCopy, onTest, testing, disabled, testState, testError, testLatencyMs }: { model: string; providerId: string; onCopy: () => void; onTest: () => void; testing: boolean; disabled: boolean; testState: ModelTestState; testError?: string; testLatencyMs?: number }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-bg-soft/45 p-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${testState === 'ok' ? 'border-success/25 bg-success/10 text-success' : testState === 'error' ? 'border-danger/25 bg-danger/10 text-danger' : 'border-line bg-surface text-muted'}`}>
          {testing ? <LoaderCircle className="h-4 w-4 animate-spin text-gold-text" aria-hidden="true" /> : testState === 'ok' ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : testState === 'error' ? <CircleAlert className="h-4 w-4" aria-hidden="true" /> : <Cpu className="h-4 w-4" aria-hidden="true" />}
        </span>
        <div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><p className="truncate text-xs font-semibold">{model}</p>{testLatencyMs !== undefined && testState === 'ok' && <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-success"><Clock3 className="h-3 w-3" aria-hidden="true" />Ping {testLatencyMs} ms</span>}{testState === 'error' && <span title={testError} className="shrink-0 font-mono text-[10px] text-danger">Test failed</span>}</div><code className="mt-1 block truncate font-mono text-[10px] text-muted">{modelReference(providerId, model)}</code></div>
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onCopy} aria-label={`Copy ${model} model ID`} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface hover:text-gold-text"><Copy className="h-3.5 w-3.5" aria-hidden="true" /></button>
        <button type="button" onClick={onTest} disabled={disabled || testing} aria-label={`Test ${model}`} aria-busy={testing} className="btn-quiet !px-2 !py-2 text-[11px]">{testing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Zap className="h-3.5 w-3.5" aria-hidden="true" />}{testing ? 'Testing' : 'Test'}</button>
      </div>
    </div>
  );
}

function isValidResilience(value: GatewayResilience) {
  const inRange = (input: number, min: number, max: number) => Number.isInteger(input) && input >= min && input <= max;
  return inRange(value.hedgeAfterMs, 0, 30_000) && inRange(value.maxRetries, 0, 5) && inRange(value.timeoutMs, 0, 600_000) && inRange(value.requestsPerMinute, 0, 100_000);
}

/** The documented defaults, used when a record arrives without a resilience block. */
const DEFAULT_RESILIENCE: GatewayResilience = { timeoutMs: 0, maxRetries: 1, requestsPerMinute: 0, hedgeAfterMs: 0 };

function ResiliencePanel({ connection, routingState, onSave }: { connection: GatewayConnection; routingState?: GatewayRoutingState; onSave: (next: GatewayResilience) => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  // A resilience block is required to render this panel. Reading it unguarded
  // meant one incomplete record threw during render and blanked the whole page,
  // so an absent block falls back to the documented defaults instead.
  const resilience = connection.resilience ?? DEFAULT_RESILIENCE;
  const [draft, setDraft] = useState<GatewayResilience>(resilience);
  const live = routingState?.connections.find((item) => item.providerId === connection.providerId);

  useEffect(() => {
    setDraft(resilience);
  }, [resilience]);

  const summary = [
    resilience.hedgeAfterMs > 0 ? `hedge ${Math.round(resilience.hedgeAfterMs / 100) / 10}s` : undefined,
    resilience.timeoutMs > 0 ? `${Math.round(resilience.timeoutMs / 1000)}s timeout` : undefined,
    `${resilience.maxRetries} ${resilience.maxRetries === 1 ? 'retry' : 'retries'}`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="mt-5 border-t border-line pt-5">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 text-left">
        <span className="text-xs font-semibold">Reliability</span>
        <span className="flex items-center gap-2">
          {live?.ejected && <span className="rounded-full border border-danger/25 bg-danger/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-danger">ejected</span>}
          <span className="muted font-mono text-[10px]">{summary}</span>
          {open ? <ChevronDown className="h-3.5 w-3.5 text-muted" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 text-muted" aria-hidden="true" />}
        </span>
      </button>

      {open && (
        <div className="mt-4 space-y-3">
          <p className="muted text-[11px] leading-relaxed">OmniHilbras retries a failed request here, then falls through to the next connection by priority. Requests without a valid key are never retried.</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block"><span className="mono-label mb-1.5 block">Hedge after (ms)</span><input type="number" min={0} max={30000} step={100} value={draft.hedgeAfterMs} onChange={(event) => setDraft((current) => ({ ...current, hedgeAfterMs: Number(event.target.value) }))} className="input !py-2 !text-xs" /></label>
            <label className="block"><span className="mono-label mb-1.5 block">Retries</span><input type="number" min={0} max={5} value={draft.maxRetries} onChange={(event) => setDraft((current) => ({ ...current, maxRetries: Number(event.target.value) }))} className="input !py-2 !text-xs" /></label>
            <label className="block"><span className="mono-label mb-1.5 block">Timeout (ms)</span><input type="number" min={0} max={600000} step={1000} value={draft.timeoutMs} onChange={(event) => setDraft((current) => ({ ...current, timeoutMs: Number(event.target.value) }))} className="input !py-2 !text-xs" /></label>
            <label className="block"><span className="mono-label mb-1.5 block">Requests / min</span><input type="number" min={0} max={100000} value={draft.requestsPerMinute} onChange={(event) => setDraft((current) => ({ ...current, requestsPerMinute: Number(event.target.value) }))} className="input !py-2 !text-xs" /></label>
          </div>
          <p className="muted text-[11px] leading-relaxed">{draft.hedgeAfterMs > 0
            ? `If this connection has not answered in ${draft.hedgeAfterMs} ms, the next eligible connection is raced against it and the first reply wins. The loser is cancelled, so its tokens are usually not billed.`
            : 'Set a hedge delay to race a second connection when this one is slow. With a single connection nothing is sent, so there is no extra cost.'}</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { void onSave(draft); }} disabled={!isValidResilience(draft)} className="btn-gold !px-3 !py-2 !text-xs disabled:opacity-60">Save reliability</button>
            <button type="button" onClick={() => setDraft(resilience)} className="btn-quiet !px-2 !py-2 !text-xs">Reset</button>
            {live && <span className="muted ml-auto font-mono text-[10px]">{live.failures ? `${live.failures} recent failures` : `${live.successes ?? 0} successes`}</span>}
          </div>
          {!isValidResilience(draft) && <p className="text-[11px] text-danger">Hedge 0–30000 ms, retries 0–5, timeout 0–600000 ms, requests per minute 0–100000.</p>}
          {live?.lastError && <p className="muted truncate font-mono text-[10px]" title={live.lastError}>last error: {live.lastError}</p>}
        </div>
      )}
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
  const [signInWindow, setSignInWindow] = useState<Window | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connection, setConnection] = useState<GatewayConnection | undefined>();
  const [connectionHealthy, setConnectionHealthy] = useState(false);
  const [connectionPingMs, setConnectionPingMs] = useState<number | undefined>();
  const [connectionAdded, setConnectionAdded] = useState(provider.status !== 'available');
  const [testingModels, setTestingModels] = useState<string[]>([]);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | undefined>();
  const [concurrency, setConcurrency] = useState(4);
  const [modelTests, setModelTests] = useState<Record<string, ModelTestState>>({});
  const [modelTestErrors, setModelTestErrors] = useState<Record<string, string>>({});
  const [modelTestLatencies, setModelTestLatencies] = useState<Record<string, number>>({});
  const modelTestAbortRef = useRef<AbortController | null>(null);
  const bulkAbortRef = useRef<AbortController | null>(null);
  const bulkRunRef = useRef(false);
  const scrollAnchorRef = useRef<number | null>(null);
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [modelQuery, setModelQuery] = useState('');
  const [strategy, setStrategy] = useState('balanced');
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const [copiedModel, setCopiedModel] = useState<string | null>(null);
  const [routingState, setRoutingState] = useState<GatewayRoutingState | undefined>();
  const meta = statusMeta(connectionAdded ? (provider.id === 'openrouter' && !connectionHealthy ? 'attention' : provider.status === 'available' ? 'connected' : provider.status) : 'available');

  useEffect(() => {
    // Any provider can have a saved connection, not just the first one that
    // shipped with a flow. Gating this on one id made every other provider
    // report "No connection" on a fresh load, however it was added.
    let active = true;
    void listGatewayConnections()
      .then((connections) => {
        if (!active) return;
        const savedConnection = connections.find((item) => item.providerId === provider.id && item.hasCredential);
        setConnection(savedConnection);
        setConnectionAdded(Boolean(savedConnection));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [provider.id]);
  useEffect(() => () => {
    modelTestAbortRef.current?.abort();
    bulkAbortRef.current?.abort();
  }, []);
  useEffect(() => {
    let active = true;
    void getGatewayRoutingState()
      .then((state) => { if (active) setRoutingState(state); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [provider.id]);
  useLayoutEffect(() => {
    // A bulk run updates state many times per second. Restoring the anchor on
    // every update would fight the user, so the browser anchors normally there.
    if (bulkRunRef.current) return;
    if (scrollAnchorRef.current !== null) window.scrollTo(0, scrollAnchorRef.current);
  }, [connectionPingMs, modelTestErrors, modelTestLatencies, modelTests, notice, testingModels]);

  const importedModels = connection?.modelIds ?? provider.modelList;
  const allModels = useMemo(() => [...new Set([...importedModels, ...customModels])], [customModels, importedModels]);

  /**
   * Filters this provider's models. A query matches the whole ID and the part
   * after the vendor prefix, so `claude-sonnet` finds `anthropic/claude-sonnet-5`.
   * A provider can carry hundreds of models, so this is the only practical way
   * to find one.
   */
  const normalizedModelQuery = modelQuery.trim().toLowerCase();
  const visibleModels = useMemo(() => {
    if (!normalizedModelQuery) return allModels;
    return allModels.filter((model) => {
      const id = model.toLowerCase();
      const leaf = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
      return id.includes(normalizedModelQuery) || leaf.includes(normalizedModelQuery);
    });
  }, [allModels, normalizedModelQuery]);
  const testing = testingModels.length > 0;
  const isOauth = provider.auth === 'OAuth';

  // Browsers only allow window.open inside the click that granted the gesture,
  // so the tab is opened blank here and the dialog navigates it once the
  // gateway hands back the sign-in URL.
  function openAddConnection() {
    if (isOauth) {
      setSignInWindow(window.open('about:blank', '_blank'));
    } else {
      setSignInWindow(null);
    }
    setAddOpen(true);
  }
  const testingSet = useMemo(() => new Set(testingModels), [testingModels]);

  function flash(message: string, tone: 'success' | 'error' = 'success') {
    scrollAnchorRef.current = window.scrollY;
    setNotice(message);
    setNoticeError(tone === 'error');
    window.setTimeout(() => setNotice(''), 3200);
  }

  async function testConnection() {
    if (testingConnection || testing) return;
    scrollAnchorRef.current = window.scrollY;
    setTestingConnection(true);
    try {
      const health = await getGatewayHealth();
      const providerHealth = health.providers.find((item) => item.providerId === provider.id);
      const healthy = providerHealth?.status === 'healthy';
      setConnectionHealthy(healthy);
      setConnectionPingMs(healthy ? providerHealth?.latencyMs : undefined);
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
    if (testing || testingConnection) return;
    scrollAnchorRef.current = window.scrollY;
    const controller = new AbortController();
    modelTestAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    setTestingModels([model]);
    try {
      const outcome = await runModelTest(model, controller.signal);
      if (!outcome.ok) flash(outcome.message, 'error');
    } finally {
      window.clearTimeout(timeout);
      if (modelTestAbortRef.current === controller) modelTestAbortRef.current = null;
      setTestingModels([]);
    }
  }

  /**
   * One bounded real request, shared by the single-model button and the bulk
   * run so both produce identical results and per-model state.
   */
  async function runModelTest(model: string, signal: AbortSignal) {
    setModelTests((current) => ({ ...current, [model]: 'testing' }));
    setModelTestErrors((current) => omitKey(current, model));
    setModelTestLatencies((current) => omitNumberKey(current, model));
    try {
      const result = await testGatewayModel(provider.id, model, signal);
      setModelTests((current) => ({ ...current, [model]: 'ok' }));
      setModelTestLatencies((current) => ({ ...current, [model]: result.latencyMs }));
      setConnectionHealthy(true);
      setConnectionPingMs(result.latencyMs);
      return { ok: true as const, latencyMs: result.latencyMs, message: '' };
    } catch (error) {
      const message = signal.aborted ? 'Model test timed out or was cancelled.' : error instanceof Error ? error.message : 'The model test failed.';
      setModelTests((current) => ({ ...current, [model]: 'error' }));
      setModelTestErrors((current) => ({ ...current, [model]: message }));
      return { ok: false as const, latencyMs: 0, message };
    }
  }

  /**
   * Sends one real request per model through a bounded worker pool, so several
   * models are in flight at once without tripping the provider rate limit.
   * Every model gets the same result a single test would produce.
   */
  async function testAllModels() {
    // Queues what the list shows, so filtering to three models tests three.
    if (testing || testingConnection || visibleModels.length === 0) return;
    scrollAnchorRef.current = window.scrollY;
    bulkRunRef.current = true;
    const controller = new AbortController();
    bulkAbortRef.current = controller;
    const queue = [...visibleModels];
    const total = queue.length;
    const latencies: number[] = [];
    const failures: string[] = [];
    let done = 0;
    setTestingModels(queue);
    setBulkProgress({ done, total });

    const worker = async () => {
      while (queue.length > 0 && !controller.signal.aborted) {
        const model = queue.shift();
        if (model === undefined) return;
        const outcome = await runModelTest(model, controller.signal);
        done += 1;
        if (outcome.ok) latencies.push(outcome.latencyMs);
        else failures.push(model);
        setBulkProgress({ done, total });
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
      if (controller.signal.aborted) {
        flash(`Stopped after ${done} of ${total} models.`, 'error');
        return;
      }
      const median = latencies.length > 0 ? [...latencies].sort((left, right) => left - right)[Math.floor(latencies.length / 2)]! : undefined;
      const latencyText = median === undefined ? '' : ` · median ${median} ms`;
      const failureText = failures.length > 0 ? ` · ${failures.length} failed` : '';
      flash(`${latencies.length} of ${total} models healthy${latencyText}${failureText}.`, failures.length > 0 ? 'error' : 'success');
    } finally {
      bulkRunRef.current = false;
      if (bulkAbortRef.current === controller) bulkAbortRef.current = null;
      setTestingModels([]);
      setBulkProgress(undefined);
    }
  }

  function stopTesting() {
    modelTestAbortRef.current?.abort();
    bulkAbortRef.current?.abort();
  }

  async function saveResilience(next: GatewayResilience) {
    if (!connection) return;
    try {
      const updated = await updateGatewayConnectionResilience(connection.id, next);
      setConnection(updated);
      setRoutingState(await getGatewayRoutingState().catch(() => routingState));
      flash('Reliability settings saved.');
    } catch (error) {
      flash(error instanceof Error ? error.message : 'The reliability settings could not be saved.', 'error');
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
        <Link to={dashboardRoutes.providers} className="btn-quiet -ml-2 mb-4 !px-2 !py-1.5 text-xs"><ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />Back to providers</Link>
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
          <div className="flex min-w-0 items-start gap-3.5 sm:gap-4">
            <ProviderMark logo={provider.logo} initial={provider.initial} color={provider.color} className="h-12 w-12 rounded-xl text-sm" />
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2.5"><h2 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">{provider.name}</h2><span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[9px] ${meta.className}`}><span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />{meta.label}</span></div><p className="muted mt-1 text-sm">{provider.description}</p></div>
          </div>
          <div className="flex shrink-0 items-center gap-2"><button type="button" onClick={testConnection} disabled={testingConnection || testing} className="btn-ghost !px-3 !py-2.5 !text-xs">{testingConnection ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}{testingConnection ? 'Testing' : 'Test provider'}</button><button type="button" onClick={openAddConnection} className="btn-gold !px-3 !py-2.5 !text-xs"><Plus className="h-3.5 w-3.5" aria-hidden="true" />Add connection</button></div>
        </div>
      </div>

      {notice && <div role={noticeError ? 'alert' : 'status'} className={`mb-5 flex items-center gap-2 rounded-xl border px-3.5 py-3 text-xs ${noticeError ? 'border-danger/25 bg-danger/10 text-danger' : 'border-success/25 bg-success/10 text-success'}`}>{noticeError ? <CircleAlert className="h-4 w-4" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}{notice}</div>}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <DetailStat label="Connections" value={connectionAdded ? '1 active' : '0'} icon={KeyRound} tone={connectionAdded ? 'green' : 'muted'} />
        <DetailStat label="Models" value={allModels.length > 0 ? String(allModels.length) : '—'} icon={Cpu} tone="blue" />
        <DetailStat label="Latency" value={connectionPingMs === undefined ? (connectionHealthy ? 'Checked just now' : provider.latency) : `${connectionPingMs} ms`} icon={Clock3} tone="gold" />
        <DetailStat label="Route health" value={connectionHealthy ? '100%' : connectionAdded ? 'Pending' : '—'} icon={Activity} tone={connectionHealthy ? 'green' : connectionAdded ? 'gold' : 'muted'} />
      </div>

      <section className="card mt-5 overflow-hidden" aria-labelledby="connections-title">
        <div className="flex flex-col justify-between gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:p-5"><div><h2 id="connections-title" className="text-sm font-semibold">Connections</h2><p className="muted mt-1 text-xs">Credentials and endpoints used by this provider.</p></div><span className="rounded-full border border-line bg-bg-soft px-2.5 py-1 font-mono text-[10px] text-muted">{connectionAdded ? '1 connection' : 'No connection'}</span></div>
        <div className="p-4 sm:p-5">
          {connectionAdded ? <ConnectionRow provider={provider} connection={connection} healthy={connectionHealthy} pingMs={connectionPingMs} testing={testingConnection || testing} onTest={testConnection} onEdit={openAddConnection} /> : <div className="flex flex-col items-center justify-between gap-4 rounded-xl border border-dashed border-line-strong p-6 text-center sm:flex-row sm:text-left"><div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text"><Server className="h-4 w-4" aria-hidden="true" /></span><div><p className="text-sm font-semibold">No connection yet</p><p className="muted mt-1 text-xs">Add an API key or point OmniHilbras at a local endpoint.</p></div></div><button type="button" onClick={openAddConnection} className="btn-gold !px-3 !py-2 !text-xs">Add connection <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></button></div>}
        </div>
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
        <section className="card min-w-0 p-4 sm:p-5" aria-labelledby="models-title">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div>
              <h2 id="models-title" className="text-sm font-semibold">Available models</h2>
              <p className="muted mt-1 text-xs">
                Models currently exposed by this provider route. Test sends one real minimal request.
                {normalizedModelQuery && <> Showing {visibleModels.length} of {allModels.length}.</>}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {bulkProgress && (
                <span className="flex items-center gap-1.5 rounded-full border border-gold/25 bg-gold-soft px-2.5 py-1 font-mono text-[10px] text-gold-text" role="status">
                  <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                  {bulkProgress.done}/{bulkProgress.total}
                </span>
              )}
              <label className="flex items-center gap-1.5">
                <span className="sr-only">Concurrent model tests</span>
                <select
                  value={concurrency}
                  onChange={(event) => setConcurrency(Number(event.target.value))}
                  disabled={testing}
                  className="input !h-8 !w-[4.5rem] !py-1 !text-[11px]"
                >
                  {concurrencyOptions.map((option) => <option key={option} value={option}>{option} at a time</option>)}
                </select>
              </label>
              {testing ? (
                <button type="button" onClick={stopTesting} className="btn-ghost !px-3 !py-2 !text-xs">
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  Stop
                </button>
              ) : (
                <button type="button" onClick={() => void testAllModels()} disabled={testingConnection || visibleModels.length === 0} className="btn-gold !px-3 !py-2 !text-xs">
                  <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                  {normalizedModelQuery ? `Test ${visibleModels.length} shown` : 'Test all'}
                </button>
              )}
            </div>
          </div>
          <div className="mt-4">
            <label className="relative block">
              <span className="sr-only">Search {provider.name} models</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
              <input
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder={`Search ${provider.name} models`}
                aria-label={`Search ${provider.name} models`}
                className="input !h-9 !w-full !py-2 !pl-9 !pr-8 !text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              {normalizedModelQuery && (
                <button type="button" onClick={() => setModelQuery('')} aria-label="Clear model search" title="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted transition-colors hover:text-text">
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </label>
          </div>
          <div className="mt-3 space-y-2">{visibleModels.length > 0 ? visibleModels.map((model) => <ModelRow key={model} model={model} providerId={provider.id} onCopy={() => void copyModel(model)} onTest={() => void testModel(model)} testing={testingSet.has(model)} disabled={testing || testingConnection} testState={modelTests[model] ?? 'idle'} testError={modelTestErrors[model]} testLatencyMs={modelTestLatencies[model]} />) : <div className="rounded-xl border border-dashed border-line-strong px-5 py-9 text-center"><Cpu className="mx-auto h-6 w-6 text-muted" aria-hidden="true" /><p className="mt-3 text-sm font-semibold">{normalizedModelQuery ? 'No matching models' : 'No models discovered'}</p><p className="muted mt-1 text-xs">{normalizedModelQuery ? <>Nothing in {allModels.length} models matches &ldquo;{modelQuery.trim()}&rdquo;.</> : 'Connect the provider or add a custom model ID below.'}</p></div>}</div>
          <div className="mt-5 border-t border-line pt-5"><AddModelForm onAdd={addModel} providerId={provider.id} /></div>
          {copiedModel && <p role="status" className="mt-3 flex items-center gap-1.5 text-[11px] text-success"><Check className="h-3.5 w-3.5" aria-hidden="true" />Copied {modelReference(provider.id, copiedModel)}</p>}
        </section>

        <section className="card min-w-0 p-4 sm:p-5" aria-labelledby="policy-title">
          <div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text"><SlidersHorizontal className="h-4 w-4" aria-hidden="true" /></span><div><h2 id="policy-title" className="text-sm font-semibold">Routing policy</h2><p className="muted mt-0.5 text-xs">How this provider participates.</p></div></div>
          <label className="mt-6 block"><span className="mono-label mb-2 block">Strategy</span><select value={strategy} onChange={(event) => { setStrategy(event.target.value); flash(`Policy changed to ${event.target.value}.`); }} className="input !py-2.5 !text-xs"><option value="balanced">Balanced · quality and cost</option><option value="fast">Fastest response</option><option value="cheap">Lowest cost</option><option value="private">Prefer private routes</option></select></label>
          <div className="mt-5 space-y-3 border-t border-line pt-5"><div className="flex items-center justify-between text-xs"><span className="muted">Endpoint</span><button type="button" onClick={() => document.getElementById('endpoint')?.scrollIntoView({ behavior: 'smooth' })} className="max-w-[180px] truncate text-left font-mono text-[10px] text-gold-text hover:underline">{connection?.endpoint ?? provider.endpoint}</button></div><div className="flex items-center justify-between text-xs"><span className="muted">Priority</span><span className="font-mono text-[10px]">#{connection?.priority ?? 1}</span></div><div className="flex items-center justify-between text-xs"><span className="muted">Credentials</span><span className="flex items-center gap-1.5 font-mono text-[10px] text-success"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />local only</span></div></div>
          {connection && <ResiliencePanel connection={connection} routingState={routingState} onSave={saveResilience} />}
          <div className="mt-5 rounded-lg border border-gold/20 bg-gold-soft/45 p-3 text-[11px] leading-relaxed text-muted"><Sparkles className="mr-1 inline h-3.5 w-3.5 text-gold-text" aria-hidden="true" />{provider.id === 'openrouter' ? 'OpenRouter credentials are managed by the local gateway.' : 'Policy changes are preview-only until a provider management API is connected.'}</div>
        </section>
      </div>

      <section id="endpoint" className="card mt-5 p-4 sm:p-5"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><h2 className="text-sm font-semibold">Endpoint details</h2><p className="muted mt-1 text-xs">The base URL OmniHilbras will use for this provider.</p></div><code className="max-w-full overflow-x-auto rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-[11px] text-muted sm:max-w-[420px]">{connection?.endpoint ?? provider.endpoint}</code></div></section>

      <AddProviderModal open={addOpen && !isOauth} initialProviderId={provider.id} initialModelPolicy={connection?.modelPolicy} onClose={() => setAddOpen(false)} onSave={handleAddConnection} onSaveMany={handleAddConnections} />
      {isOauth && addOpen && (
        <OauthConnectDialog
          providerId={provider.id}
          providerName={provider.name}
          signInWindow={signInWindow}
          onClose={() => { setAddOpen(false); setSignInWindow(null); }}
          onConnected={async (saved) => {
            // The gateway is the source of truth for a connection record, so the
            // authoritative one is read back rather than trusting whatever shape
            // the sign-in happened to hand over. A partial record here used to
            // reach the resilience panel and blank the page.
            const authoritative = await listGatewayConnections()
              .then((connections) => connections.find((item) => item.providerId === provider.id && item.hasCredential))
              .catch(() => undefined);
            const next = authoritative ?? saved;
            setConnection(next);
            setConnectionAdded(true);
            setConnectionHealthy(false);
            flash(`Signed in to ${next.name} with ${next.modelIds.length} models.`);
            void getGatewayRoutingState().then(setRoutingState).catch(() => undefined);
          }}
        />
      )}
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
