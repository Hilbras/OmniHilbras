import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Boxes,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  getGatewayRoutingState,
  listGatewayConnections,
  listGatewayVirtualModels,
  removeGatewayVirtualModel,
  saveGatewayVirtualModel,
  testGatewayVirtualModel,
  updateGatewayVirtualModel,
  type GatewayConnection,
  type GatewayRoutingState,
  type GatewayVirtualModel,
} from '../lib/gatewayClient';
import { resolveProviderOption } from '../lib/providerOptions';
import { useGatewayReload } from '../lib/useGatewayStatus';

const strategies: Array<{ value: GatewayVirtualModel['strategy']; label: string; hint: string }> = [
  { value: 'priority', label: 'Priority', hint: 'Try the lowest-numbered target first.' },
  { value: 'round-robin', label: 'Round robin', hint: 'Rotate targets in order.' },
  { value: 'fastest', label: 'Fastest', hint: 'Prefer the measured fastest account; unmeasured targets come last.' },
];

type DraftTarget = { connectionId: string; upstreamModelId: string; priority: number; enabled: boolean };
type Draft = { id: string; name: string; strategy: GatewayVirtualModel['strategy']; enabled: boolean; targets: DraftTarget[] };

function emptyDraft(connections: GatewayConnection[]): Draft {
  const first = connections[0];
  return {
    id: 'oh/',
    name: '',
    strategy: 'priority',
    enabled: true,
    targets: first ? [{ connectionId: first.id, upstreamModelId: first.modelIds[0] ?? '', priority: 1, enabled: true }] : [],
  };
}

function toDraft(model: GatewayVirtualModel): Draft {
  return {
    id: model.id,
    name: model.name,
    strategy: model.strategy,
    enabled: model.enabled,
    targets: model.targets.map((target) => ({ ...target })),
  };
}

