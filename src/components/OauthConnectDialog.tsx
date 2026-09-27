import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleAlert, ExternalLink, LoaderCircle, ShieldCheck } from 'lucide-react';
import {
  connectGatewayOauthProvider,
  getClineSignInStatus,
  getDeviceSignInStatus,
  startGatewayDeviceSignIn,
  startGatewayOauthSignIn,
  type GatewayConnection,
  type GatewayOauthSignInStatus,
} from '../lib/gatewayClient';

type Props = {
  providerId: string;
  providerName: string;
  /**
   * A window opened synchronously by the click that started this flow. Browsers
   * only allow that inside a user gesture, so the caller opens a blank tab and
   * this dialog navigates it once the sign-in URL exists.
   */
  signInWindow?: Window | null;
  onConnected: (connection: GatewayConnection) => void | Promise<void>;
  onClose: () => void;
};

type Phase = 'starting' | 'waiting' | 'connected' | 'failed';

/**
 * Providers that sign in with a device code rather than a redirect. The user types a
 * code into the provider's own page and the gateway polls for the result, so there is
 * no authUrl to navigate to and nothing comes back on a callback.
 */
const deviceFlowProviders = new Set(['opencode-console']);

/** How often to ask the gateway whether the browser sign-in finished. */
const pollIntervalMs = 1000;
/** Matches the gateway's own session lifetime. */
const waitTimeoutMs = 5 * 60_000;

/**
 * Signs in to a provider through the browser.
 *
 * The user clicks Add connection, the browser opens on the provider's sign-in
 * page, and this dialog waits. The provider redirects back to the gateway, which
 * exchanges the code and saves the connection on its own, so there is normally
 * nothing to paste. The paste field stays available for the case where the
 * provider does not hand the code to a browser redirect.
 */
