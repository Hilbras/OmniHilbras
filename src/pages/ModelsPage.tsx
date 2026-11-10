import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  listGatewayConnections,
  listGatewayVirtualModels,
  removeGatewayVirtualModel,
  saveGatewayVirtualModel,
  updateGatewayVirtualModel,
  type GatewayConnection,
  type GatewayVirtualModel,
} from '../lib/gatewayClient';
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextModels, nextConnections] = await Promise.all([listGatewayVirtualModels(), listGatewayConnections()]);
      setModels(nextModels);
      setConnections(nextConnections);
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
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void load()} className="btn-ghost !px-3 !py-2 !text-xs"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />Refresh</button>
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
                      <span className="truncate">{connectionById.get(target.connectionId)?.name ?? target.connectionId}</span>
                      <span className="muted truncate text-right">{target.upstreamModelId}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex items-center justify-end gap-1.5">
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
                      <label className="block"><span className="mono-label mb-1 block text-[9px]">Account</span><select value={target.connectionId} onChange={(event) => { const next = connections.find((entry) => entry.id === event.target.value); patchTarget(index, { connectionId: event.target.value, upstreamModelId: next?.modelIds[0] ?? '' }); }} className="input !py-1.5 !text-xs">{connections.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.email ? ` · ${entry.email}` : ''}</option>)}</select></label>
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
