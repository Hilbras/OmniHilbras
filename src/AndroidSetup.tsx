import { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { SecureStore } from './lib/secureStore';

type Props = { onPaired: () => void };

function allowed(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
    return (loopback && ['http:', 'https:'].includes(url.protocol)) || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * First-run pairing for the Android shell. The gateway URL and device API key are written to Android
 * Keystore before the dashboard is imported, so the gateway client sees the runtime configuration at
 * module initialization.
 */
export function AndroidSetup({ onPaired }: Props) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const baseUrl = url.trim().replace(/\/$/, '');
    if (!allowed(baseUrl)) {
      setError('Use https:// for a remote gateway, or http:// only for localhost/adb reverse.');
      return;
    }
    if (!token.trim()) {
      setError('Paste the device API key created by the desktop dashboard.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await SecureStore.set({ key: 'gateway', value: JSON.stringify({ baseUrl, token: token.trim() }) });
      (globalThis as { __OMNIHILBRAS_GATEWAY_URL__?: string }).__OMNIHILBRAS_GATEWAY_URL__ = baseUrl;
      (globalThis as { __OMNIHILBRAS_GATEWAY_TOKEN__?: string }).__OMNIHILBRAS_GATEWAY_TOKEN__ = token.trim();
      onPaired();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The device credential could not be stored.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-enter flex min-h-screen items-center justify-center bg-bg px-5 py-10">
      <div className="w-full max-w-md">
        <p className="mono-label text-gold-text">Android companion</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em]">Connect to your gateway.</h1>
        <p className="muted mt-2 text-sm leading-relaxed">The gateway stays on your computer. Use its HTTPS URL through a private tunnel, or a loopback URL with <code className="font-mono">adb reverse</code>.</p>
        <div className="card mt-6 space-y-4 p-5">
          <label className="block"><span className="mono-label mb-1.5 block">Gateway URL</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://omnihilbras.example.ts.net" className="input font-mono !text-xs" autoCapitalize="none" autoCorrect="off" /></label>
          <label className="block"><span className="mono-label mb-1.5 block">Device API key</span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Create one in the desktop API keys page" className="input font-mono !text-xs" autoCapitalize="none" autoCorrect="off" /></label>
          {error && <p className="text-xs text-danger" role="alert">{error}</p>}
          <button type="button" onClick={() => void save()} disabled={saving} className="btn-gold w-full">{saving ? 'Saving…' : 'Pair this device'}</button>
          <p className="muted text-[11px] leading-relaxed">The key is encrypted with Android Keystore. Provider credentials are never copied to this device.</p>
        </div>
        {Capacitor.getPlatform() === 'web' && <p className="muted mt-4 text-[11px]">This setup screen is shown only in the native shell.</p>}
      </div>
    </div>
  );
}
