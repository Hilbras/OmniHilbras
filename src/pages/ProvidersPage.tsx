import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { ProviderCard, providerGroupBadges, providerGroupLabels, providerGroupOrder, type ProviderCardMode, type ProviderGroup, type ProviderRecord, type ProviderStatus } from '../components/ProviderCard';
import {
  getGatewayHealth,
  listGatewayConnections,
  putGatewayConnection,
  saveOpenRouterConnection,
  setGatewayConnectionEnabled,
  type GatewayConnection,
  type GatewayHealth
} from '../lib/gatewayClient';
import { ProviderMark } from '../components/ProviderMark';
import { useToast } from '../components/Toast';
import { providerRoute } from '../lib/routes';
import { useGatewayReload } from '../lib/useGatewayStatus';
import { webSessionProviderIds } from '../lib/webSessionProviders';
import { customOption } from '../lib/providerOptions';
import { providerSlug } from '@omnihilbras/kernel-api/public';
import { providerCatalog } from '../data/providers';
import { mergeGatewayConnections } from '../lib/providerCards';
import { badgeTone } from '../ui/primitives';

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
  // The card's own group decides where a newly saved connection appears. This used to be a chain of
  // per-provider exceptions — `mistral` was the one that said `free-tier` — so a provider the catalog
  // regrouped kept landing in the old section until someone remembered to edit this function too.
  const catalogGroup = providerCatalog.find((item) => item.id === providerId)?.group;
  if (catalogGroup) return catalogGroup;
  if (auth === 'No key') return 'local';
  if (auth === 'OAuth') return 'oauth';
  return 'api-key';
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
  const option = providerOptions.find((item) => item.id === newProvider.providerId) ?? customOption();
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
  if (saved) return { label: 'saved · needs attention', tone: badgeTone.warn };
  return { label: 'not connected', tone: 'border-line bg-bg-soft text-muted' };
}

