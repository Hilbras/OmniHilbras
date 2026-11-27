import { useCallback, useEffect, useState } from 'react';
import { Check, FileText, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  activateGatewayPrompt,
  listGatewayPrompts,
  removeGatewayPrompt,
  saveGatewayPrompt,
  type GatewayPrompt,
} from '../lib/gatewayClient';

/**
 * Versioned prompts, as content the operator owns.
 *
 * Every save appends a version; activating an older one is one click. The page shows the active
 * content and the variable names, and never renders a prompt with a missing value — the gateway
 * refuses that, so the page shows its refusal rather than a placeholder the model would read.
 */
export function PromptsContent() {
  const [prompts, setPrompts] = useState<GatewayPrompt[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(false);
  const [newId, setNewId] = useState('');
  const [newContent, setNewContent] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await listGatewayPrompts(signal);
      setAvailable(result.available);
      setPrompts(result.prompts ?? []);
      if (!result.available && result.reason) setNotice(result.reason);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(true);
      setNotice(caught instanceof Error ? caught.message : 'The prompt registry could not be read.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function create() {
    if (busy || !newId.trim() || !newContent.trim()) return;
    setBusy('new');
    try {
      const prompt = await saveGatewayPrompt({ id: newId.trim(), content: newContent });
      setPrompts((current) => [...current.filter((item) => item.id !== prompt.id), prompt]);
      setNewId('');
      setNewContent('');
      setError(false);
      setNotice(`Created ${prompt.id} at version ${prompt.activeVersion}.`);
    } catch (caught) {
      setError(true);
      setNotice(caught instanceof Error ? caught.message : 'The prompt could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  async function appendVersion(prompt: GatewayPrompt) {
    const content = drafts[prompt.id]?.trim();
    if (!content || busy) return;
    setBusy(prompt.id);
    try {
      const updated = await saveGatewayPrompt({ id: prompt.id, content });
      setPrompts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setDrafts((current) => ({ ...current, [prompt.id]: '' }));
      setError(false);
      setNotice(`${prompt.id} is at version ${updated.activeVersion}.`);
    } catch (caught) {
      setError(true);
      setNotice(caught instanceof Error ? caught.message : 'The version could not be saved.');
    } finally {
      setBusy(null);
    }
  }

  async function activate(prompt: GatewayPrompt, version: number) {
    if (busy) return;
    setBusy(prompt.id);
    try {
      const updated = await activateGatewayPrompt(prompt.id, version);
      setPrompts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setError(false);
      setNotice(`${prompt.id} now uses version ${version}.`);
    } catch (caught) {
      setError(true);
      setNotice(caught instanceof Error ? caught.message : 'The version could not be activated.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(prompt: GatewayPrompt) {
    if (busy) return;
    setBusy(prompt.id);
    try {
      await removeGatewayPrompt(prompt.id);
      setPrompts((current) => current.filter((item) => item.id !== prompt.id));
      setNotice(`${prompt.id} was removed.`);
    } catch (caught) {
      setError(true);
      setNotice(caught instanceof Error ? caught.message : 'The prompt could not be removed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Prompt registry</span>
          <h2 className="mt-4 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Prompts with a history.</h2>
          <p className="muted mt-2 max-w-xl text-sm leading-relaxed">Every save appends a version. Activate an older one to roll back; a render refuses a missing variable instead of sending it to a model.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="btn-ghost !px-3 !py-2.5 !text-xs">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh
        </button>
      </div>

      {notice && <p className={`mb-4 rounded-lg border px-3 py-2 text-xs ${error ? 'border-danger/40 bg-danger/10 text-danger' : 'border-success/30 bg-success/10 text-success'}`} role="status">{notice}</p>}

      {!available ? (
        <p className="card p-6 text-sm text-muted">This gateway was started without a prompt store.</p>
      ) : (
        <div className="space-y-4">
          <div className="card p-4">
            <p className="text-xs font-semibold">New prompt</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-[12rem_1fr_auto]">
              <input value={newId} onChange={(event) => setNewId(event.target.value)} placeholder="id, e.g. support-reply" aria-label="New prompt id" className="input !h-10 !rounded-lg !border !border-line !bg-surface-2 !px-3 !text-sm" />
              <input value={newContent} onChange={(event) => setNewContent(event.target.value)} placeholder="Content, with {{variables}}" aria-label="New prompt content" className="input !h-10 !rounded-lg !border !border-line !bg-surface-2 !px-3 !text-sm" />
              <button type="button" onClick={() => void create()} disabled={busy !== null || !newId.trim() || !newContent.trim()} className="btn-gold !px-4 !py-2 !text-xs disabled:opacity-60">
                {busy === 'new' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />} Create
              </button>
            </div>
          </div>

          {prompts.length === 0 && !loading && <p className="card p-6 text-sm text-muted">No prompts yet. A prompt is content, not a credential; it is included in the encrypted backup.</p>}

          {prompts.map((prompt) => {
            const active = prompt.versions.find((version) => version.version === prompt.activeVersion);
            return (
              <div key={prompt.id} className="card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="flex items-center gap-2 text-sm font-semibold"><FileText className="h-4 w-4 text-gold" aria-hidden="true" />{prompt.id}</p>
                    <p className="muted mt-0.5 font-mono text-[10px]">{prompt.versions.length} {prompt.versions.length === 1 ? 'version' : 'versions'} · active v{prompt.activeVersion}{active?.variables.length ? ` · ${active.variables.map((name) => `{{${name}}}`).join(' ')}` : ''}</p>
                  </div>
                  <button type="button" onClick={() => void remove(prompt)} disabled={busy !== null} aria-label={`Remove ${prompt.id}`} className="rounded-md p-1.5 text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
                </div>
                <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-2 p-2.5 font-mono text-[11px] leading-relaxed">{active?.content}</pre>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {prompt.versions.map((version) => (
                    <button key={version.version} type="button" onClick={() => void activate(prompt, version.version)} disabled={busy !== null || version.version === prompt.activeVersion} className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${version.version === prompt.activeVersion ? 'border-gold/40 bg-gold-soft text-gold-text' : 'border-line-strong bg-surface-2 text-muted hover:text-text'} disabled:opacity-70`}>
                      v{version.version}{version.version === prompt.activeVersion ? <Check className="ml-1 inline h-3 w-3" aria-hidden="true" /> : null}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input value={drafts[prompt.id] ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [prompt.id]: event.target.value }))} placeholder="New version content" aria-label={`New version for ${prompt.id}`} className="input !h-9 min-w-0 flex-1 !rounded-lg !border !border-line !bg-surface-2 !px-3 !text-xs" />
                  <button type="button" onClick={() => void appendVersion(prompt)} disabled={busy !== null || !(drafts[prompt.id] ?? '').trim()} className="btn-ghost !px-3 !py-1.5 !text-xs disabled:opacity-60">
                    {busy === prompt.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null} Save version
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