export function OauthConnectDialog({ providerId, providerName, signInWindow, onConnected, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [message, setMessage] = useState('Opening the sign-in page…');
  const [error, setError] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [paste, setPaste] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deviceCode, setDeviceCode] = useState<{ userCode: string; verificationUrl: string } | null>(null);
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const pollRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const missedPollsRef = useRef(0);
  const signInWindowRef = useRef<Window | null>(signInWindow ?? null);
  const settledRef = useRef(false);

  useEffect(() => {
    signInWindowRef.current = signInWindow ?? null;
  }, [signInWindow]);

  useEffect(() => {
    setPortalNode(document.body);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const stopWaiting = useCallback(() => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    pollRef.current = null;
    timeoutRef.current = null;
  }, []);

  useEffect(() => stopWaiting, [stopWaiting]);

  // Point the already-open tab at the provider. Opening a second window here
  // would be blocked, because this runs after the click that granted the gesture.
  const navigateTo = useCallback((authUrl: string) => {
    const opened = signInWindowRef.current;
    if (opened && !opened.closed) {
      opened.location.href = authUrl;
      signInWindowRef.current = null;
      return true;
    }
    return false;
  }, []);

  /** Applies a poll result. Shared by both flows so they cannot drift apart. */
  const finish = useCallback((status: GatewayOauthSignInStatus) => {
    if (settledRef.current) return;
    missedPollsRef.current = 0;
    if (status.status === 'pending') return;
    settledRef.current = true;
    stopWaiting();
    if (status.status === 'connected' && status.connection) {
      setPhase('connected');
      const count = status.connection.modelIds.length;
      setMessage(count > 0
        ? `Connected to ${status.connection.name} with ${count} models.`
        : `Connected to ${status.connection.name}. The model list is still loading.`);
      // No cast: the status carries a whole connection record, and a trimmed one
      // would leave `resilience` undefined and crash the page.
      void onConnected(status.connection);
      // A tolerated discovery failure arrives as a note alongside a success, and it is
      // the only place the reason will be seen, so it is kept on screen.
      if (status.error) {
        setError(status.error);
        return;
      }
      window.setTimeout(onClose, 1200);
      return;
    }
    setPhase('failed');
    setError(status.error ?? (status.status === 'expired'
      ? 'The sign-in expired. Start again.'
      : 'The sign-in did not complete.'));
  }, [onClose, onConnected, stopWaiting]);

  /** Waits for a session, reporting a dead gateway rather than sitting out the timeout. */
  const watch = useCallback((sessionId: string, poll: (id: string) => Promise<GatewayOauthSignInStatus>, timeoutMessage: string) => {
    stopWaiting();
    timeoutRef.current = window.setTimeout(() => {
      settledRef.current = true;
      stopWaiting();
      setPhase('failed');
      setError(timeoutMessage);
    }, waitTimeoutMs);

    pollRef.current = window.setInterval(() => {
      void poll(sessionId).then((status) => {
        if (settledRef.current) return;
        finish(status);
      }).catch((pollError: unknown) => {
        // A single dropped poll is not a failed sign-in, so the next tick tries again.
        // Several in a row means the gateway is gone, and saying so beats leaving the
        // dialog waiting out its full timeout.
        missedPollsRef.current += 1;
        if (missedPollsRef.current < 3) return;
        settledRef.current = true;
        stopWaiting();
        setPhase('failed');
        setError(pollError instanceof Error ? pollError.message : 'The local gateway stopped responding.');
      });
    }, pollIntervalMs);
  }, [finish, stopWaiting]);

  const begin = useCallback(async () => {
    setPhase('starting');
    setMessage('Opening the sign-in page…');
    setError('');
    missedPollsRef.current = 0;

    if (deviceFlowProviders.has(providerId)) {
      try {
        const signIn = await startGatewayDeviceSignIn();
        if (settledRef.current) return;
        // The code has to be read by a person, so it is shown here as well as sent
        // to the browser tab.
        setDeviceCode({ userCode: signIn.userCode, verificationUrl: signIn.verificationUrl });
        const sentToOpenTab = navigateTo(signIn.verificationUrl);
        setPhase('waiting');
        setMessage(sentToOpenTab
          ? 'Approve the request in your browser using the code below. This tab will finish the connection.'
          : 'Your browser blocked the sign-in tab. Open the link below to approve.');
        watch(signIn.sessionId, getDeviceSignInStatus, 'The sign-in timed out. Start again from OmniHilbras.');
      } catch (startError) {
        settledRef.current = true;
        setPhase('failed');
        setError(startError instanceof Error ? startError.message : 'The sign-in could not be started.');
      }
      return;
    }

    try {
      const signIn = await startGatewayOauthSignIn(providerId);
      if (settledRef.current) return;
      const sentToOpenTab = navigateTo(signIn.authUrl);
      setPhase('waiting');
      setMessage(sentToOpenTab
        ? `Approve the request in your browser. This tab will finish the connection.`
        : 'Your browser blocked the sign-in tab. Open the link below to continue.');
      watch(signIn.sessionId, getClineSignInStatus, 'The sign-in timed out. Start again, or paste the code if your browser did not return here.');
    } catch (startError) {
      settledRef.current = true;
      setPhase('failed');
      setError(startError instanceof Error ? startError.message : 'The sign-in could not be started.');
    }
  }, [navigateTo, providerId, watch]);

  useEffect(() => {
    void begin();
  }, [begin]);

  async function submitPastedCode() {
    const value = paste.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const connection = await connectGatewayOauthProvider(providerId, { code: value });
      settledRef.current = true;
      stopWaiting();
      setPhase('connected');
      setMessage(`Connected to ${connection.name} with ${connection.modelIds.length} models.`);
      await onConnected(connection);
      onClose();
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'The sign-in could not be completed.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!portalNode) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={`Connect ${providerName}`} className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[480px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-1.5" aria-label="Window controls">
            <button type="button" onClick={onClose} aria-label="Close dialog" title="Close" className="h-3.5 w-3.5 rounded-full bg-danger transition-transform hover:scale-110" />
            <button type="button" onClick={onClose} aria-label="Minimize" title="Minimize" className="h-3.5 w-3.5 rounded-full bg-gold transition-transform hover:scale-110" />
            <button type="button" onClick={onClose} aria-label="Maximize" title="Maximize" className="h-3.5 w-3.5 rounded-full bg-success transition-transform hover:scale-110" />
          </div>
          <h2 className="text-sm font-semibold">Connect {providerName}</h2>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border ${phase === 'failed' ? 'border-danger/30 bg-danger/10 text-danger' : phase === 'connected' ? 'border-success/30 bg-success/10 text-success' : 'border-line bg-bg-soft text-gold-text'}`}>
              {phase === 'failed' ? <CircleAlert className="h-4 w-4" /> : phase === 'connected' ? <Check className="h-4 w-4" /> : <LoaderCircle className="h-4 w-4 animate-spin" />}
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold" role="status" aria-live="polite">
                {phase === 'connected' ? 'Connected' : phase === 'failed' ? 'Sign-in did not finish' : 'Waiting for the browser'}
              </p>
              <p className="muted mt-1 text-[11px] leading-relaxed">{error || message}</p>
            </div>
          </div>

          {deviceCode && phase !== 'connected' && (
            <div className="mt-4 rounded-xl border border-gold/25 bg-gold-soft p-3">
              <p className="text-[11px] font-semibold text-gold-text">Approve this code at OpenCode</p>
              <p className="mt-1 select-all font-mono text-lg tracking-[0.18em] text-text">{deviceCode.userCode}</p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                The code is filled in for you. If OpenCode asks you to log in first, sign in there and it will
                bring you back to this approval.
              </p>
              <a href={deviceCode.verificationUrl} target="_blank" rel="noreferrer" className="btn-ghost mt-2 inline-flex !h-7 !px-2.5 !text-[11px]">
                Open the code page
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </div>
          )}

          {phase === 'waiting' && (
            <div className="mt-4 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-bg-soft" role="progressbar" aria-label="Waiting for the sign-in to complete">
                <div className="h-full w-1/3 animate-[pulse_1.4s_ease-in-out_infinite] rounded-full bg-gold" />
              </div>
            </div>
          )}

          {(phase === 'starting' || phase === 'waiting') && !showPaste && !deviceFlowProviders.has(providerId) && (
            <button type="button" onClick={() => setShowPaste(true)} className="btn-ghost mt-4 !h-8 !px-2.5 !text-[11px]">
              Open the sign-in page manually
            </button>
          )}

          {showPaste && phase !== 'connected' && (
            <div className="mt-4 rounded-lg border border-line bg-bg-soft/55 p-3">
              <p className="text-[11px] font-semibold">Paste the code instead</p>
              <p className="muted mt-1 text-[11px] leading-relaxed">Only needed if your browser did not return to OmniHilbras. Paste the callback URL, a <code className="font-mono">code#state</code> pair, or a bare code.</p>
              <input
                value={paste}
                onChange={(event) => { setPaste(event.target.value); setError(''); }}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void submitPastedCode(); } }}
                placeholder="http://127.0.0.1:8787/v1/oauth/cline/callback?code=…"
                aria-label="Callback URL or authorization code"
                className="input mt-2 !h-10 !w-full !rounded-lg !border !border-line !bg-surface-2 !px-3 !font-mono !text-[11px]"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={() => void submitPastedCode()} disabled={submitting || !paste.trim()} className="btn-gold !h-9 !px-3 !text-[11px] disabled:opacity-40">
                  {submitting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                  {submitting ? 'Connecting' : 'Connect'}
                </button>
                <button type="button" onClick={() => { setShowPaste(false); setPaste(''); }} className="btn-ghost !h-9 !px-3 !text-[11px]">Back</button>
              </div>
            </div>
          )}

          <p className="muted mt-4 flex items-start gap-2 text-[11px] leading-relaxed">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold-text" aria-hidden="true" />
            The gateway completes the exchange on its own loopback address, checks the token against {providerName}, and stores it encrypted in the local vault. It never reaches browser storage.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
          {phase === 'failed' && !showPaste && (
            <button type="button" onClick={() => { settledRef.current = false; setShowPaste(true); }} className="btn-ghost !h-10 !px-3 !text-xs">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Paste a code
            </button>
          )}
          <button type="button" onClick={onClose} className="btn-gold !h-10 !flex-1 !rounded-lg !px-3 !text-xs">
            {phase === 'connected' ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>,
    portalNode,
  );
}
