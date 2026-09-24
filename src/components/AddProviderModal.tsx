import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, CircleAlert, KeyRound, LoaderCircle, LockKeyhole, Server, X } from 'lucide-react';
import { getProviderLogo } from '../data/providers';
import { ProviderMark } from './ProviderMark';

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
};

export function AddProviderModal({ open, initialProviderId, onClose, onSave }: { open: boolean; initialProviderId?: string; onClose: () => void; onSave: (provider: NewProvider) => void }) {
  const [selectedId, setSelectedId] = useState(initialProviderId ?? 'openai');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState(providerOptions[0].defaultEndpoint ?? '');
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<'idle' | 'success' | 'error'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const option = providerOptions.find((item) => item.id === initialProviderId) ?? providerOptions[0];
    setSelectedId(option.id);
    setName('');
    setApiKey('');
    setEndpoint(option.defaultEndpoint ?? '');
    setTesting(false);
    setTestState('idle');
    setError('');
  }, [open, initialProviderId]);

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

  function selectProvider(id: string) {
    const option = providerOptions.find((item) => item.id === id) ?? providerOptions[0];
    setSelectedId(option.id);
    setEndpoint(option.defaultEndpoint ?? '');
    setTestState('idle');
    setError('');
  }

  function testConnection() {
    if (requiresKey && !apiKey.trim()) {
      setError('Add an API key before testing this connection.');
      return;
    }
    setError('');
    setTesting(true);
    setTestState('idle');
    window.setTimeout(() => {
      setTesting(false);
      setTestState('success');
    }, 850);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError('Give this connection a name so you can recognize it later.');
      return;
    }
    if (requiresKey && !apiKey.trim()) {
      setError('Add an API key before saving this connection.');
      return;
    }
    onSave({ providerId: selected.id, name: name.trim(), endpoint: endpoint.trim(), hasKey: Boolean(apiKey.trim()) });
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 p-0 backdrop-blur-sm sm:items-center sm:p-5" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="add-provider-title" className="dashboard-scroll max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-line bg-bg shadow-2xl sm:rounded-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-bg/95 px-5 py-4 backdrop-blur-xl sm:px-6">
          <div>
            <span className="eyebrow"><span className="eyebrow-dot" aria-hidden="true" />New connection</span>
            <h2 id="add-provider-title" className="mt-3 text-xl font-semibold tracking-tight">Add a provider</h2>
            <p className="muted mt-1 text-xs">Choose a provider and give this route a recognizable name.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close add provider dialog" className="muted grid h-9 w-9 shrink-0 place-items-center rounded-lg hover:bg-bg-soft hover:text-gold-text">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-6 px-5 py-5 sm:px-6 sm:py-6">
          <fieldset>
            <legend className="mono-label mb-3">Provider</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {providerOptions.map((option) => {
                const active = option.id === selected.id;
                return (
                  <button key={option.id} type="button" onClick={() => selectProvider(option.id)} aria-pressed={active} className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${active ? 'border-gold/60 bg-gold-soft' : 'border-line bg-surface hover:border-line-strong'}`}>
                    <ProviderMark logo={option.logo} initial={option.initial} color={option.color} className="h-8 w-8 rounded-lg text-[10px]" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold">{option.name}</span>
                      <span className="muted mt-0.5 block truncate text-[10px]">{option.description}</span>
                    </span>
                    {active && <CheckCircle2 className="h-4 w-4 shrink-0 text-gold-text" aria-label="Selected" />}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mono-label mb-2 block">Connection name</span>
              <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Production OpenAI" className="input" />
            </label>
            <label className="block">
              <span className="mono-label mb-2 block">Authentication</span>
              <div className="flex h-[43px] items-center gap-2 rounded-[10px] border border-line bg-bg-soft px-3 text-xs text-muted">
                {requiresKey ? <KeyRound className="h-3.5 w-3.5 text-gold-text" aria-hidden="true" /> : <Server className="h-3.5 w-3.5 text-gold-text" aria-hidden="true" />}
                {selected.auth}
              </div>
            </label>
          </div>

          {requiresKey && (
            <label className="block">
              <span className="mono-label mb-2 block">API key</span>
              <div className="relative">
                <LockKeyhole className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste a provider key" className="input pl-10" autoComplete="off" />
              </div>
            </label>
          )}

          <label className="block">
            <span className="mono-label mb-2 block">Base URL</span>
            <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.example.com/v1" className="input font-mono !text-xs" />
          </label>

          <div className="flex flex-col gap-3 rounded-xl border border-gold/20 bg-gold-soft/45 p-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2.5">
              <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" aria-hidden="true" />
              <p className="muted text-[11px] leading-relaxed">This UI preview does not send or persist credentials. The real connection flow will hand them to your local gateway.</p>
            </div>
            <button type="button" onClick={testConnection} disabled={testing} className="btn-ghost shrink-0 !px-3 !py-2 !text-xs">
              {testing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Server className="h-3.5 w-3.5" aria-hidden="true" />}
              {testing ? 'Testing' : 'Test connection'}
            </button>
          </div>

          {testState === 'success' && <p role="status" className="flex items-center gap-2 text-xs text-success"><CheckCircle2 className="h-4 w-4" aria-hidden="true" />Connection looks good. Ready to save.</p>}
          {error && <p role="alert" className="flex items-center gap-2 text-xs text-danger"><CircleAlert className="h-4 w-4" aria-hidden="true" />{error}</p>}

          <div className="flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:justify-end">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" className="btn-gold">Save connection <ArrowRight className="h-4 w-4" aria-hidden="true" /></button>
          </div>
        </form>
      </div>
    </div>
  );
}
