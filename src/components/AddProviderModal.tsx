import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCircle2, ChevronDown, CircleAlert, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react';
import { getProviderLogo } from '../data/providers';

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

export const providerOptions: ProviderOption[] = [
  { id: 'openai', name: 'OpenAI', description: 'GPT and Responses APIs', auth: 'API key', color: '#6fdb9b', initial: 'O', logo: getProviderLogo('openai'), defaultEndpoint: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', description: 'Claude models', auth: 'API key', color: '#d97757', initial: 'A', logo: getProviderLogo('anthropic'), defaultEndpoint: 'https://api.anthropic.com/v1' },
  { id: 'google', name: 'Google', description: 'Gemini models', auth: 'API key', color: '#83b7ff', initial: 'G', logo: getProviderLogo('google'), defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'ollama', name: 'Ollama', description: 'Local models on your machine', auth: 'No key', color: '#e2bd52', initial: 'L', logo: getProviderLogo('ollama'), defaultEndpoint: 'http://localhost:11434/v1' },
  { id: 'mistral', name: 'Mistral', description: 'Efficient hosted models', auth: 'API key', color: '#f97316', initial: 'M', logo: getProviderLogo('mistral'), defaultEndpoint: 'https://api.mistral.ai/v1' },
  { id: 'openrouter', name: 'OpenRouter', description: 'Many models through one API', auth: 'API key', color: '#b995e8', initial: 'R', logo: getProviderLogo('openrouter'), defaultEndpoint: 'https://openrouter.ai/api/v1' },
  { id: 'custom', name: 'Custom endpoint', description: 'Any OpenAI-compatible server', auth: 'API key', color: '#9c9584', initial: 'C', defaultEndpoint: 'http://localhost:8000/v1' },
];

export type NewProvider = {
  providerId: string;
  name: string;
  endpoint: string;
  hasKey: boolean;
  priority?: number;
  proxyPool?: string;
};

type AddMode = 'single' | 'bulk';
type TestState = 'idle' | 'success' | 'error';

type AddProviderModalProps = {
  open: boolean;
  initialProviderId?: string;
  onClose: () => void;
  onSave: (provider: NewProvider) => void;
  onSaveMany?: (providers: NewProvider[]) => void;
};

export function AddProviderModal({ open, initialProviderId, onClose, onSave, onSaveMany }: AddProviderModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const testTimerRef = useRef<number | null>(null);
  const [selectedId, setSelectedId] = useState(initialProviderId ?? 'openai');
  const [mode, setMode] = useState<AddMode>('single');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [endpoint, setEndpoint] = useState(providerOptions[0].defaultEndpoint ?? '');
  const [priority, setPriority] = useState('1');
  const [proxyPool, setProxyPool] = useState('none');
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<TestState>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const option = providerOptions.find((item) => item.id === initialProviderId) ?? providerOptions[0];
    setSelectedId(option.id);
    setMode('single');
    setName('');
    setApiKey('');
    setBulkText('');
    setEndpoint(option.defaultEndpoint ?? '');
    setPriority('1');
    setProxyPool('none');
    setTesting(false);
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
      if (testTimerRef.current !== null) window.clearTimeout(testTimerRef.current);
      testTimerRef.current = null;
      previousFocusRef.current?.focus({ preventScroll: true });
      previousFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  const selected = providerOptions.find((item) => item.id === selectedId) ?? providerOptions[0];
  const requiresKey = selected.auth !== 'No key';
  const showsProviderSelect = !initialProviderId;
  const showsEndpoint = selected.id === 'custom' || selected.id === 'ollama';
  const hasSingleConnection = Boolean(name.trim() && (!requiresKey || apiKey.trim()) && (!showsEndpoint || endpoint.trim()));
  const canSave = mode === 'single' ? hasSingleConnection : Boolean(bulkText.trim());
  const title = `Add ${selected.name} ${requiresKey ? 'API Key' : 'Connection'}`;

  function selectProvider(id: string) {
    const option = providerOptions.find((item) => item.id === id) ?? providerOptions[0];
    setSelectedId(option.id);
    setEndpoint(option.defaultEndpoint ?? '');
    setTestState('idle');
    setError('');
  }

  function testConnection() {
    if (mode === 'single' && requiresKey && !apiKey.trim()) {
      setError('Add an API key before checking this connection.');
      return;
    }
    if (mode === 'bulk' && !bulkText.trim()) {
      setError('Add at least one key before checking the batch.');
      return;
    }
    setError('');
    setTesting(true);
    setTestState('idle');
    testTimerRef.current = window.setTimeout(() => {
      testTimerRef.current = null;
      setTesting(false);
      setTestState('success');
    }, 850);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === 'bulk') {
      const entries = bulkText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (entries.length === 0) {
        setError('Add at least one key before saving the batch.');
        return;
      }
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
      if (onSaveMany) onSaveMany(providers);
      else onSave(providers[0]);
      return;
    }

    if (!name.trim()) {
      setError('Give this connection a name so you can recognize it later.');
      return;
    }
    if (requiresKey && !apiKey.trim()) {
      setError('Add an API key before saving this connection.');
      return;
    }
    if (showsEndpoint && !endpoint.trim()) {
      setError('Add the local endpoint before saving this connection.');
      return;
    }
    onSave({
      providerId: selected.id,
      name: name.trim(),
      endpoint: endpoint.trim(),
      hasKey: Boolean(apiKey.trim()),
      priority: Number(priority) || 1,
      proxyPool,
    });
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
              <button type="button" role="tab" aria-selected={mode === 'bulk'} onClick={() => { setMode('bulk'); setTestState('idle'); setError(''); }} className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${mode === 'bulk' ? 'bg-gold-soft text-gold-text ring-1 ring-gold/30' : 'text-muted hover:bg-bg-soft hover:text-text'}`}>Bulk Add</button>
            </div>

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

            {mode === 'single' ? (
              <>
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
                        <input id="connection-api-key" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setTestState('idle'); setError(''); }} placeholder="Paste a provider key" className="input !h-11 !w-full !rounded-lg !border-line !bg-surface-2 !pl-10 !pr-3 !text-sm" autoComplete="off" />
                      </div>
                      <button type="button" onClick={testConnection} disabled={testing || !apiKey.trim()} className="btn-ghost !h-11 !w-[78px] !rounded-lg !px-2 !text-xs disabled:cursor-not-allowed disabled:opacity-45">
                        {testing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                        {testing ? 'Checking' : 'Check'}
                      </button>
                    </div>
                    {testState === 'success' && <p role="status" className="mt-2 flex items-center gap-1.5 text-[11px] text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />Key looks valid</p>}
                  </div>
                )}

                {showsEndpoint && (
                  <label className="mt-4 block">
                    <span className="mb-2 block text-xs font-semibold">Endpoint</span>
                    <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://localhost:8000/v1" className="input !h-11 !w-full !rounded-lg !border-line !bg-surface-2 !px-3 !font-mono !text-xs" />
                  </label>
                )}
              </>
            ) : (
              <div>
                <label className="mb-2 block text-xs font-semibold" htmlFor="bulk-api-keys">API Keys</label>
                <textarea id="bulk-api-keys" value={bulkText} onChange={(event) => { setBulkText(event.target.value); setError(''); }} placeholder={'name1|sk-key1\nname2|sk-key2\nsk-key-only-auto-named'} rows={6} className="input !w-full !resize-y !rounded-lg !border-line !bg-surface-2 !p-3 !font-mono !text-xs" />
                <p className="mt-2 text-[11px] leading-relaxed text-muted">One connection per line. Use <code className="font-mono text-gold-text">name|key</code> or paste a key to auto-name it.</p>
                <button type="button" onClick={testConnection} disabled={testing || !bulkText.trim()} className="btn-ghost mt-3 !h-9 !rounded-lg !px-3 !text-xs disabled:cursor-not-allowed disabled:opacity-45">{testing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}{testing ? 'Checking' : 'Check batch'}</button>
              </div>
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
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold-text" aria-hidden="true" />Preview mode: keys are not sent or persisted until local credential storage is connected.</p>
            {error && <p role="alert" className="mt-3 flex items-center gap-1.5 text-[11px] text-danger"><CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{error}</p>}
          </div>

          <div className="flex shrink-0 gap-2 border-t border-line bg-surface px-4 py-3">
            <button type="submit" disabled={!canSave || testing} className="btn-gold !h-10 !flex-1 !rounded-lg !px-3 !text-xs disabled:cursor-not-allowed disabled:opacity-40">{mode === 'bulk' ? 'Add all' : 'Save'}</button>
            <button type="button" onClick={onClose} className="btn-ghost !h-10 !flex-1 !rounded-lg !px-3 !text-xs">Cancel</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
