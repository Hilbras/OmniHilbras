import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Copy, ExternalLink, LoaderCircle, ShieldCheck } from 'lucide-react';
import { connectGatewayOauthProvider, getGatewayOauthAuthorization, type GatewayConnection } from '../lib/gatewayClient';

type Props = {
  providerId: string;
  providerName: string;
  onConnected: (connection: GatewayConnection) => void | Promise<void>;
  onClose: () => void;
};

/**
 * Authorization-code flow for a provider that signs in through the browser.
 * Cline redirects to a loopback address the gateway cannot receive, so the user
 * signs in, then pastes what the browser ended up with. The gateway exchanges
 * it and proves the token before anything is stored.
 */
export function OauthConnectDialog({ providerId, providerName, onConnected, onClose }: Props) {
  const [authUrl, setAuthUrl] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [paste, setPaste] = useState('');
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void getGatewayOauthAuthorization(providerId, controller.signal)
      .then((result) => {
        setAuthUrl(result.authUrl);
        setRedirectUri(result.redirectUri);
        setError('');
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setError(requestError instanceof Error ? requestError.message : 'The sign-in URL could not be created.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [providerId]);

  useEffect(() => {
    if (!loading && authUrl) inputRef.current?.focus();
  }, [authUrl, loading]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function connect() {
    const value = paste.trim();
    if (!value || connecting) return;
    setConnecting(true);
    setError('');
    try {
      const connection = await connectGatewayOauthProvider(providerId, { code: value, ...(redirectUri ? { redirectUri } : {}) });
      await onConnected(connection);
      onClose();
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'The sign-in could not be completed.');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={`Connect ${providerName}`} className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[520px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-1.5" aria-label="Window controls">
            <button type="button" onClick={onClose} aria-label="Close dialog" title="Close" className="h-3.5 w-3.5 rounded-full bg-danger transition-transform hover:scale-110" />
            <button type="button" onClick={onClose} aria-label="Minimize" title="Minimize" className="h-3.5 w-3.5 rounded-full bg-gold transition-transform hover:scale-110" />
            <button type="button" onClick={onClose} aria-label="Maximize" title="Maximize" className="h-3.5 w-3.5 rounded-full bg-success transition-transform hover:scale-110" />
          </div>
          <h2 className="text-sm font-semibold">Connect {providerName}</h2>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <ol className="space-y-5">
            <li>
              <p className="text-xs font-semibold">Step 1: Open this URL in your browser</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-[11px] text-text">
                  {loading ? 'Building the sign-in URL…' : authUrl || 'The sign-in URL is unavailable.'}
                </code>
                <button
                  type="button"
                  onClick={() => { void navigator.clipboard?.writeText(authUrl); setCopied(true); }}
                  disabled={!authUrl}
                  aria-label="Copy sign-in URL"
                  className="btn-ghost !h-9 !shrink-0 !px-2.5 !text-[11px] disabled:opacity-50"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                {authUrl && (
                  <a href={authUrl} target="_blank" rel="noreferrer noopener" className="btn-ghost !h-9 !shrink-0 !px-2.5 !text-[11px]">
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    Open
                  </a>
                )}
              </div>
              <p className="muted mt-2 text-[11px] leading-relaxed">The browser will finish at <code className="font-mono">{redirectUri || 'a loopback address'}</code>. Nothing is stored until you paste the result.</p>
            </li>

            <li>
              <p className="text-xs font-semibold">Step 2: Paste the callback URL or authorization code</p>
              <p className="muted mt-1 text-[11px] leading-relaxed">Paste the full callback URL from the address bar. An authorization code on its own also works.</p>
              <input
                ref={inputRef}
                value={paste}
                onChange={(event) => { setPaste(event.target.value); setError(''); }}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void connect(); } }}
                placeholder="http://127.0.0.1:8787/v1/oauth/cline/callback?code=…"
                aria-label="Callback URL or authorization code"
                className="input mt-2 !h-10 !w-full !rounded-lg !border !border-line !bg-surface-2 !px-3 !font-mono !text-[11px]"
                autoComplete="off"
                spellCheck={false}
              />
            </li>
          </ol>

          {error && (
            <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[11px] text-danger">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}

          <p className="muted mt-4 flex items-start gap-2 text-[11px] leading-relaxed">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold-text" aria-hidden="true" />
            The token is checked against {providerName} and stored encrypted in the local vault. It never reaches browser storage.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
          <button type="button" onClick={() => void connect()} disabled={connecting || loading || !paste.trim()} className="btn-gold !h-10 !flex-1 !rounded-lg !px-3 !text-xs disabled:cursor-not-allowed disabled:opacity-40">
            {connecting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
            {connecting ? 'Connecting' : 'Connect'}
          </button>
          <button type="button" onClick={onClose} className="btn-ghost !h-10 !px-4 !text-xs">Cancel</button>
        </div>
      </div>
    </div>
  );
}