export function ModelsContent() {
  const [models, setModels] = useState<GatewayVirtualModel[]>([]);
  const [connections, setConnections] = useState<GatewayConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string>();
  /**
   * The live routing state, per account: measured latency, failures, ejection and rate-limit waits.
   *
   * It is what makes "why would this target be skipped" answerable before a request fails — the same data the
   * Routing page shows, read here per target. Absent fields stay absent: an unmeasured account says so rather
   * than showing a zero.
   */
  const [routing, setRouting] = useState<GatewayRoutingState>();
  const [testingId, setTestingId] = useState<string>();
  const [probes, setProbes] = useState<Record<string, { ok: boolean; text: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextModels, nextConnections, nextRouting] = await Promise.all([
        listGatewayVirtualModels(),
        listGatewayConnections(),
        // A routing read that fails must not take the model list with it: the page still lists and edits
        // combos, it just cannot say how each account is doing.
        getGatewayRoutingState().catch(() => undefined),
      ]);
      setModels(nextModels);
      setConnections(nextConnections);
      setRouting(nextRouting);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The model catalog could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useGatewayReload(load, [load]);

  const connectionById = useMemo(() => new Map(connections.map((connection) => [connection.id, connection])), [connections]);

  const openCreate = () => setDraft(emptyDraft(connections));
  const openEdit = (model: GatewayVirtualModel) => setDraft(toDraft(model));

  const addTarget = () => setDraft((current) => {
    if (!current) return current;
    const connection = connections[0];
    return {
      ...current,
      targets: [...current.targets, { connectionId: connection?.id ?? '', upstreamModelId: connection?.modelIds[0] ?? '', priority: current.targets.length + 1, enabled: true }],
    };
  });

  const patchTarget = (index: number, patch: Partial<DraftTarget>) => setDraft((current) => {
    if (!current) return current;
    return { ...current, targets: current.targets.map((target, at) => (at === index ? { ...target, ...patch } : target)) };
  });

  const save = async () => {
    if (!draft) return;
    if (!draft.id.startsWith('oh/') || draft.id.length <= 3) {
      setError('A virtual model id must start with "oh/" and have a name after it.');
      return;
    }
    if (draft.targets.length === 0) {
      setError('Add at least one target.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const input = {
        name: draft.name || draft.id.slice(3),
        enabled: draft.enabled,
        strategy: draft.strategy,
        targets: draft.targets.map((target) => ({
          connectionId: target.connectionId,
          upstreamModelId: target.upstreamModelId,
          priority: target.priority,
          enabled: target.enabled,
        })),
      };
      if (models.some((model) => model.id === draft.id)) await updateGatewayVirtualModel(draft.id, input);
      else await saveGatewayVirtualModel({ id: draft.id, ...input });
      setDraft(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The virtual model could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  /**
   * A target named by its **provider**, not by whatever the connection happens to be called.
   *
   * An account's own name is often a note to self — "main", "5k0eqgspm6" — while the provider is the thing a
   * person recognises. So the provider's catalog name is what a target is called here.
   *
   * **A provider with more than one account keeps its account in the label.** Two rows both reading
   * "OpenRouter" would be two selections a person cannot tell apart, and the store needs a *connection*: the
   * disambiguation is not decoration, it is the only thing that makes an otherwise identical pair pickable. A
   * provider whose id has no catalog card falls back to the id itself, which is at least the provider.
   */
  const providerLabel = (connection: GatewayConnection): string => {
    const option = resolveProviderOption(connection.providerId);
    const name = option.name && option.id === connection.providerId ? option.name : connection.providerId;
    const accounts = connections.filter((entry) => entry.providerId === connection.providerId);
    if (accounts.length <= 1) return name;
    return `${name} — ${connection.name}${connection.email ? ` · ${connection.email}` : ''}`;
  };

  /**
   * How one target looks right now, from the gateway's own routing state.
   *
   * Every branch names a real condition the router acts on (`routing.ts`): a disabled account, a missing
   * credential, a rate-limit wait, an ejection after consecutive failures. "never measured" is its own answer,
   * because the ledger records latency only after a success — absent and zero are different facts.
   */
  const statusFor = (connectionId: string): { label: string; tone: 'ok' | 'warn' | 'bad' | 'unknown' } => {
    const entry = routing?.connections.find((candidate) => candidate.connectionId === connectionId);
    if (!entry) return { label: 'no reading', tone: 'unknown' };
    if (!entry.enabled) return { label: 'disabled', tone: 'bad' };
    if (!entry.hasCredential) return { label: 'no credential', tone: 'bad' };
    if (entry.rateLimitWaitMs !== undefined && entry.rateLimitWaitMs > 0) return { label: `rate-limited ${Math.ceil(entry.rateLimitWaitMs / 1000)}s`, tone: 'warn' };
    if (entry.ejected) return { label: 'ejected', tone: 'bad' };
    if (entry.failures && entry.failures > 0) return { label: `${entry.failures} failure${entry.failures === 1 ? '' : 's'}`, tone: 'warn' };
    if (entry.latency) return { label: `${Math.round(entry.latency.latencyMs)} ms`, tone: 'ok' };
    return { label: 'never measured', tone: 'unknown' };
  };

  const toneClass = (tone: 'ok' | 'warn' | 'bad' | 'unknown') => (tone === 'ok'
    ? 'border-success/25 bg-success/10 text-success'
    : tone === 'warn'
      ? 'border-gold/30 bg-gold-soft text-gold-text'
      : tone === 'bad'
        ? 'border-danger/30 bg-danger/10 text-danger'
        : 'border-line bg-bg text-muted');

  /**
   * Sends one real turn through the combo and reports which member answered.
   *
   * The page cannot know that itself: the whole point of a combo is that the gateway decides. So this reads
   * the gateway's own `provider`/`connection`/`model` from the reply, and on a refusal shows the refusal
   * instead of a member it guessed.
   */
  const testModel = async (model: GatewayVirtualModel) => {
    setTestingId(model.id);
    setError(undefined);
    setProbes((current) => ({ ...current, [model.id]: { ok: true, text: 'Sending one turn through this combo...' } }));
    try {
      const result = await testGatewayVirtualModel(model.id);
      const account = result.connection ? connectionById.get(result.connection)?.name ?? result.connection : undefined;
      const served = [result.provider || 'unknown provider', account, result.model].filter(Boolean).join(' · ');
      setProbes((current) => ({
        ...current,
        [model.id]: {
          ok: result.ok,
          text: result.ok
            ? `Answered by ${served} in ${result.latencyMs} ms.${result.note ? ` ${result.note}` : ''}`
            : `${served} answered with nothing in ${result.latencyMs} ms. ${result.note ?? ''}`.trim(),
        },
      }));
      // The probe just spent a request: health and the latency ledger have moved.
      await load();
    } catch (cause) {
      setProbes((current) => ({ ...current, [model.id]: { ok: false, text: cause instanceof Error ? cause.message : 'The test failed.' } }));
    } finally {
      setTestingId(undefined);
    }
  };

  const toggle = async (model: GatewayVirtualModel) => {
    setBusyId(model.id);
    setError(undefined);
    try {
      await updateGatewayVirtualModel(model.id, {
        enabled: !model.enabled,
        strategy: model.strategy,
        name: model.name,
        targets: model.targets,
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The virtual model could not be changed.');
    } finally {
      setBusyId(undefined);
    }
  };

  const remove = async (model: GatewayVirtualModel) => {
    if (!window.confirm(`Delete ${model.id}?`)) return;
    setBusyId(model.id);
    setError(undefined);
    try {
      await removeGatewayVirtualModel(model.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The virtual model could not be deleted.');
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> Virtual models</p>
          <h1 className="mt-2 text-xl font-semibold tracking-[-0.03em] sm:text-2xl">One id, many accounts.</h1>
          <p className="muted mt-1.5 max-w-2xl text-sm">A virtual model starts with <code className="font-mono text-gold-text">oh/</code> and routes to the targets below. Disable it to stop using the alias without deleting its targets.</p>
          {/* The three strategies, in the page rather than only in a select: which one is set decides what the
              order below means, and the reference project put the same legend above its list. */}
          <dl className="muted mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
            {strategies.map((strategy) => (
              <div key={strategy.value} className="flex items-baseline gap-1.5">
                <dt className="font-semibold text-gold-text">{strategy.label}</dt>
                <dd>{strategy.hint}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void load()} className="btn-ghost !px-3 !py-2 !text-xs"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />Refresh</button>
          <span className="muted hidden items-center gap-1 text-[11px] sm:flex" title="Test sends one real turn and reports which member answered">
            <Activity className="h-3.5 w-3.5 text-gold-text" aria-hidden="true" />
            {routing ? `${routing.connections.filter((entry) => entry.hasCredential && entry.enabled).length} accounts routable` : ''}
          </span>
          <button type="button" onClick={openCreate} disabled={connections.length === 0} className="btn-gold !px-3 !py-2 !text-xs disabled:cursor-not-allowed disabled:opacity-40"><Plus className="h-3.5 w-3.5" aria-hidden="true" />Create model</button>
        </div>
      </div>

      {error && <div role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-xs text-danger">{error}</div>}

      {loading && models.length === 0 ? (
        <div className="muted mt-10 flex items-center justify-center gap-2 text-xs"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Reading virtual models…</div>
      ) : models.length === 0 ? (
        <div className="card mt-6 flex flex-col items-center px-6 py-14 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-2xl border border-gold/25 bg-gold-soft text-gold-text"><Boxes className="h-5 w-5" aria-hidden="true" /></span>
          <h2 className="mt-4 text-sm font-semibold">No virtual models yet</h2>
          <p className="muted mt-1.5 max-w-md text-xs leading-relaxed">A virtual model is a public <code className="font-mono">oh/</code> id with one or more saved account/model targets. It is how one model name can route across providers.</p>
          <button type="button" onClick={openCreate} disabled={connections.length === 0} className="btn-gold mt-5 !px-3.5 !py-2 !text-xs disabled:cursor-not-allowed disabled:opacity-40"><Plus className="h-3.5 w-3.5" aria-hidden="true" />Create model</button>
          {connections.length === 0 && <p className="muted mt-3 text-[11px]">Connect a provider first.</p>}
        </div>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {models.map((model) => {
            const busy = busyId === model.id;
            return (
              <article key={model.id} className={`card flex flex-col p-5 ${model.enabled ? '' : 'opacity-70'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm font-semibold text-gold-text">{model.id}</p>
                    <p className="muted mt-1 truncate text-xs">{model.name}</p>
                  </div>
                  <button type="button" onClick={() => void toggle(model)} disabled={busy} aria-pressed={model.enabled} aria-label={`${model.enabled ? 'Disable' : 'Enable'} ${model.id}`} className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${model.enabled ? 'border-gold bg-gold' : 'border-line bg-bg-soft'}`}>
                    <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-bg transition-all ${model.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <span className="rounded-full border border-line bg-bg-soft px-2 py-0.5 font-mono text-[10px] text-muted">{model.strategy}</span>
                  <span className="rounded-full border border-line bg-bg-soft px-2 py-0.5 font-mono text-[10px] text-muted">{model.targets.filter((target) => target.enabled).length} targets</span>
                  <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${model.enabled ? 'border-success/25 bg-success/10 text-success' : 'border-line bg-bg-soft text-muted'}`}>{model.enabled ? 'active' : 'disabled'}</span>
                </div>
                <ul className="mt-4 flex-1 space-y-2">
                  {model.targets.map((target, index) => (
                    <li key={`${target.connectionId}-${target.upstreamModelId}-${index}`} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-bg-soft px-2.5 py-2 font-mono text-[10px]">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {connectionById.has(target.connectionId) ? providerLabel(connectionById.get(target.connectionId)!) : target.connectionId}
                        </span>
                        <span className="muted block truncate">{target.upstreamModelId}</span>
                      </span>
                      {(() => {
                        const status = statusFor(target.connectionId);
                        return (
                          <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] ${toneClass(status.tone)}`} title="Live routing state for this account">
                            {status.label}
                          </span>
                        );
                      })()}
                    </li>
                  ))}
                </ul>
                {probes[model.id] && (
                  <p className={`mt-3 rounded-lg border px-2.5 py-2 text-[10px] leading-relaxed ${probes[model.id].ok ? 'border-line bg-bg-soft text-muted' : 'border-danger/30 bg-danger/10 text-danger'}`}>
                    {probes[model.id].text}
                  </p>
                )}
                <div className="mt-4 flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => void testModel(model)}
                    disabled={busy || testingId === model.id || !model.enabled}
                    title={model.enabled ? 'Sends one real turn through this combo and names the member that answers. A few tokens, billed to that member.' : 'Enable this model to test it.'}
                    className="btn-ghost !px-2.5 !py-1.5 !text-[11px]"
                  >
                    {testingId === model.id ? <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Play className="h-3 w-3" aria-hidden="true" />}
                    {testingId === model.id ? 'Testing' : 'Test'}
                  </button>
                  <button type="button" onClick={() => openEdit(model)} disabled={busy} className="btn-ghost !px-2.5 !py-1.5 !text-[11px]"><Pencil className="h-3 w-3" aria-hidden="true" />Edit</button>
                  <button type="button" onClick={() => void remove(model)} disabled={busy} className="btn-ghost !px-2.5 !py-1.5 !text-[11px] text-danger"><Trash2 className="h-3 w-3" aria-hidden="true" />Delete</button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {draft && (
        <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto bg-black/60 p-3 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="model-dialog-title">
          <div className="card w-full max-w-2xl p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div><p className="eyebrow">Virtual model</p><h2 id="model-dialog-title" className="mt-1 text-lg font-semibold">{models.some((model) => model.id === draft.id) ? 'Edit model' : 'Create model'}</h2></div>
              <button type="button" onClick={() => setDraft(null)} className="muted grid h-8 w-8 place-items-center rounded-lg hover:bg-bg-soft hover:text-text" aria-label="Close"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="block sm:col-span-2"><span className="mono-label mb-1.5 block">Public model id</span><input value={draft.id} onChange={(event) => setDraft((current) => current ? { ...current, id: event.target.value } : current)} placeholder="oh/chat" className="input font-mono" /><span className={`mt-1 block text-[10px] ${draft.id.startsWith('oh/') && draft.id.length > 3 ? 'text-muted' : 'text-danger'}`}>Must start with <code className="font-mono">oh/</code>. Clients send this exact id.</span></label>
              <label className="block"><span className="mono-label mb-1.5 block">Display name</span><input value={draft.name} onChange={(event) => setDraft((current) => current ? { ...current, name: event.target.value } : current)} placeholder="Chat" className="input" /></label>
              <label className="block"><span className="mono-label mb-1.5 block">Strategy</span><select value={draft.strategy} onChange={(event) => setDraft((current) => current ? { ...current, strategy: event.target.value as Draft['strategy'] } : current)} className="input">{strategies.map((strategy) => <option key={strategy.value} value={strategy.value}>{strategy.label} — {strategy.hint}</option>)}</select></label>
            </div>

            <div className="mt-5">
              <div className="flex items-center justify-between"><span className="mono-label">Targets</span><button type="button" onClick={addTarget} className="btn-ghost !px-2.5 !py-1.5 !text-[11px]"><Plus className="h-3 w-3" aria-hidden="true" />Add target</button></div>
              <div className="mt-2 space-y-2">
                {draft.targets.length === 0 && <p className="muted rounded-xl border border-dashed border-line p-4 text-xs">No targets. Add one to make this model routable.</p>}
                {draft.targets.map((target, index) => {
                  const connection = connectionById.get(target.connectionId);
                  return (
                    <div key={index} className="grid gap-2 rounded-xl border border-line bg-bg-soft p-3 sm:grid-cols-[1fr_1fr_auto_auto]">
                      <label className="block"><span className="mono-label mb-1 block text-[9px]">Provider</span><select value={target.connectionId} onChange={(event) => { const next = connections.find((entry) => entry.id === event.target.value); patchTarget(index, { connectionId: event.target.value, upstreamModelId: next?.modelIds[0] ?? '' }); }} className="input !py-1.5 !text-xs">{connections.map((entry) => <option key={entry.id} value={entry.id}>{providerLabel(entry)}</option>)}</select></label>
                      <label className="block"><span className="mono-label mb-1 block text-[9px]">Upstream model</span><select value={target.upstreamModelId} onChange={(event) => patchTarget(index, { upstreamModelId: event.target.value })} className="input !py-1.5 !text-xs">{(connection?.modelIds ?? []).map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}</select></label>
                      <label className="block"><span className="mono-label mb-1 block text-[9px]">Priority</span><input type="number" min={0} max={1000} value={target.priority} onChange={(event) => patchTarget(index, { priority: Number(event.target.value) })} className="input !w-20 !py-1.5 !text-xs" /></label>
                      <button type="button" onClick={() => setDraft((current) => current ? { ...current, targets: current.targets.filter((_, at) => at !== index) } : current)} className="muted mt-4 grid h-8 w-8 place-items-center rounded-lg hover:bg-bg hover:text-danger" aria-label="Remove target"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => current ? { ...current, enabled: event.target.checked } : current)} /> Enabled</label>
              <div className="flex gap-2"><button type="button" onClick={() => setDraft(null)} className="btn-ghost !px-3 !py-2 !text-xs">Cancel</button><button type="button" onClick={() => void save()} disabled={saving} className="btn-gold !px-3 !py-2 !text-xs">{saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}Save model</button></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
