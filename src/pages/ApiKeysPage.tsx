import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  CircleAlert,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import {
  createGatewayApiKey,
  listGatewayApiKeys,
  removeGatewayApiKey,
  setGatewayApiKeyEnabled,
  setGatewayRequireApiKey,
  type GatewayApiKey,
} from '../lib/gatewayClient';

const gatewayUrl = 'http://127.0.0.1:8787';

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'unknown' : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function relativeTime(value?: string) {
  if (!value) return 'never';
  const elapsed = Date.now() - new Date(value).getTime();
  if (Number.isNaN(elapsed)) return 'never';
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} h ago`;
  return `${Math.floor(elapsed / 86_400_000)} d ago`;
}

function maskPrefix(prefix: string) {
  return `${prefix}${'•'.repeat(20)}`;
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-60 ${checked ? 'border-gold/50 bg-gold/70' : 'border-line-strong bg-surface-2'}`}
    >
      <span className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-surface shadow-sm transition-transform ${checked ? 'translate-x-[1.45rem]' : 'translate-x-0.5'}`} />
    </button>
  );
}

function Modal({ title, description, children, onClose, width = 'max-w-md' }: { title: string; description?: string; children: ReactNode; onClose: () => void; width?: string }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} className={`card w-full ${width} p-5`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            {description && <p className="muted mt-1 text-xs leading-relaxed">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="muted -mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-surface-2 hover:text-text">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
      }}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="muted grid h-7 w-7 shrink-0 place-items-center rounded-lg hover:bg-surface-2 hover:text-gold-text"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
  );
}

function CodeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-soft/60 px-3 py-2">
      <span className="mono-label shrink-0">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-text">{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

export function ApiKeysContent() {
  const [keys, setKeys] = useState<GatewayApiKey[]>([]);
  const [requireApiKey, setRequireApiKey] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<{ name: string; key: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await listGatewayApiKeys(signal);
      setKeys(result.keys);
      setRequireApiKey(result.requireApiKey);
    } catch (error) {
      if (signal?.aborted) return;
      setNoticeError(true);
      setNotice(error instanceof Error ? error.message : 'The gateway could not be reached.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function flash(message: string, tone: 'success' | 'error' = 'success') {
    setNotice(message);
    setNoticeError(tone === 'error');
    window.setTimeout(() => setNotice(''), 3200);
  }

  async function toggleEnforcement(next: boolean) {
    if (saving) return;
    setSaving(true);
    const previous = requireApiKey;
    setRequireApiKey(next);
    try {
      await setGatewayRequireApiKey(next);
      flash(next ? 'API keys are now required for gateway clients.' : 'API key enforcement is off.');
    } catch (error) {
      setRequireApiKey(previous);
      flash(error instanceof Error ? error.message : 'The enforcement setting could not be saved.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function createKey() {
    if (creating) return;
    setCreating(true);
    try {
      const result = await createGatewayApiKey(newKeyName.trim());
      setCreateOpen(false);
      setNewKeyName('');
      setCreatedKey({ name: result.apiKey.name, key: result.key });
      await load();
    } catch (error) {
      flash(error instanceof Error ? error.message : 'The API key could not be created.', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function toggleKey(apiKey: GatewayApiKey, enabled: boolean) {
    if (busyKeyId) return;
    setBusyKeyId(apiKey.id);
    try {
      const updated = await setGatewayApiKeyEnabled(apiKey.id, enabled);
      setKeys((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      flash(`${apiKey.name} ${enabled ? 'resumed' : 'paused'}.`);
    } catch (error) {
      flash(error instanceof Error ? error.message : 'The API key could not be updated.', 'error');
    } finally {
      setBusyKeyId(null);
    }
  }

  async function deleteKey(apiKey: GatewayApiKey) {
    if (busyKeyId) return;
    setBusyKeyId(apiKey.id);
    try {
      await removeGatewayApiKey(apiKey.id);
      setKeys((current) => current.filter((item) => item.id !== apiKey.id));
      setPendingDelete(null);
      flash(`${apiKey.name} deleted.`);
    } catch (error) {
      flash(error instanceof Error ? error.message : 'The API key could not be deleted.', 'error');
    } finally {
      setBusyKeyId(null);
    }
  }

  const activeCount = keys.filter((key) => key.enabled).length;

  return (
    <div>
      <div className="mb-6 flex flex-col justify-between gap-5 sm:mb-8 sm:flex-row sm:items-end">
        <div>
          <span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />Access control</span>
          <h2 className="mt-4 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Keys for your clients.</h2>
          <p className="muted mt-2 max-w-xl text-sm leading-relaxed">Create a key for every tool that talks to this gateway. Secrets are shown once, then only a hash is kept on disk.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void load()} disabled={loading} className="btn-ghost !px-3 !py-2.5 !text-xs">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh
          </button>
          <button type="button" onClick={() => setCreateOpen(true)} className="btn-gold !px-3 !py-2.5 !text-xs">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Create key
          </button>
        </div>
      </div>

      <div className="mb-5 min-h-[3.25rem]" aria-live="polite">
        {notice && (
          <div role={noticeError ? 'alert' : 'status'} className={`flex items-center gap-2 rounded-xl border px-3.5 py-3 text-xs ${noticeError ? 'border-danger/25 bg-danger/10 text-danger' : 'border-success/25 bg-success/10 text-success'}`}>
            {noticeError ? <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" /> : <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
            {notice}
          </div>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="card overflow-hidden" aria-labelledby="keys-title">
          <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div>
              <h2 id="keys-title" className="flex items-center gap-2 text-sm font-semibold">
                <KeyRound className="h-4 w-4 text-gold-text" aria-hidden="true" />
                API keys
              </h2>
              <p className="muted mt-1 text-xs">
                {loading ? 'Loading keys…' : `${activeCount} active of ${keys.length} ${keys.length === 1 ? 'key' : 'keys'}`}
              </p>
            </div>
            <button type="button" onClick={() => setCreateOpen(true)} className="btn-ghost !px-3 !py-2 !text-xs">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              New key
            </button>
          </div>

          {keys.length === 0 && !loading ? (
            <div className="px-5 py-12 text-center">
              <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-gold/25 bg-gold-soft text-gold-text">
                <KeyRound className="h-6 w-6" aria-hidden="true" />
              </span>
              <p className="mt-4 text-sm font-semibold">No API keys yet</p>
              <p className="muted mt-1 text-xs">Create your first key so CLI tools and IDE extensions can call the gateway.</p>
              <button type="button" onClick={() => setCreateOpen(true)} className="btn-gold mt-4 !px-3 !py-2 !text-xs">
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Create key
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {keys.map((apiKey) => (
                <li key={apiKey.id} className={`p-4 sm:p-5 ${apiKey.enabled ? '' : 'opacity-70'}`}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold">{apiKey.name}</p>
                        <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide ${apiKey.enabled ? 'border-success/25 bg-success/10 text-success' : 'border-line-strong bg-surface-2 text-muted'}`}>
                          {apiKey.enabled ? 'active' : 'paused'}
                        </span>
                      </div>
                      <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[11px] text-muted">
                        <code>{maskPrefix(apiKey.prefix)}</code>
                      </p>
                      <p className="muted mt-1.5 text-[11px]">
                        Created {formatDate(apiKey.createdAt)} · Last used {relativeTime(apiKey.lastUsedAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        checked={apiKey.enabled}
                        disabled={busyKeyId === apiKey.id}
                        onChange={(next) => void toggleKey(apiKey, next)}
                        label={`${apiKey.enabled ? 'Pause' : 'Resume'} ${apiKey.name}`}
                      />
                      {pendingDelete === apiKey.id ? (
                        <div className="flex items-center gap-1.5">
                          <button type="button" onClick={() => void deleteKey(apiKey)} disabled={busyKeyId === apiKey.id} className="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] font-semibold text-danger disabled:opacity-60">
                            {busyKeyId === apiKey.id ? 'Deleting' : 'Confirm'}
                          </button>
                          <button type="button" onClick={() => setPendingDelete(null)} className="muted rounded-lg px-2 py-1.5 text-[11px] font-semibold hover:bg-surface-2 hover:text-text">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button type="button" onClick={() => setPendingDelete(apiKey.id)} aria-label={`Delete ${apiKey.name}`} className="muted grid h-8 w-8 place-items-center rounded-lg hover:bg-danger/10 hover:text-danger">
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="space-y-5">
          <section className="card p-4 sm:p-5" aria-labelledby="enforcement-title">
            <h2 id="enforcement-title" className="text-sm font-semibold">Require API key</h2>
            <div className="mt-3 flex items-start justify-between gap-4">
              <p className="muted text-xs leading-relaxed">When enforcement is on, gateway clients must send a valid key. The dashboard stays exempt so it can keep testing models.</p>
              <Switch checked={requireApiKey} disabled={saving} onChange={(next) => void toggleEnforcement(next)} label="Require API key" />
            </div>
            {requireApiKey && keys.length === 0 && !loading && (
              <p className="mt-3 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Enforcement is on and no keys exist, so every gateway client is rejected.
              </p>
            )}
            {requireApiKey && keys.length > 0 && (
              <p className="mt-3 flex items-start gap-2 rounded-lg border border-gold/25 bg-gold-soft px-3 py-2 text-[11px] text-gold-text">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {activeCount === 0 ? 'All keys are paused, so no client can authenticate.' : 'Clients authenticate with a bearer token on every request.'}
              </p>
            )}
          </section>

          <section className="card p-4 sm:p-5" aria-labelledby="client-title">
            <h2 id="client-title" className="flex items-center gap-2 text-sm font-semibold">
              <Terminal className="h-4 w-4 text-gold-text" aria-hidden="true" />
              Client setup
            </h2>
            <p className="muted mt-1 text-xs">Point any OpenAI-compatible client at the local gateway.</p>
            <div className="mt-3 space-y-2">
              <CodeRow label="Base URL" value={`${gatewayUrl}/v1`} />
              <CodeRow label="Header" value="Authorization: Bearer <key>" />
              <CodeRow label="Also accepted" value="x-api-key: <key>" />
            </div>
            <p className="muted mt-3 text-[11px] leading-relaxed">
              Keys are never accepted in the query string, and a paused or deleted key stops working immediately.
            </p>
          </section>
        </div>
      </div>

      <div className="mt-5 flex flex-col items-start justify-between gap-3 rounded-xl border border-gold/20 bg-gold-soft/45 px-4 py-3.5 sm:flex-row sm:items-center sm:px-5">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" aria-hidden="true" />
          <div>
            <p className="text-xs font-semibold">Secrets are hashed, not stored.</p>
            <p className="muted mt-1 text-[11px]">OmniHilbras keeps a SHA-256 hash per key in <code className="font-mono">api-keys.json</code> and shows the secret exactly once.</p>
          </div>
        </div>
        <span className="font-mono text-[10px] text-gold-text">local mode · 0600</span>
      </div>

      {createOpen && (
        <Modal title="Create API key" description="Name the client that will use this key, for example “Cline” or “CLI tools”." onClose={() => { setCreateOpen(false); setNewKeyName(''); }}>
          <div className="mt-4">
            <label htmlFor="api-key-name" className="mb-2 block text-xs font-semibold">Key name</label>
            <input
              id="api-key-name"
              value={newKeyName}
              maxLength={80}
              onChange={(event) => setNewKeyName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void createKey(); }}
              placeholder="Production Key"
              className="input !h-11 !w-full !rounded-lg !border !border-line !bg-surface-2 !px-3 !text-sm"
            />
            <p className="muted mt-2 text-[11px]">1–80 characters. The secret is displayed once after creation.</p>
          </div>
          <div className="mt-5 flex gap-2">
            <button type="button" onClick={() => void createKey()} disabled={creating || !newKeyName.trim()} className="btn-gold flex-1 !py-2.5 !text-xs disabled:opacity-60">
              {creating ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              {creating ? 'Creating' : 'Create'}
            </button>
            <button type="button" onClick={() => { setCreateOpen(false); setNewKeyName(''); }} className="btn-ghost flex-1 !py-2.5 !text-xs">Cancel</button>
          </div>
        </Modal>
      )}

      {createdKey && (
        <Modal title="API key created" onClose={() => setCreatedKey(null)} width="max-w-xl">
          <div className="mt-4 rounded-xl border border-gold/35 bg-gold-soft/60 p-3.5">
            <p className="text-xs font-semibold text-gold-text">Save this key now</p>
            <p className="muted mt-1 text-[11px] leading-relaxed">This is the only time the secret is shown. OmniHilbras keeps a hash, so a lost key must be replaced.</p>
          </div>
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-bg-soft/70 px-3 py-2.5">
            <code className="min-w-0 flex-1 break-all font-mono text-[11px]">{createdKey.key}</code>
            <CopyButton value={createdKey.key} label="API key" />
          </div>
          <button type="button" onClick={() => setCreatedKey(null)} className="btn-ghost mt-4 w-full !py-2.5 !text-xs">Done</button>
        </Modal>
      )}
    </div>
  );
}
