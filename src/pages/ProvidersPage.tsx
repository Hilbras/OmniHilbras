import { useCallback, useEffect, useMemo, useState } from 'react';
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
  X,
} from 'lucide-react';
import { AddProviderModal, isWebSessionProvider, providerOptions, type NewProvider } from '../components/AddProviderModal';
import { DashboardShell } from '../components/DashboardShell';
import { ProviderCard, providerGroupLabels, providerGroupOrder, type ProviderCardMode, type ProviderGroup, type ProviderRecord, type ProviderStatus } from '../components/ProviderCard';
import {
  getGatewayHealth,
  listGatewayConnections,
  putGatewayConnection,
  saveOpenRouterConnection,
  type GatewayConnection,
  type GatewayHealth
} from '../lib/gatewayClient';
import { ProviderMark } from '../components/ProviderMark';
import { providerRoute } from '../lib/routes';
import { useGatewayReload } from '../lib/useGatewayStatus';
import { webSessionProviderIds } from '../lib/webSessionProviders';
import { providerSlug } from '@hilbras/omnihilbras';
import { providerCatalog } from '../data/providers';
import { mergeGatewayConnections } from '../lib/providerCards';

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

/**
 * A card for a provider that has NOT been saved to the gateway.
 *
 * Every field here is a placeholder, because there is nothing to measure yet:
 *   - `status: 'available'`, not `'connected'` — the gateway has no record of this provider,
 *   - `health: 0` — no probe has run,
 *   - `lastUsed: 'never'` — no request has been sent through it,
 *   - `models: '—'` — the model list comes from the provider, not from us.
 *
 * The previous version of this function claimed `connected`, `100`, and `'just now'` for a credential
 * that had never left the browser. `tests/provider-card-merge.test.js` could not catch it: that suite
 * asserts the merge with a *connection*, and this path never had one.
 */
