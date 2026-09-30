import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCircle2, ChevronDown, CircleAlert, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react';
import { getProviderLogo, providerCatalog } from '../data/providers';
import { webSessionProviderIds } from '../lib/webSessionProviders';
import { checkConnectionCredential } from '../lib/gatewayClient';

export type ProviderOption = {
  id: string;
  name: string;
  description: string;
  auth: string;
  color: string;
  initial: string;
  logo?: string;
  defaultEndpoint?: string;
};

/**
 * Providers this dialog can collect a key for that have **no card** on the providers page.
 *
 * The gateway serves `openai`, `anthropic` and `gemini`, so these are connectable — the page simply
 * does not list them. That is a product decision about the card list, not about this dialog, so it is
 * recorded here rather than resolved by inventing three cards. Everything else is derived from
 * `providerCatalog` below, so this is the whole of the second list.
 */
const withoutCard: ProviderOption[] = [
  { id: 'openai', name: 'OpenAI', description: 'GPT and Responses APIs', auth: 'API key', color: '#6fdb9b', initial: 'O', logo: getProviderLogo('openai'), defaultEndpoint: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', description: 'Claude models', auth: 'API key', color: '#d97757', initial: 'A', logo: getProviderLogo('anthropic'), defaultEndpoint: 'https://api.anthropic.com/v1' },
  { id: 'google', name: 'Google', description: 'Gemini models', auth: 'API key', color: '#83b7ff', initial: 'G', logo: getProviderLogo('google'), defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta' },
];

/**
 * One list of providers, derived rather than re-declared.
 *
 * This used to be a hand-written list of ten, and it re-declared `name`, `description`, `auth`,
 * `color`, `initial`, `logo` and the endpoint for every one of them — while `providerCatalog` held the
 * same fields for the same providers. **Seven of the seven shared providers had two different
 * descriptions**, and the dialog's copy is the one a user reads while pasting a key that will be
 * transmitted to that vendor:
 *
 * ```
 * ollama      catalog: "Private local inference for coding models and offline development."
 *             modal:   "Local models on your machine"
 * openrouter  catalog: "One connection for a broad catalog of hosted models and providers."
 *             modal:   "Many models through one API"
 * ```
 *
 * That duplication had already caused a real incident. The comment on `resolveProviderOption` below
 * records it: a card the dialog did not know about fell back to `providerOptions[0]`, which was
 * OpenAI, so **a key typed for one provider was validated against, and transmitted to, another**. The
 * fix hardened the fallback, which was the right thing to do and left the cause in place. A second copy
 * of a list is not a fallback hazard waiting to happen; it is one.
 *
 * `endpoint` and `defaultEndpoint` are the same field under two names, so the map below is the whole
 * translation. The card's `group` decides eligibility: a web-session or OAuth card is signed into
 * rather than keyed, and this dialog is the wrong tool for it — see `isWebSessionProvider`.
 *
 * **`custom` is eligible.** Writing this filter the first time round left it out, because its group is
 * `custom` and not `api-key` — and `customOption()` reaches for `providerOptions[last]`, so the
 * fallback for an unknown id became **Google**, with Google's endpoint. That is the incident described
 * above, reintroduced by the fix for it: a key typed for an unknown provider would have been
 * transmitted to Google. The group list is now correct, and `customOption` no longer depends on
 * position.
 */
const eligibleGroups = new Set(['api-key', 'local', 'custom']);

export const providerOptions: ProviderOption[] = [
  ...providerCatalog
    .filter((card) => eligibleGroups.has(card.group))
    .map((card) => ({
      id: card.id,
      name: card.name,
      description: card.description,
      auth: card.auth,
      color: card.color,
      initial: card.initial,
      logo: card.logo,
      defaultEndpoint: card.endpoint,
    })),
  ...withoutCard,
];

/**
 * The neutral option. Never a named vendor.
 *
 * Found **by id**, not by position. This was `providerOptions[providerOptions.length - 1]`, which is a
 * bet that the custom entry is last — and when the list above was derived from the catalog and the
 * `custom` card fell out of the filter, the last element became Google. A positional lookup for "the
 * neutral fallback" is a lookup that names a vendor the day the ordering changes, and the whole point
 * of the function is that it never does.
 */
const customOption = (): ProviderOption => {
  const option = providerOptions.find((item) => item.id === 'custom');
  if (!option) throw new Error('AddProviderModal: the neutral "custom" option is missing, so an unknown provider would fall back to a named vendor.');
  return option;
};

/**
 * Whether this modal is the wrong tool for a provider.
 *
 * It collects an API key. A web-session provider has none — it is signed into — so opening
 * this for one asks for a credential the provider does not use, and the saved result is a
 * connection that cannot work. Checked here rather than only at the call site so no other
 * caller can repeat the mistake.
 */
export function isWebSessionProvider(providerId: string | undefined): boolean {
  if (!providerId) return false;
  const card = providerCatalog.find((item) => item.id === providerId);
  return Boolean(card && webSessionProviderIds().includes(card.id));
}

/**
 * Resolves a provider id to an option without ever substituting a different vendor.
 *
 * This used to fall back to `providerOptions[0]`, which is OpenAI. A card the dialog did
 * not know about therefore became OpenAI, with OpenAI's endpoint — so a key typed for one
 * provider was validated against, and transmitted to, another. A key must never be able
 * to reach a vendor the operator did not name, so an unknown id resolves to the catalog
 * card when there is one, and to the neutral custom option otherwise.
 */
export function resolveProviderOption(providerId: string | undefined): ProviderOption {
  const known = providerOptions.find((item) => item.id === providerId);
  if (known) return known;
  const card = providerCatalog.find((item) => item.id === providerId);
  if (!card) return customOption();
  return {
    id: card.id,
    name: card.name,
    description: card.description,
    // The catalog spells keyless auth as "No key", which is what the modal tests for.
    auth: /no key/i.test(card.auth) ? 'No key' : card.auth,
    color: card.color,
    initial: card.initial,
    ...(card.logo ? { logo: card.logo } : {}),
    defaultEndpoint: card.endpoint,
  };
}

export type NewProvider = {
  providerId: string;
  name: string;
  endpoint: string;
  hasKey: boolean;
  priority?: number;
  proxyPool?: string;
  modelPolicy?: 'free' | 'all';
};

type AddMode = 'single' | 'bulk';
type TestState = 'idle' | 'success' | 'error';

type AddProviderModalProps = {
  open: boolean;
  initialProviderId?: string;
  initialModelPolicy?: 'free' | 'all';
  onClose: () => void;
  onSave: (provider: NewProvider, apiKey?: string) => void | Promise<void>;
  onSaveMany?: (providers: NewProvider[]) => void | Promise<void>;
};

export function AddProviderModal({ open, initialProviderId, initialModelPolicy, onClose, onSave, onSaveMany }: AddProviderModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const checkAbortRef = useRef<AbortController | null>(null);
  const [selectedId, setSelectedId] = useState(initialProviderId ?? 'openai');
  const [mode, setMode] = useState<AddMode>('single');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [endpoint, setEndpoint] = useState(resolveProviderOption(initialProviderId).defaultEndpoint ?? '');
  const [priority, setPriority] = useState('1');
  const [proxyPool, setProxyPool] = useState('none');
  const [importFreeModels, setImportFreeModels] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<TestState>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const option = resolveProviderOption(initialProviderId);
    setSelectedId(option.id);
    setMode('single');
    setName('');
    setApiKey('');
    setBulkText('');
    setEndpoint(option.defaultEndpoint ?? '');
    setPriority('1');
    setProxyPool('none');
    setTesting(false);
    setSaving(false);
    setTestState('idle');
    setError('');
  }, [open, initialProviderId]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
      cancelPendingCheck();
      previousFocusRef.current?.focus({ preventScroll: true });
      previousFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setImportFreeModels(initialModelPolicy !== 'all');
  }, [open, initialModelPolicy]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  const selected = resolveProviderOption(selectedId);
  const requiresKey = selected.auth !== 'No key';
  const showsProviderSelect = !initialProviderId;
  const showsEndpoint = selected.id === 'custom' || selected.id === 'ollama';
  const hasSingleConnection = Boolean(name.trim() && (!requiresKey || apiKey.trim()) && (!showsEndpoint || endpoint.trim()));
  const canSave = mode === 'single' ? hasSingleConnection : Boolean(bulkText.trim());
  const title = `Add ${selected.name} ${requiresKey ? 'API Key' : 'Connection'}`;

  /**
   * Abandons an in-flight check.
   *
   * It used to clear a timer as well, because there used to be a timer: the 850 ms wait that reported
   * success without asking anyone. With the real request in place, aborting the controller is the whole
   * job — there is nothing pending locally to cancel, and a ref that only ever held a fake delay is a
   * ref that invites the fake delay back.
   */
  function cancelPendingCheck() {
    const controller = checkAbortRef.current;
    checkAbortRef.current = null;
    controller?.abort();
  }

  function selectProvider(id: string) {
    cancelPendingCheck();
    const option = resolveProviderOption(id);
    setSelectedId(option.id);
    if (option.id === 'openrouter') setMode('single');
    setApiKey('');
    setEndpoint(option.defaultEndpoint ?? '');
    setTestState('idle');
    setError('');
  }

  /**
   * Checks the pasted key against the provider, for real.
   *
   * This used to branch: OpenRouter got a real request to the gateway, and **every other provider got
   * an 850 ms timer whose callback called `setTestState('success')`**. No request was made, nothing was
   * verified, and the dialog reported "Key looks valid" for a key that could have been any string at
   * all. It was a mockup's loading animation that outlived the mockup, and it sat in the one place the
   * product promises a credential was checked.
   *
   * The gateway has served `POST /v1/connections/:providerId/check` for every provider since the
   * duplicated OpenRouter-only route was deleted, so there is a real answer to ask for. The endpoint
   * rides along when the card has one, so a self-hosted or proxied provider is checked against the
   * address it will be saved with.
   *
   * The unreachable `mode === 'bulk'` guards are gone with it. The Check button only renders in single
   * mode, so those branches could not run — and leaving a fake-success path in a function called
   * `testConnection` is precisely the hazard being removed.
   */
  async function testConnection() {
    if (requiresKey && !apiKey.trim()) {
      setError('Add an API key before checking this connection.');
      return;
    }
    setError('');
    setTesting(true);
    setTestState('idle');
    const controller = new AbortController();
    checkAbortRef.current = controller;
    try {
      if (requiresKey) {
        await checkConnectionCredential(selected.id, { apiKey: apiKey.trim(), ...(showsEndpoint && endpoint.trim() ? { endpoint: endpoint.trim() } : {}) }, controller.signal);
        setTestState('success');
      } else {
        // No key to check — a local runtime such as Ollama has no credential to verify, and the
        // button is not rendered for it. Said plainly rather than reported as a pass.
        setTestState('idle');
        setError('This provider needs no key, so there is nothing to check. Save it and the gateway will confirm the address.');
      }
    } catch (testError) {
      if (!controller.signal.aborted) {
        setTestState('error');
        setError(testError instanceof Error ? testError.message : 'The local gateway could not verify this connection.');
      }
    } finally {
      if (checkAbortRef.current === controller) checkAbortRef.current = null;
      setTesting(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setError('');
    setSaving(true);
    try {
      if (mode === 'bulk') {
        if (selected.id === 'openrouter') throw new Error('OpenRouter connections are saved one at a time. Use Single Add for this provider.');
        const entries = bulkText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (entries.length === 0) throw new Error('Add at least one key before saving the batch.');
        const providers = entries.map((entry, index) => {
          const separator = entry.indexOf('|');
          const entryName = separator > 0 ? entry.slice(0, separator).trim() : '';
          return {
            providerId: selected.id,
            name: entryName || name.trim() || `${selected.name} ${index + 1}`,
            endpoint: endpoint.trim(),
            hasKey: true,
            priority: Number(priority) || 1,
            proxyPool,
          };
        });
        if (onSaveMany) await onSaveMany(providers);
        else await onSave(providers[0]);
        return;
      }

      if (!name.trim()) throw new Error('Give this connection a name so you can recognize it later.');
      if (requiresKey && !apiKey.trim()) throw new Error('Add an API key before saving this connection.');
      if (showsEndpoint && !endpoint.trim()) throw new Error('Add the local endpoint before saving this connection.');
      await onSave({
        providerId: selected.id,
        name: name.trim(),
        endpoint: endpoint.trim(),
        hasKey: Boolean(apiKey.trim()),
        priority: Number(priority) || 1,
        proxyPool,
        ...(selected.id === 'openrouter' ? { modelPolicy: importFreeModels ? 'free' as const : 'all' as const } : {}),
        // The key is handed over for any provider that asks for one. It used to
        // be passed for OpenRouter alone, which is why every other provider
        // reached the page with no key and could not be saved at all.
      }, requiresKey ? apiKey : undefined);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'The connection could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  // Keep the fixed overlay at the viewport root; route transitions use transforms.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="add-provider-title" aria-describedby="add-provider-description" className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[430px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl outline-none">
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-1.5" aria-label="Window controls">
            <button type="button" onClick={onClose} aria-label="Close add connection dialog" title="Close" className="h-3.5 w-3.5 rounded-full bg-danger transition-transform hover:scale-110" />
            <span className="h-3.5 w-3.5 rounded-full bg-[#d8a443]" aria-hidden="true" />
            <span className="h-3.5 w-3.5 rounded-full bg-muted/50" aria-hidden="true" />
          </div>
          <h2 id="add-provider-title" className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.01em]">{title}</h2>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="dashboard-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <p id="add-provider-description" className="sr-only">Add a local provider connection and choose its routing settings.</p>
            <div className="mb-5 flex gap-2" role="tablist" aria-label="Connection add mode">
              <button type="button" role="tab" aria-selected={mode === 'single'} onClick={() => { setMode('single'); setTestState('idle'); setError(''); }} className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${mode === 'single' ? 'bg-gold-soft text-gold-text ring-1 ring-gold/30' : 'text-muted hover:bg-bg-soft hover:text-text'}`}>Single</button>
              <button type="button" role="tab" aria-selected={mode === 'bulk'} disabled={selected.id === 'openrouter'} onClick={() => { setMode('bulk'); setTestState('idle'); setError(''); }} className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${mode === 'bulk' ? 'bg-gold-soft text-gold-text ring-1 ring-gold/30' : 'text-muted hover:bg-bg-soft hover:text-text'}`}>Bulk Add</button>
            </div>

            {mode === 'single' ? (
              <>
                {showsProviderSelect && (
                  <label className="mb-4 block">
                    <span className="mb-2 block text-xs font-semibold">Provider</span>
                    <span className="relative block">
                      <select value={selected.id} onChange={(event) => selectProvider(event.target.value)} className="input !h-11 !w-full !appearance-none !rounded-lg !border-line !bg-surface-2 !px-3 !pr-9 !text-sm">
                        {providerOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                      </select>
                      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                    </span>
                  </label>
                )}

                <label className="block">
                  <span className="mb-2 block text-xs font-semibold">Name</span>
                  <input id="connection-name" value={name} onChange={(event) => { setName(event.target.value); setError(''); }} placeholder="Production Key" className="input !h-11 !w-full !rounded-lg !border-line !bg-surface-2 !px-3 !text-sm" />
                </label>

                {requiresKey && (
                  <div className="mt-4">
                    <label className="mb-2 block text-xs font-semibold" htmlFor="connection-api-key">API Key</label>
                    <div className="flex gap-2">
                      <div className="relative min-w-0 flex-1">
                        <LockKeyhole className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                        <input id="connection-api-key" type="password" value={apiKey} onChange={(event) => { cancelPendingCheck(); setApiKey(event.target.value); setTestState('idle'); setError(''); }} placeholder="Paste a provider key" className="input !h-11 !w-full !rounded-lg !border-line !bg-surface-2 !pl-10 !pr-3 !text-sm" autoComplete="off" />
                      </div>
                      <button type="button" onClick={testConnection} disabled={testing || saving || !apiKey.trim()} className="btn-ghost !h-11 !w-[78px] !rounded-lg !px-2 !text-xs disabled:cursor-not-allowed disabled:opacity-45">
                        {testing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                        {testing ? 'Checking' : 'Check'}
                      </button>
                    </div>
                    {testState === 'success' && <p role="status" className="mt-2 flex items-center gap-1.5 text-[11px] text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />Key verified by the local gateway</p>}
                  </div>
                )}

                {selected.id === 'openrouter' && (
                  <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-line bg-bg-soft/55 px-3.5 py-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">Import free models</p>
                      <p className="muted mt-1 text-[11px] leading-relaxed">{importFreeModels ? 'Save will import models with zero prompt and completion pricing.' : 'Save will import all text models available from OpenRouter.'}</p>
                    </div>
                    <button type="button" role="switch" aria-checked={importFreeModels} aria-label="Import free OpenRouter models" disabled={saving || testing} onClick={() => setImportFreeModels((current) => !current)} className={`relative h-6 w-11 shrink-0 rounded-full p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${importFreeModels ? 'bg-[#f0643b]' : 'bg-line-strong'}`}>
                      <span className={`block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${importFreeModels ? 'translate-x-5' : 'translate-x-0'}`} aria-hidden="true" />
                    </button>
                  </div>
                )}

                {showsEndpoint && (
                  <label className="mt-4 block">
                    <span className="mb-2 block text-xs font-semibold">Endpoint</span>
                    <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://localhost:8000/v1" className="input !h-11 !w-full !rounded-lg !border-line !bg-surface-2 !px-3 !font-mono !text-xs" />
                  </label>
                )}

                <div className="mt-4 space-y-4">
                  <div>
                    <label className="mb-2 block text-xs font-semibold" htmlFor="connection-priority">Priority</label>
                    <input id="connection-priority" type="number" min={1} step={1} value={priority} onChange={(event) => setPriority(event.target.value)} className="input !h-11 !w-full !rounded-lg !border-line !bg-surface-2 !px-3 !text-sm" />
                  </div>
                  <div>
                    <label className="mb-2 block text-xs font-semibold" htmlFor="connection-proxy-pool">Proxy Pool</label>
                    <span className="relative block">
                      <select id="connection-proxy-pool" value={proxyPool} onChange={(event) => setProxyPool(event.target.value)} className="input !h-11 !w-full !appearance-none !rounded-lg !border-line !bg-surface-2 !px-3 !pr-9 !text-sm">
                        <option value="none">None</option>
                      </select>
                      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                    </span>
                  </div>
                </div>

                <p className="mt-3 text-[11px] leading-relaxed text-muted">No active proxy pools available. Create one in Proxy Pools first.</p>
                <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold-text" aria-hidden="true" />{requiresKey
                  ? `The key is checked against ${selected.name} through the loopback gateway and stored encrypted on this machine. It never reaches browser storage.`
                  : 'This provider needs no key, so nothing is stored for it.'}</p>
              </>
            ) : (
              <div>
                {showsProviderSelect && (
                  <label className="mb-4 block">
                    <span className="mb-2 block text-xs font-semibold">Provider</span>
                    <span className="relative block">
                      <select value={selected.id} onChange={(event) => selectProvider(event.target.value)} className="input !h-11 !w-full !appearance-none !rounded-lg !border-line !bg-surface-2 !px-3 !pr-9 !text-sm">
                        {providerOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                      </select>
                      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                    </span>
                  </label>
                )}
                <p className="mt-5 text-xs leading-relaxed text-muted">One key per line. Format: <code className="font-mono text-gold-text">name|apiKey</code> or just <code className="font-mono text-gold-text">apiKey</code> (auto-named by index).</p>
                <textarea id="bulk-api-keys" aria-label="API Keys" value={bulkText} onChange={(event) => { setBulkText(event.target.value); setError(''); }} placeholder={'name1|sk-key1\nname2|sk-key2\nsk-key-only-auto-named'} rows={8} className="input !mt-3 !min-h-[160px] !w-full !resize-y !rounded-lg !border-gold/35 !bg-surface-2 !p-3 !font-mono !text-xs focus:!border-gold/70" />
              </div>
            )}
            {error && <p role="alert" className="mt-3 flex items-center gap-1.5 text-[11px] text-danger"><CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{error}</p>}
          </div>

          <div className="flex shrink-0 gap-2 border-t border-line bg-surface px-4 py-3">
            <button type="submit" disabled={!canSave || testing || saving} className="btn-gold !h-10 !flex-1 !rounded-lg !px-3 !text-xs disabled:cursor-not-allowed disabled:opacity-40">{saving ? 'Saving' : mode === 'bulk' ? 'Add All Keys' : 'Save'}</button>
            <button type="button" onClick={onClose} disabled={saving} className="btn-ghost !h-10 !flex-1 !rounded-lg !px-3 !text-xs disabled:cursor-not-allowed disabled:opacity-40">Cancel</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