export function ProvidersContent() {
  const navigate = useNavigate();
  const { notify } = useToast();
  const [providers, setProviders] = useState(providerCatalog);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [cardMode, setCardMode] = useState<ProviderCardMode>('simple');
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
  /** False when the gateway answered `/health` without a per-provider list; the summary says so rather than `0 of 0`. */
  const [healthReportComplete, setHealthReportComplete] = useState(true);
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  /**
   * One timer for every notice on this page.
   *
   * Seven bare `setTimeout(() => setNotice(''))` calls used to race: the aggregate "N saved" notice from a bulk
   * save was cleared by the child's four-second timer before its own five-second timer had elapsed, and a notice
   * could set state after unmount. `ApiKeysPage` already has this pattern; this page now shares it.
   */
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showNotice = useCallback((message: string, error = false, ms = 3500) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    setNoticeError(error);
    noticeTimer.current = setTimeout(() => {
      setNotice('');
      noticeTimer.current = undefined;
    }, ms);
  }, []);
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

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
            /**
             * A health payload without `providers` is *incomplete*, not fatal.
             *
             * The sweep found the whole dashboard unmounting when `/health` answered without that field: every count
             * below reads `healthReport.providers`, and the first `.filter` threw — taking the page, the shell and the
             * navigation with it, because there is one error boundary and it is above all of them. A report whose
             * card list cannot be read is a report about nothing, so it is normalised here and the summary cards say
             * so instead of claiming a measurement.
             */
            const complete = Array.isArray(health.providers);
            const normalized = complete ? health : { ...health, providers: [] };
            setHealthReport(normalized);
            setHealthReportComplete(complete);
            setProviders((current) => mergeGatewayConnections(current, connections, normalized));
          })
          .catch(() => {
            if (!active) return;
            // The connections came back; only the health pass failed. The cards still show the
            // connected-or-attention intermediate, and the operator is told the second half is
            // missing rather than left to read placeholders as measurements.
            notify('Provider health could not be read from the local gateway.', 'error');
          });
      })
      .catch(() => {
        if (!active) return;
        // Every card below renders catalog state when the gateway is unreachable — correct, but
        // silent. The notification is what says the placeholders are placeholders.
        notify('The local gateway did not answer. Cards show catalog state until it does.', 'error');
      });
    return () => {
      active = false;
    };
  }, [notify]);

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

  /**
   * The two web-session sections are hidden by request; the **group system stays**.
   *
   * This is deliberately a filter over the shared group order, not a rewrite of it: OAuth,
   * Free Tier, API Key and the rest render exactly as before, and the hidden groups' cards are
   * omitted with their headings. Removing the headings alone would have left those cards nowhere
   * to render; deleting the group metadata would have removed a system the user asked to keep.
   */
  const visibleGroups = useMemo(
    () => providerGroupOrder.filter((group) => group !== 'web-cookie' && group !== 'v2-web'),
    [],
  );
  const groupedProviders = useMemo(() => visibleGroups
    .map((group) => ({ group, providers: filteredProviders.filter((provider) => provider.group === group) }))
    .filter((group) => group.providers.length > 0), [filteredProviders, visibleGroups]);

  function openAdd(providerId?: string) {
    // This modal collects an API key. A web-session provider is signed into instead, and an OAuth-only
    // card is *signed into* rather than keyed — the dialog's own provider list says so. Sending either
    // here asked for a credential the provider does not use. Guarded at the function rather than at the
    // one caller, because every path into this modal goes through it.
    if (providerId) {
      const card = providerCatalog.find((item) => item.id === providerId);
      if (isWebSessionProvider(providerId) || card?.auth === 'OAuth' || card?.authModes?.includes('oauth')) {
        navigate(providerRoute(providerId));
        return;
      }
    }
    setInitialProviderId(providerId);
    setInitialModelPolicy(providerId ? gatewayConnections.find((connection) => connection.providerId === providerId)?.modelPolicy : undefined);
    setAddOpen(true);
  }

  async function toggleProvider(provider: ProviderRecord, enabled: boolean) {
    const owner = provider.connectionProviderId ?? provider.catalogId ?? provider.id;
    const connection = gatewayConnections.find((item) => item.providerId === owner);
    if (!connection) {
      showNotice(`${provider.name} has no saved connection to turn ${enabled ? 'on' : 'off'}.`, true, 3000);
      return;
    }
    try {
      const saved = await setGatewayConnectionEnabled(connection.id, enabled);
      setGatewayConnections((current) => current.map((item) => (item.id === saved.id ? saved : item)));
      setProviders((current) => mergeGatewayConnections(current, [saved]));
      showNotice(`${provider.name} ${enabled ? 'enabled' : 'disabled'}.`, false, 2500);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'The gateway did not answer.', true, 2500);
    }
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
    showNotice(`${added.length} ${added.length === 1 ? 'connection was' : 'connections were'} added to the local list. Not saved to the gateway yet.`, false, 4000);
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
      // Reload rather than splicing one record in: the page's list, the accounts panel and the
      // provider cards all read the same gateway state, and a local append left the connections card
      // empty after a successful save.
      await load();
      setAddOpen(false);
      setInitialProviderId(undefined);
      setInitialModelPolicy(undefined);
      showNotice(`OpenRouter connection saved with ${connection.modelIds.length} models (${connection.modelPolicy === 'free' ? 'free import' : 'all import'}).`);
      return;
    }

    // Every other provider takes the generic route. It used to skip this entirely and call `finishAdd`,
    // which put a card on screen claiming `connected` / `100%` / `just now` and threw the pasted key away.
    // `putGatewayConnection` was already implemented in `gatewayClient.ts` and had no caller: a working
    // save path, unreachable. The card is now built from the connection the gateway *reports back*, which
    // is the only thing that can honestly say whether the credential works.
    // **`credential: 'none'` is the decision this line used to answer with `''`**, which the gateway
    // refuses — so a keyless provider could not be saved from this page either, and the comment that stood
    // here asserted the opposite ("the gateway stores nothing secret for it"). Measured, before the fix:
    // `parseApiKey({ apiKey: '' })` → `apiKey must be a non-empty safe string.` The union in
    // `GatewayConnectionInput` now makes the choice explicit instead of leaving it to be guessed from a
    // comment about what the gateway does with an empty string.
    if (!newProvider.endpoint) throw new Error('Enter the provider endpoint before saving.');
    const card = providerCatalog.find((item) => item.id === newProvider.providerId);
    const keyless = card?.auth === 'No key';
    if (!keyless && !apiKey) throw new Error(`Enter the ${newProvider.name} API key before saving.`);
    const connection = await putGatewayConnection(newProvider.providerId, {
      // An explicit id is what makes the Nth entry a new account instead of overwriting the first:
      // omitting it makes the gateway reuse the provider's existing connection. Edit carries its own.
      ...(newProvider.connectionId ? { id: newProvider.connectionId } : {}),
      name: newProvider.name,
      endpoint: newProvider.endpoint,
      ...(keyless ? { credential: 'none' as const } : { apiKey: apiKey! }),
      ...(newProvider.priority ? { priority: newProvider.priority } : {}),
      ...(newProvider.modelPolicy ? { modelPolicy: newProvider.modelPolicy } : {}),
    });
    // Read the gateway back instead of splicing the response into local state. Splicing a `{...base}`
    // card beside an unsaved placeholder produced two nodes with the same React key, and the filter
    // meant to drop the placeholder matched an id shape the placeholder does not use.
    await load();
    setAddOpen(false);
    setInitialProviderId(undefined);
    setInitialModelPolicy(undefined);
    showNotice(`${newProvider.name} connection saved. ${connection.modelIds.length} models available.`, false, 4000);
  }

  async function handleSaveMany(entries: Array<{ provider: NewProvider; key: string }>) {
    // Saved one at a time, and reported honestly. The bulk path used to add every card to the local list
    // at once, so one rejected credential still produced a green card for it.
    //
    // Each entry now brings **its own key**. This loop was already honest, and it still could not save
    // anything: the modal built its entries with `hasKey: true` and no key, so every iteration reached
    // `handleSave` with nothing to send. `tests/bulk-entries.test.js` calls the parser that used to drop it.
    const saved: string[] = [];
    const failed: string[] = [];
    const notSaved: NewProvider[] = [];
    for (const { provider, key } of entries) {
      try {
        // Every entry is its own connection. Without an id the gateway reuses the provider's existing
        // connection, so N pasted keys produced one row while this loop reported N saved successes.
        const connectionId = provider.connectionId ?? `${provider.providerId.slice(0, 40)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        await handleSave({ ...provider, connectionId }, key);
        saved.push(provider.name);
      } catch (error) {
        failed.push(`${provider.name}: ${error instanceof Error ? error.message : 'the gateway refused it'}`);
        notSaved.push(provider);
      }
    }
    if (failed.length > 0) {
      finishAddLocally(notSaved);
      showNotice(`${saved.length} saved. ${failed.length} not saved — ${failed.join('; ')}`, true, 5000);
    } else if (saved.length > 0) {
      showNotice(`${saved.length} ${saved.length === 1 ? 'connection was' : 'connections were'} saved.`, false, 5000);
    }
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
      showNotice(`${healthyCount} of ${health.providers.length} provider connections are healthy.`, false, 5000);
    } catch {
      showNotice('Local gateway unavailable. Start it with pnpm dev:gateway.', true);
    } finally {
      setTestingAll(false);
    }
  }

  function renderProviderCard(provider: ProviderRecord, index = 0) {
    const detailTo = providerRoute(provider.catalogId ?? provider.id);
    const simpleEnabled = provider.status === 'connected' && (gatewayConnections.find((connection) => connection.providerId === (provider.connectionProviderId ?? provider.id))?.enabled ?? true);
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
    // The grid arrives as a wave: the wrapper carries the stagger index, and the card inside fills it.
    return (
      <div key={provider.id} className="rise-in h-full" style={{ '--i': index } as CSSProperties}>
        <ProviderCard provider={provider} detailTo={detailTo} mode={cardMode} simpleEnabled={simpleEnabled} onToggle={(enabled) => toggleProvider(provider, enabled)} onManage={() => navigate(detailTo)} onConnect={onConnect} />
      </div>
    );
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

        {notice && <div role="status" className={`mb-5 flex items-center gap-2 rounded-xl border px-3.5 py-3 text-xs ${noticeError ? badgeTone.bad : 'border-success/25 bg-success/10 text-success'}`}>{noticeError ? <CircleAlert className="h-4 w-4" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}{notice}</div>}

        {cardMode === 'advanced' && (
          <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Provider summary">
            <SummaryCard label="Connected" value={String(connectedCount)} detail="live" icon={Network} tone={badgeTone.ok} />
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
              value={!healthReport ? '—' : healthReportComplete ? `${credentialCheckedCount} of ${healthReport.providers.length}` : 'incomplete'}
              detail={healthReport && !healthReportComplete ? 'no per-provider list in /health' : 'credential accepted'}
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
                          <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${connectionBadge(provider, savedProviderIds.has(provider.connectionProviderId ?? provider.id)).tone}`}>
                            {connectionBadge(provider, savedProviderIds.has(provider.connectionProviderId ?? provider.id)).label}
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

            {groupedProviders.length > 0 ? (
              <div className="space-y-6 p-4 sm:p-5">
                {groupedProviders.map(({ group, providers: grouped }) => (
                  <section key={group} aria-labelledby={`provider-group-${group}`}>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 id={`provider-group-${group}`} className="flex items-center gap-2 text-sm font-semibold">
                        {providerGroupLabels[group]}
                        {providerGroupBadges[group] && (
                          <span className="rounded-full border border-gold/30 bg-gold-soft px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-gold-text">
                            {providerGroupBadges[group]}
                          </span>
                        )}
                      </h3>
                      <span className="muted font-mono text-[10px]">{grouped.length} {grouped.length === 1 ? 'provider' : 'providers'}</span>
                    </div>
                    <div className={`grid gap-3 ${cardMode === 'simple' ? 'grid-cols-[repeat(auto-fit,minmax(272px,1fr))] xl:grid-cols-4' : 'grid-cols-[repeat(auto-fit,minmax(320px,1fr))] xl:grid-cols-3 2xl:grid-cols-4'}`}>
                      {grouped.map((provider, index) => renderProviderCard(provider, index))}
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