function recordForUnsavedProvider(newProvider: NewProvider, index = 0): ProviderRecord {
  const option = providerOptions.find((item) => item.id === newProvider.providerId) ?? providerOptions[0];
  return {
    id: `${option.id}-${Date.now()}-${index}`,
    catalogId: option.id,
    name: newProvider.name,
    description: option.description,
    category: option.id === 'custom' ? 'Custom endpoint' : option.auth === 'No key' ? 'Local runtime' : 'New connection',
    group: groupForNewProvider(option.id, option.auth),
    status: 'available',
    auth: option.auth,
    models: '—',
    latency: '—',
    requests: '0',
    lastUsed: 'never',
    health: 0,
    color: option.color,
    initial: option.initial,
    logo: option.logo,
    endpoint: newProvider.endpoint,
    modelList: [],
  };
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

/** How many matching model IDs to list per provider before summarising. */
const modelResultLimit = 12;

/** `serving` only when health agrees; a saved connection is never "not connected". */
function connectionBadge(provider: ProviderRecord, saved: boolean) {
  if (provider.status === 'connected') return { label: 'serving', tone: 'border-success/30 bg-success/10 text-success' };
  if (saved) return { label: 'saved · needs attention', tone: 'border-gold/30 bg-gold-soft text-gold-text' };
  return { label: 'not connected', tone: 'border-line bg-bg-soft text-muted' };
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
  /**
   * The last health report, kept so the summary can count from it.
   *
   * `getGatewayHealth()` was already called here on every load and on Test all. Its result went into
   * `mergeGatewayConnections` and was then discarded — so the summary card beside the provider list had
   * no report to read and used the literal `92%`. Held now, and `undefined` until one has been read,
   * which the card renders as `—` rather than a number nobody measured.
   */
  const [healthReport, setHealthReport] = useState<GatewayHealth | undefined>();
  const [notice, setNotice] = useState('');

  /**
   * Connections first, health second.
   *
   * These were awaited together, in the wrong order: `/health` probes every provider and
   * takes around 24 seconds, so the list sat empty for 24 seconds on every load even though
   * `/v1/connections` answers in five milliseconds. The connections are what the page is
   * actually about, so they are set first and the health pass refines them when it lands.
   */
  const load = useCallback(() => {
    let active = true;
    void listGatewayConnections()
      .then((connections) => {
        if (!active) return;
        setGatewayConnections(connections);
        // Rendered against no health data, which merges to connected-or-attention from the
        // credential and enabled flags alone — a truthful intermediate, not a blank page.
        setProviders((current) => mergeGatewayConnections(current, connections));
        return getGatewayHealth()
          .then((health) => {
            if (!active) return;
            // Retained as well as merged, so the summary card counts from the same report the cards
            // were built from. Dropping it here is what left that card showing `—` on every load and
            // only filling in after someone pressed **Test all**.
            setHealthReport(health);
            setProviders((current) => mergeGatewayConnections(current, connections, health));
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  /**
   * Reload when the gateway comes back.
   *
   * A page whose load already failed makes no further requests, so without this the offline
   * message is the last thing the tab ever says — and the only way out is a manual reload,
   * which is the wrong instinct when the fix is "nothing, it already recovered".
   */
  useGatewayReload(load);

  /**
   * Whether a connection is actually saved, kept apart from the merged display
   * status. A saved connection whose health check is failing is still saved, and
   * reporting that as "not connected" hides the credential the operator has.
   */
  const savedProviderIds = useMemo(
    () => new Set(gatewayConnections.filter((connection) => connection.hasCredential).map((connection) => connection.providerId)),
    [gatewayConnections],
  );

  const connectedCount = providers.filter((provider) => provider.status === 'connected').length;
  const attentionCount = providers.filter((provider) => provider.status === 'attention').length;
  const availableCount = providers.filter((provider) => provider.status === 'available').length;
  /** Connections whose credential the gateway accepted on the last poll. */
  const credentialCheckedCount = healthReport?.providers.filter((provider) => provider.status === 'healthy').length ?? 0;
  const normalizedQuery = query.trim().toLowerCase();

  /**
   * Models are matched on the whole ID and on the part after the vendor prefix,
   * so both `anthropic/claude-sonnet-4.6` and `claude-sonnet` find it. A model
   * only counts for a provider that is actually serving it, which is why this
   * reads the merged catalog rather than a hard-coded list.
   */
  const modelMatches = useMemo(() => {
    if (!normalizedQuery) return new Map<string, { provider: ProviderRecord; models: string[] }>();
    const byProvider = new Map<string, { provider: ProviderRecord; models: string[] }>();
    for (const provider of providers) {
      const models = (provider.modelList ?? []).filter((model) => {
        const id = model.toLowerCase();
        const leaf = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
        return id.includes(normalizedQuery) || leaf.includes(normalizedQuery);
      });
      if (models.length > 0) byProvider.set(provider.id, { provider, models });
    }
    return byProvider;
  }, [normalizedQuery, providers]);

  const totalModelMatches = useMemo(
    () => [...modelMatches.values()].reduce((sum, entry) => sum + entry.models.length, 0),
    [modelMatches],
  );

  const filteredProviders = useMemo(() => {
    return providers.filter((provider) => {
      const matchesQuery = !normalizedQuery
        || `${provider.name} ${provider.description} ${provider.category}`.toLowerCase().includes(normalizedQuery)
        // A model hit keeps the provider visible, so the result is actionable.
        || modelMatches.has(provider.id);
      return matchesQuery && matchesStatus(provider.status, filter);
    });
  }, [filter, modelMatches, normalizedQuery, providers]);
  const groupedProviders = useMemo(() => providerGroupOrder
    .map((group) => ({ group, providers: filteredProviders.filter((provider) => provider.group === group) }))
    .filter((group) => group.providers.length > 0), [filteredProviders]);

  function openAdd(providerId?: string) {
    // This modal collects an API key. A web-session provider is signed into instead, so
    // sending one here asked for a credential it does not use — and the connection that came
    // back could not work. Guarded at the function rather than at the one caller, because
    // every path into this modal goes through it.
    if (providerId && isWebSessionProvider(providerId)) {
      navigate(providerRoute(providerId));
      return;
    }
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

  /**
   * Add cards to the local list only, and say they are not connected.
   *
   * This used to be the *whole* save path for every provider except OpenRouter, which is why
   * `recordForNewProvider` claimed `status: 'connected'`, `health: 100` and `lastUsed: 'just now'` for a
   * credential that had never been sent anywhere. That is the 1.34.5 Ollama defect and the 1.36.1
   * `lastUsed` defect, reproduced in a third place, and it survived because both earlier fixes were made
   * in `mergeGatewayConnections` — the function that folds a *reported* connection in. Nothing looked at
   * the path that never had one.
   *
   * It is still used, for the two cases where a card genuinely has no gateway connection yet: a bulk
   * entry the user has not saved, and a provider whose save failed. So the fields must be honest rather
   * than removed: an unsaved card is `available`, not connected, and has never been used.
   */
  function finishAddLocally(added: NewProvider[]) {
    setProviders((current) => [...added.map((provider, index) => recordForUnsavedProvider(provider, index)), ...current]);
    setAddOpen(false);
    setInitialProviderId(undefined);
    setInitialModelPolicy(undefined);
    setNotice(`${added.length} ${added.length === 1 ? 'connection was' : 'connections were'} added to the local list. Not saved to the gateway yet.`);
    window.setTimeout(() => setNotice(''), 4000);
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

    // Every other provider takes the generic route. It used to skip this entirely and call `finishAdd`,
    // which put a card on screen claiming `connected` / `100%` / `just now` and threw the pasted key away.
    // `putGatewayConnection` was already implemented in `gatewayClient.ts` and had no caller: a working
    // save path, unreachable. The card is now built from the connection the gateway *reports back*, which
    // is the only thing that can honestly say whether the credential works.
    // `apiKey` and `endpoint` are both required by `GatewayConnectionInput`. A keyless provider (Ollama,
    // LM Studio) has no key to send, so it sends the placeholder the modal uses for "no key" and the
    // gateway stores nothing secret for it. Building the object conditionally instead would not typecheck
    // against a type that says both are required — which is the type telling us the save needs a decision
    // here, not silently taking an undefined.
    if (!newProvider.endpoint) throw new Error('Enter the provider endpoint before saving.');
    const connection = await putGatewayConnection(newProvider.providerId, {
      name: newProvider.name,
      endpoint: newProvider.endpoint,
      apiKey: apiKey ?? '',
      ...(newProvider.priority ? { priority: newProvider.priority } : {}),
      ...(newProvider.modelPolicy ? { modelPolicy: newProvider.modelPolicy } : {}),
    });
    setGatewayConnections((current) => [...current.filter((item) => item.providerId !== connection.providerId), connection]);
    setProviders((current) => {
      // Drop any unsaved card for this provider first: the gateway now reports the real state, and
      // leaving the placeholder beside it would show the same provider twice with different numbers.
      const withoutPlaceholder = current.filter((card) => card.id !== `${newProvider.providerId}-unsaved`);
      const base = providerCatalog.find((item) => item.id === newProvider.providerId);
      if (!base) return current;
      return mergeGatewayConnections([...withoutPlaceholder, { ...base, name: newProvider.name }], [connection]);
    });
    setAddOpen(false);
    setInitialProviderId(undefined);
    setInitialModelPolicy(undefined);
    setNotice(`${newProvider.name} connection saved. ${connection.modelIds.length} models available.`);
    window.setTimeout(() => setNotice(''), 4000);
  }

  async function handleSaveMany(newProviders: NewProvider[]) {
    // Saved one at a time, and reported honestly. The bulk path used to add every card to the local list
    // at once, so one rejected credential still produced a green card for it.
    const saved: string[] = [];
    const failed: string[] = [];
    for (const provider of newProviders) {
      try {
        await handleSave(provider);
        saved.push(provider.name);
      } catch (error) {
        failed.push(`${provider.name}: ${error instanceof Error ? error.message : 'the gateway refused it'}`);
      }
    }
    if (failed.length > 0) {
      finishAddLocally(newProviders.filter((provider) => failed.some((message) => message.startsWith(provider.name))));
      setNotice(`${saved.length} saved. ${failed.length} not saved — ${failed.join('; ')}`);
    } else if (saved.length > 0) {
      setNotice(`${saved.length} ${saved.length === 1 ? 'connection was' : 'connections were'} saved.`);
    }
    window.setTimeout(() => setNotice(''), 5000);
  }

  async function testAll() {
    setTestingAll(true);
    try {
      const health = await getGatewayHealth();
      setProviders((current) => mergeGatewayConnections(current, gatewayConnections, health));
      // Kept for the summary card. The report used to be read, folded into the cards, and dropped —
      // which is why the card beside it had to invent a number: `92%`, "last 24 hours", neither
      // measured. The data was in this function the whole time.
      setHealthReport(health);
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
    /**
     * A web-session provider is connected on its own page, not from here.
     *
     * `AddProviderModal` collects an API key, and a web-session provider has none — opening
     * it for one asked for a credential the provider does not use, which is how clicking
     * "Connect" on DeepSeek produced a dialog for a different provider entirely. The dialog
     * that knows how to sign in lives on the detail page, so that is where the click goes.
     */
    const onConnect = webSessionProviderIds().includes(provider.catalogId ?? provider.id)
      ? () => navigate(detailTo)
      : () => openAdd(provider.catalogId ?? provider.id);
    return <ProviderCard key={provider.id} provider={provider} detailTo={detailTo} mode={cardMode} simpleEnabled={simpleEnabled} onToggle={(enabled) => toggleProvider(provider.id, enabled)} onManage={() => navigate(detailTo)} onConnect={onConnect} />;
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
            {/*
              This card read `92%` with the detail "last 24 hours", and **both numbers were
              literals** — verified in the running dashboard, where it rendered as
              `ROUTE HEALTH | 92% | last 24 hours` beside three cards that are all counted from
              `providers`. The gateway keeps no request log, no success counter and no timing
              history, so there is no percentage to compute and no 24 hours to compute it over. The
              figure is a leftover from the fabricated Overview page deleted in 1.38.0, which carried
              the same `92 ms` / `1,417` Ollama numbers as the provider cards: the *value* outlived
              the component it belonged to.

              It is replaced with the one health fact this page has actually measured — how many of
              the connections the gateway polled are reporting healthy — and labelled "Credential
              check" rather than "Route health", because that is the question `GET /health` answered
              (see 1.40.0: no adapter completes a request during a poll).
            */}
            <SummaryCard
              label="Credential check"
              value={healthReport ? `${credentialCheckedCount} of ${healthReport.providers.length}` : '—'}
              detail="credential accepted"
              icon={Activity}
              tone="border-[#83b7ff]/25 bg-[#83b7ff]/10 text-[#5d98e8]"
            />
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
                  <span className="sr-only">Search providers and models</span>
                  <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search providers or models"
                    aria-describedby={normalizedQuery ? 'model-search-results' : undefined}
                    className="input !h-9 !w-full !py-2 !pl-9 !pr-8 !text-xs sm:!w-64"
                  />
                  {normalizedQuery && (
                    <button type="button" onClick={() => setQuery('')} aria-label="Clear search" title="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted transition-colors hover:text-text">
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
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

            {normalizedQuery && (
              <div id="model-search-results" role="region" aria-label="Model search results" className="border-b border-line px-4 py-4 sm:px-5">
                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold">
                    {totalModelMatches > 0
                      ? `${totalModelMatches} ${totalModelMatches === 1 ? 'model' : 'models'} across ${modelMatches.size} ${modelMatches.size === 1 ? 'provider' : 'providers'}`
                      : 'No matching models'}
                  </h3>
                  <span className="muted font-mono text-[10px]">searches imported models</span>
                </div>
                {totalModelMatches > 0 ? (
                  <ul className="space-y-2.5">
                    {[...modelMatches.values()].map(({ provider, models }) => (
                      <li key={provider.id} className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <ProviderMark logo={provider.logo} initial={provider.initial} color={provider.color} className="h-5 w-5 rounded-md" />
                          <span className="text-[11px] font-semibold">{provider.name}</span>
                          <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${connectionBadge(provider, savedProviderIds.has(provider.id)).tone}`}>
                            {connectionBadge(provider, savedProviderIds.has(provider.id)).label}
                          </span>
                          <button
                            type="button"
                            onClick={() => navigate(providerRoute(provider.id))}
                            className="ml-auto text-[10px] font-medium text-gold-text transition-opacity hover:opacity-70"
                          >
                            Open
                          </button>
                        </div>
                        <ul className="flex flex-wrap gap-1.5 pl-0">
                          {models.slice(0, modelResultLimit).map((model) => (
                            <li key={model}>
                              <button
                                type="button"
                                onClick={() => navigate(providerRoute(provider.id))}
                                title={`${providerSlug(provider.id)}/${model} — open ${provider.name}`}
                                className="max-w-[15rem] truncate rounded-md border border-line bg-bg-soft px-1.5 py-0.5 font-mono text-[10px] text-muted transition-colors hover:border-gold/40 hover:text-text"
                              >
                                {providerSlug(provider.id)}/{model}
                              </button>
                            </li>
                          ))}
                          {models.length > modelResultLimit && (
                            <li className="muted self-center px-1 font-mono text-[10px]">+{models.length - modelResultLimit} more</li>
                          )}
                        </ul>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted text-[11px]">No imported model matches “{query.trim()}”. Only models from a saved connection are searchable.</p>
                )}
              </div>
            )}

            {filteredProviders.length > 0 ? (
              <div className="space-y-6 p-4 sm:p-5">
                {groupedProviders.map(({ group, providers: grouped }) => (
                  <section key={group} aria-labelledby={`provider-group-${group}`}>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 id={`provider-group-${group}`} className="text-sm font-semibold">{providerGroupLabels[group]}</h3>
                      <span className="muted font-mono text-[10px]">{grouped.length} {grouped.length === 1 ? 'provider' : 'providers'}</span>
                    </div>
                    {/*
                      Columns follow the container, not the viewport — `auto-fit` with a minimum
                      card width, rather than `sm:`/`md:`/`xl:` steps.

                      The breakpoints could not express this, and that is the point. The sidebar
                      is 252px from `lg` up and off-canvas below it, so the same viewport width
                      yields a content area 252px narrower on one side of that breakpoint than the
                      other. Every fixed column count is therefore wrong somewhere: `md:grid-cols-3`
                      put three cards in 225px at an 800px viewport, which truncated *every*
                      provider name ("OpenCode Console" needs 129px and had 75). Collapsing the
                      sidebar changes it again, and so does any future chrome.

                      With a minimum, a card is never rendered narrower than it can show its name
                      and status, and it takes an extra column as soon as there is room for one.
                    */}
                    <div className={`grid gap-3 ${cardMode === 'simple' ? 'grid-cols-[repeat(auto-fit,minmax(272px,1fr))]' : 'grid-cols-[repeat(auto-fit,minmax(320px,1fr))]'}`}>
                      {grouped.map((provider) => renderProviderCard(provider))}
                    </div>
                  </section>
                ))}
              </div>
            ) : <div className="px-5 py-14 text-center"><Search className="mx-auto h-7 w-7 text-muted" aria-hidden="true" /><p className="mt-3 text-sm font-semibold">No providers found</p><p className="muted mt-1 text-xs">{normalizedQuery ? `Nothing matches “${query.trim()}”.` : 'Try a different status filter.'}</p></div>}
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
