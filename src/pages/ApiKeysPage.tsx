import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  CircleAlert,
  Copy,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import {
  createGatewayApiKey,
  getGatewaySpend,
  listGatewayApiKeys,
  removeGatewayApiKey,
  renameGatewayApiKey,
  setGatewayApiKeyLimits,
  setGatewayApiKeyEnabled,
  setGatewayRequireApiKey,
  gatewayOrigin,
  type GatewayApiKey,
} from '../lib/gatewayClient';
import { useGatewayReload } from '../lib/useGatewayStatus';
import { copyText } from '../lib/copyText';
import { badgeTone } from '../ui/primitives';
import { Switch } from '../ui/Switch';

const gatewayUrl = gatewayOrigin();

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


function Modal({ title, description, children, onClose, width = 'max-w-md' }: { title: string; description?: string; children: ReactNode; onClose: () => void; width?: string }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focusables = () => [...(panelRef.current?.querySelectorAll<HTMLElement>('input, select, textarea, button:not([disabled])') ?? [])];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return; }
      // Keep Tab inside the dialog so a keyboard user cannot reach the page behind it.
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    // Where focus came from, so closing the dialog does not drop a keyboard user at the top of the document.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
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
  // Three outcomes, not two. `failed` exists because the old fallback for "no clipboard API" was `return` — a button
  // that did nothing at all, silently, which is the same defect as claiming a copy that never happened.
  const [outcome, setOutcome] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (outcome === 'idle') return;
    const timer = window.setTimeout(() => setOutcome('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [outcome]);

  return (
    <button
      type="button"
      onClick={() => {
        void copyText(value).then((ok) => setOutcome(ok ? 'copied' : 'failed'));
      }}
      aria-label={outcome === 'copied' ? `${label} copied` : outcome === 'failed' ? `${label} could not be copied` : `Copy ${label}`}
      title={outcome === 'failed' ? 'The clipboard refused the write. Select the text and copy it by hand.' : undefined}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg hover:bg-surface-2 ${outcome === 'failed' ? 'text-danger' : 'muted hover:text-gold-text'}`}
    >
      {outcome === 'copied'
        ? <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
        : outcome === 'failed'
          ? <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />
          : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
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
  // `null` is "the gateway has not said", and it is not the same as `false`.
  // It used to start at `true`, so the switch claimed enforcement was on before anything had been read — and,
  // because the switch was only disabled while saving, an operator could flip a setting the page had guessed at.
  // On a gateway where enforcement was actually off, that turned "off" into a no-op that reported success.
  const [requireApiKey, setRequireApiKey] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<{ name: string; key: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // Renaming is inline because it changes one field: a dialog for it would be a form over a string the row already
  // shows, and the row is where the operator is looking when the name turns out to be wrong.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // A key with no limit is the case a leaked key makes expensive, so the control to set one sits on the row rather
  // than behind a settings page.
  const [limitsFor, setLimitsFor] = useState<GatewayApiKey | null>(null);
  const [rpmDraft, setRpmDraft] = useState('');
  const [expiryDraft, setExpiryDraft] = useState('');
  const [tpmDraft, setTpmDraft] = useState('');
  const [budgetDraft, setBudgetDraft] = useState('');
  const [budgetPeriodDraft, setBudgetPeriodDraft] = useState<'day' | 'week' | 'month' | 'total'>('month');
  const [modelsDraft, setModelsDraft] = useState('');
  const [spends, setSpends] = useState<Record<string, { usd: number; remainingUsd?: number; requests: number }>>({});
  const [savingLimits, setSavingLimits] = useState(false);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  /** Whether the key list has been read. `keys: []` before a read is not "there are no keys". */
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await listGatewayApiKeys(signal);
      setKeys(result.keys);
      setRequireApiKey(result.requireApiKey);
      setLoaded(true);
      // Spend is read from the ledger rather than derived from the bounded usage list; one request per
      // key is honest about that difference, and a failure leaves the badge absent rather than zero.
      const spendEntries = await Promise.all(result.keys.map(async (key) => {
        try {
          const spend = await getGatewaySpend(key.id, 'month', signal);
          return [key.id, { usd: spend.spend?.usd ?? 0, ...(spend.status?.remainingUsd === undefined ? {} : { remainingUsd: spend.status.remainingUsd }), requests: spend.spend?.requests ?? 0 }] as const;
        } catch {
          return undefined;
        }
      }));
      setSpends(Object.fromEntries(spendEntries.filter((entry): entry is readonly [string, { usd: number; remainingUsd?: number; requests: number }] => entry !== undefined)));
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
  useGatewayReload(load);

  const noticeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (noticeTimer.current !== undefined) window.clearTimeout(noticeTimer.current); }, []);

  /**
   * Show a notice for a moment, and never longer than its own moment.
   *
   * The timer used to be left running. Two notices within 3.2 s meant the first one's timer cleared the second one
   * early, and a notice set just before a navigation cleared state on an unmounted page.
   */
  function flash(message: string, tone: 'success' | 'error' = 'success') {
    setNotice(message);
    setNoticeError(tone === 'error');
    if (noticeTimer.current !== undefined) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 3200);
  }

  async function toggleEnforcement(next: boolean) {
    if (saving || requireApiKey === null) return;
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

  async function renameKey(apiKey: GatewayApiKey) {
    const name = renameDraft.trim();
    if (busyKeyId || !name || name === apiKey.name) { setRenamingId(null); return; }
    setBusyKeyId(apiKey.id);
    try {
      const updated = await renameGatewayApiKey(apiKey.id, name);
      setKeys((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setRenamingId(null);
      flash(`${apiKey.name} is now “${updated.name}”.`);
    } catch (error) {
      flash(error instanceof Error ? error.message : 'The API key could not be renamed.', 'error');
    } finally {
      setBusyKeyId(null);
    }
  }

  function openLimits(apiKey: GatewayApiKey) {
    setLimitsFor(apiKey);
    setRpmDraft(apiKey.rpm === undefined ? '' : String(apiKey.rpm));
    // `datetime-local` wants `YYYY-MM-DDTHH:mm`; the stored value is an ISO instant.
    setExpiryDraft(apiKey.expiresAt === undefined ? '' : new Date(apiKey.expiresAt).toISOString().slice(0, 16));
    setTpmDraft(apiKey.tpm === undefined ? '' : String(apiKey.tpm));
    setBudgetDraft(apiKey.budget?.usd === undefined ? '' : String(apiKey.budget.usd));
    setBudgetPeriodDraft(apiKey.budget?.period ?? 'month');
    setModelsDraft(apiKey.allowedModels?.join(', ') ?? '');
  }

  async function saveLimits() {
    if (!limitsFor || savingLimits) return;
    setSavingLimits(true);
    try {
      // Two PATCHes because the gateway accepts one intent per request, and clear-the-limit is `null`, not empty.
      const rpm = rpmDraft.trim() === '' ? null : Number(rpmDraft);
      await setGatewayApiKeyLimits(limitsFor.id, { rpm: rpm !== null && Number.isFinite(rpm) && rpm > 0 ? Math.floor(rpm) : null });
      const expiresAt = expiryDraft.trim() === '' ? null : new Date(expiryDraft).toISOString();
      await setGatewayApiKeyLimits(limitsFor.id, { expiresAt });
      const tpm = tpmDraft.trim() === '' ? null : Number(tpmDraft);
      await setGatewayApiKeyLimits(limitsFor.id, { tpm: tpm !== null && Number.isFinite(tpm) && tpm > 0 ? Math.floor(tpm) : null });
      const usd = budgetDraft.trim() === '' ? null : Number(budgetDraft);
      await setGatewayApiKeyLimits(limitsFor.id, {
        budget: usd !== null && Number.isFinite(usd) && usd > 0 ? { usd, period: budgetPeriodDraft } : null,
      });
      const models = modelsDraft.split(',').map((entry) => entry.trim()).filter(Boolean);
      const final = await setGatewayApiKeyLimits(limitsFor.id, { allowedModels: models.length > 0 ? models : null });
      setKeys((current) => current.map((item) => (item.id === final.id ? final : item)));
      setLimitsFor(null);
      flash(`Limits saved for ${final.name}.`);
    } catch (error) {
      flash(error instanceof Error ? error.message : 'The limits could not be saved.', 'error');
    } finally {
      setSavingLimits(false);
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
          <div role={noticeError ? 'alert' : 'status'} className={`flex items-center gap-2 rounded-xl border px-3.5 py-3 text-xs ${noticeError ? badgeTone.bad : 'border-success/25 bg-success/10 text-success'}`}>
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
          </div>

          {!loaded ? (
            <div className="px-5 py-12 text-center" role="status">
              <KeyRound className="mx-auto h-6 w-6 text-muted" aria-hidden="true" />
              <p className="mt-4 text-sm font-semibold">{loading ? 'Reading keys' : 'Keys could not be read'}</p>
              <p className="muted mt-1 text-xs">{loading ? 'Asking the gateway for its key list.' : 'Nothing is claimed about enforcement until the gateway answers.'}</p>
            </div>
          ) : keys.length === 0 ? (
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
                        {renamingId === apiKey.id ? (
                          <span className="flex items-center gap-1.5">
                            <input
                              value={renameDraft}
                              maxLength={80}
                              autoFocus
                              aria-label={`New name for ${apiKey.name}`}
                              onChange={(event) => setRenameDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') { event.preventDefault(); void renameKey(apiKey); }
                                if (event.key === 'Escape') { event.preventDefault(); setRenamingId(null); }
                              }}
                              className="input !h-8 !w-48 !rounded-lg !border !border-line !bg-surface-2 !px-2 !text-sm"
                            />
                            <button type="button" onClick={() => void renameKey(apiKey)} disabled={busyKeyId !== null || !renameDraft.trim()} aria-label={`Save name for ${apiKey.name}`} className="grid h-8 w-8 place-items-center rounded-lg text-success hover:bg-success/10 disabled:opacity-50">
                              {busyKeyId === apiKey.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                            </button>
                            <button type="button" onClick={() => setRenamingId(null)} aria-label={`Cancel renaming ${apiKey.name}`} className="muted grid h-8 w-8 place-items-center rounded-lg hover:bg-surface-2 hover:text-text">
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </span>
                        ) : (
                          <>
                            <p className="truncate text-sm font-semibold">{apiKey.name}</p>
                            <button
                              type="button"
                              onClick={() => { setRenamingId(apiKey.id); setRenameDraft(apiKey.name); }}
                              disabled={busyKeyId !== null}
                              aria-label={`Rename ${apiKey.name}`}
                              className="muted grid h-6 w-6 place-items-center rounded-md hover:bg-surface-2 hover:text-gold-text disabled:opacity-50"
                            >
                              <Pencil className="h-3 w-3" aria-hidden="true" />
                            </button>
                          </>
                        )}
                        <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide ${apiKey.enabled ? 'border-success/25 bg-success/10 text-success' : 'border-line-strong bg-surface-2 text-muted'}`}>
                          {apiKey.enabled ? 'active' : 'paused'}
                        </span>
                      </div>
                      <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[11px] text-muted">
                        <code>{maskPrefix(apiKey.prefix)}</code>
                      </p>
                      <p className="muted mt-1.5 text-[11px]">
                        Created {formatDate(apiKey.createdAt)} · Last used {relativeTime(apiKey.lastUsedAt)} · {(apiKey.requests ?? 0).toLocaleString()} {(apiKey.requests ?? 0) === 1 ? 'request' : 'requests'}
                      </p>
                      <p className="muted mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                        <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] ${apiKey.rpm === undefined ? 'border-line-strong bg-surface-2 text-muted' : badgeTone.warn}`}>
                          {apiKey.rpm === undefined ? 'no rate limit' : `${apiKey.rpm} rpm`}
                        </span>
                        <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] ${apiKey.expiresAt === undefined ? 'border-line-strong bg-surface-2 text-muted' : Date.parse(apiKey.expiresAt) <= Date.now() ? badgeTone.bad : badgeTone.neutral}`}>
                          {apiKey.expiresAt === undefined ? 'no expiry' : `expires ${formatDate(apiKey.expiresAt)}`}
                        </span>
                        <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] ${apiKey.tpm === undefined ? 'border-line-strong bg-surface-2 text-muted' : badgeTone.warn}`}>
                          {apiKey.tpm === undefined ? 'no token limit' : `${apiKey.tpm} tpm`}
                        </span>
                        <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] ${apiKey.budget === undefined ? 'border-line-strong bg-surface-2 text-muted' : badgeTone.warn}`}>
                          {apiKey.budget === undefined
                            ? 'no budget'
                            : `$${spends[apiKey.id]?.usd.toFixed(2) ?? '0.00'} spent · $${apiKey.budget.usd ?? '—'} / ${apiKey.budget.period}`}
                        </span>
                        <button type="button" onClick={() => openLimits(apiKey)} disabled={busyKeyId !== null} aria-label={`Set limits for ${apiKey.name}`} className="rounded-md px-1.5 py-0.5 font-mono text-[9px] text-gold-text hover:bg-gold-soft disabled:opacity-50">
                          change
                        </button>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        checked={apiKey.enabled}
                        disabled={busyKeyId !== null}
                        onChange={(next) => void toggleKey(apiKey, next)}
                        label={`${apiKey.enabled ? 'Pause' : 'Resume'} ${apiKey.name}`}
                      />
                      {pendingDelete === apiKey.id ? (
                        <div className="flex items-center gap-1.5">
                          <button type="button" onClick={() => void deleteKey(apiKey)} disabled={busyKeyId !== null} className="rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] font-semibold text-danger disabled:opacity-60">
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
              <Switch
                checked={requireApiKey === true}
                disabled={saving || requireApiKey === null}
                onChange={(next) => void toggleEnforcement(next)}
                label="Require API key"
              />
            </div>
            {requireApiKey === null && (
              <p className="muted mt-3 text-[11px]" role="status">
                {loading ? 'Reading this setting from the gateway…' : 'The gateway did not answer, so whether keys are required is unknown — and the switch is left alone until it does.'}
              </p>
            )}
            {loaded && requireApiKey === true && keys.length === 0 && (
              <p className="mt-3 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Enforcement is on and no keys exist, so every gateway client is rejected.
              </p>
            )}
            {loaded && requireApiKey === true && keys.length > 0 && (
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

      {limitsFor && (
        <Modal title="Key limits" description={`What ${limitsFor.name} may do, and for how long. Leave a field empty to remove that limit.`} onClose={() => setLimitsFor(null)}>
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold">Requests per minute</span>
              <input
                type="number"
                min={1}
                max={100000}
                value={rpmDraft}
                onChange={(event) => setRpmDraft(event.target.value)}
                placeholder="unlimited"
                className="input !h-10 !w-full !rounded-lg !border !border-line !bg-surface-2 !px-3 !text-sm"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold">Expires at</span>
              <input
                type="datetime-local"
                value={expiryDraft}
                onChange={(event) => setExpiryDraft(event.target.value)}
                className="input !h-10 !w-full !rounded-lg !border !border-line !bg-surface-2 !px-3 !text-sm"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold">Tokens per minute</span>
              <input
                type="number"
                min={1}
                value={tpmDraft}
                onChange={(event) => setTpmDraft(event.target.value)}
                placeholder="unlimited"
                className="input !h-10 !w-full !rounded-lg !border !border-line !bg-surface-2 !px-3 !text-sm"
              />
            </label>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold">Dollar budget</span>
                <input
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={budgetDraft}
                  onChange={(event) => setBudgetDraft(event.target.value)}
                  placeholder="none"
                  className="input !h-10 !w-full !rounded-lg !border !border-line !bg-surface-2 !px-3 !text-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold">Period</span>
                <select
                  value={budgetPeriodDraft}
                  onChange={(event) => setBudgetPeriodDraft(event.target.value as 'day' | 'week' | 'month' | 'total')}
                  className="input !h-10 !rounded-lg !border !border-line !bg-surface-2 !px-3 !text-sm"
                >
                  <option value="day">day</option>
                  <option value="week">week</option>
                  <option value="month">month</option>
                  <option value="total">total</option>
                </select>
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold">Allowed models</span>
              <input
                value={modelsDraft}
                onChange={(event) => setModelsDraft(event.target.value)}
                placeholder="empty means every model; globs like gpt-*"
                className="input !h-10 !w-full !rounded-lg !border !border-line !bg-surface-2 !px-3 !text-sm"
              />
            </label>
            <p className="muted text-[11px] leading-relaxed">A key past its expiry is refused and has to be replaced. A rate limit refuses with 429 and works again a minute later. A budget is checked before dispatch and reported in dollars from the spend ledger.</p>
          </div>
          <div className="mt-5 flex gap-2">
            <button type="button" onClick={() => void saveLimits()} disabled={savingLimits} className="btn-gold flex-1 !py-2.5 !text-xs disabled:opacity-60">
              {savingLimits ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
              {savingLimits ? 'Saving' : 'Save limits'}
            </button>
            <button type="button" onClick={() => setLimitsFor(null)} className="btn-ghost flex-1 !py-2.5 !text-xs">Cancel</button>
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
