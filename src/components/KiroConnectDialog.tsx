import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Building2, Check, CircleAlert, ExternalLink, GitBranch, KeyRound, LoaderCircle, LogIn, ShieldCheck, Upload } from 'lucide-react';
import {
  KIRO_METHODS,
  connectKiroApiKey,
  getKiroSignInStatus,
  importKiroRefreshToken,
  kiroMethod,
  startKiroDeviceSignIn,
  startKiroSocialDeviceSignIn,
  type KiroAuthMethod,
} from '../lib/kiroAuth';
import type { GatewayConnection } from '../lib/gatewayClient';

/**
 * Connecting to Kiro.
 *
 * Kiro offers six ways in and they are not variations on one thing: two are AWS device
 * flows, two are social logins on a different host with a callback a browser cannot
 * follow, and two are credentials the user already holds. So the dialog asks first, and
 * each method then does only what is true of it.
 *
 * A provider whose terms prohibit third-party proxy use carries a standing warning, and
 * that warning gates every method — nothing is sent to Kiro or to AWS until it is
 * acknowledged. That gate applies to all six, not just the first, because a method reached
 * by scrolling past a checkbox is still a method.
 */

type Phase = 'choose' | 'running' | 'waiting' | 'connected' | 'failed';

type Props = {
  providerName: string;
  riskNotice?: string;
  /**
   * The tab the "Add connection" click already opened.
   *
   * That click is what grants the popup gesture, so the provider's page has to be pointed
   * at this window from inside the dialog's async work. Opening a second window from there
   * is blocked, and leaving this one on `about:blank` is what made the sign-in look like
   * it had done nothing.
   */
  signInWindow?: Window | null;
  onConnected: (connection: GatewayConnection) => void | Promise<void>;
  onClose: () => void;
};

const methodIcons = {
  'builder-id': ShieldCheck,
  organization: Building2,
  google: LogIn,
  github: GitBranch,
  'import-token': Upload,
  'api-key': KeyRound,
} as const;

const pollIntervalMs = 1000;
/** Matches the gateway's own session lifetime. */
const waitTimeoutMs = 5 * 60_000;

export function KiroConnectDialog({ providerName, riskNotice, signInWindow, onConnected, onClose }: Props) {
  const [method, setMethod] = useState<KiroAuthMethod | null>(null);
  const [phase, setPhase] = useState<Phase>('choose');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [startUrl, setStartUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [deviceCode, setDeviceCode] = useState<{ userCode: string; verificationUrl: string } | null>(null);
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const pollRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const settledRef = useRef(false);
  const signInWindowRef = useRef<Window | null>(signInWindow ?? null);

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

  /**
   * Points the already-open tab at the provider.
   *
   * Returns whether it went, because "your browser blocked the tab" and "here is the link"
   * are different situations and the user needs to be told which one they are in.
   */
  const navigateTo = useCallback((authUrl: string) => {
    const opened = signInWindowRef.current;
    if (opened && !opened.closed) {
      opened.location.href = authUrl;
      // One-shot: a retry should not silently re-navigate a tab the user has since used.
      signInWindowRef.current = null;
      return true;
    }
    return false;
  }, []);

  /**
   * Opens the sign-in tab.
   *
   * Called synchronously from the click that chose a method, because that click is the
   * gesture a popup needs. Opening it any later — after awaiting the device code — is
   * blocked, and opening it on "Add connection" instead leaves a blank tab sitting there
   * through the method chooser, which is what made this look like nothing happened.
   */
  const openSignInTab = useCallback(() => {
    const opened = signInWindowRef.current;
    if (opened && !opened.closed) return true;
    const created = window.open('about:blank', '_blank');
    signInWindowRef.current = created ?? null;
    return Boolean(created);
  }, []);

  const stopWaiting = useCallback(() => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    pollRef.current = null;
    timeoutRef.current = null;
  }, []);

  useEffect(() => stopWaiting, [stopWaiting]);

  const finish = useCallback(
    async (connection: GatewayConnection) => {
      settledRef.current = true;
      stopWaiting();
      setPhase('connected');
      setMessage(`Connected to ${connection.name} with ${connection.modelIds.length} models.`);
      await onConnected(connection);
      onClose();
    },
    [onConnected, onClose, stopWaiting],
  );

  const fail = useCallback((reason: string) => {
    settledRef.current = true;
    stopWaiting();
    setPhase('failed');
    setError(reason);
  }, [stopWaiting]);

  /** Polls the gateway until the browser approval lands, then saves the connection. */
  const watchDeviceSession = useCallback(
    (sessionId: string) => {
      timeoutRef.current = window.setTimeout(() => {
        fail('The sign-in timed out. Start again from OmniHilbras.');
      }, waitTimeoutMs);
      pollRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const status = await getKiroSignInStatus(sessionId);
            if (settledRef.current) return;
            if (status.status === 'connected' && status.connection) {
              await finish(status.connection);
              return;
            }
            if (status.status === 'failed' || status.status === 'expired') {
              fail(status.error ?? 'The sign-in did not finish. Start again from OmniHilbras.');
            }
          } catch (pollError) {
            // A single failed poll is not a failed sign-in; the browser approval may
            // simply not have happened yet.
            if (settledRef.current) return;
            if (pollError instanceof Error && /not found|404/i.test(pollError.message)) {
              fail('That sign-in session is no longer known. Start again from OmniHilbras.');
            }
          }
        })();
      }, pollIntervalMs);
    },
    [fail, finish],
  );

  const runDeviceFlow = useCallback(
    async (url?: string) => {
      setPhase('running');
      setError('');
      try {
        const signIn = await startKiroDeviceSignIn(url);
        if (settledRef.current) return;
        setDeviceCode({ userCode: signIn.userCode, verificationUrl: signIn.verificationUrl });
        const sentToOpenTab = navigateTo(signIn.verificationUrl);
        setMessage(
          sentToOpenTab
            ? 'Approve the request in the tab that just opened, using the code below. This tab will finish the connection.'
            : 'Your browser blocked the sign-in tab. Open the link below to approve.',
        );
        watchDeviceSession(signIn.sessionId);
      } catch (startError) {
        fail(startError instanceof Error ? startError.message : 'The sign-in could not be started.');
      }
    },
    [fail, navigateTo, watchDeviceSession],
  );

  /**
   * Google and GitHub use Kiro's device flow, the same one OmniRoute uses. The gateway starts it and the
   * user approves the code on Kiro's page, so nothing has to be pasted back: this shows the code and
   * waits on the same session as Builder ID.
   */
  const runSocialFlow = useCallback(
    async (provider: 'google' | 'github') => {
      setPhase('running');
      setError('');
      try {
        const signIn = await startKiroSocialDeviceSignIn(provider);
        if (settledRef.current) return;
        setDeviceCode({ userCode: signIn.userCode, verificationUrl: signIn.verificationUrl });
        const sentToOpenTab = navigateTo(signIn.verificationUrl);
        setMessage(
          sentToOpenTab
            ? 'Approve the request in the tab that just opened, using the code below. This tab will finish the connection.'
            : 'Your browser blocked the sign-in tab. Open the link below to approve.',
        );
        watchDeviceSession(signIn.sessionId);
      } catch (startError) {
        fail(startError instanceof Error ? startError.message : 'The sign-in could not be started.');
      }
    },
    [fail, navigateTo, watchDeviceSession],
  );

  const submitSecret = useCallback(async () => {
    if (!method) return;
    setPhase('running');
    setError('');
    try {
      const trimmed = secret.trim();
      const result =
        method === 'import-token'
          ? await importKiroRefreshToken(trimmed)
          : await connectKiroApiKey(trimmed);
      await finish(result.connection);
    } catch (submitError) {
      // The pasted value is cleared on failure: leaving a secret in a field next to an
      // error is how it ends up in a screenshot.
      setSecret('');
      setPhase('choose');
      setError(submitError instanceof Error ? submitError.message : 'That credential could not be connected.');
    }
  }, [finish, method, secret]);

  const reset = useCallback(() => {
    stopWaiting();
    settledRef.current = false;
    setPhase('choose');
    setError('');
    setMessage('');
    setDeviceCode(null);
    setStartUrl('');
    setSecret('');
  }, [stopWaiting]);

  if (!portalNode) return null;

  const chosen = method ? kiroMethod(method) : null;
  const onChooser = phase === 'choose' || phase === 'failed';
  // A method's own panel stays up while that method works. Falling back to the chooser
  // mid-request would show a list of options while a request is already in flight.
  const showingMethod = Boolean(method) && phase !== 'connected';

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Connect ${providerName}`}
        className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[480px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-1.5" aria-label="Window controls">
            <button type="button" onClick={onClose} aria-label="Close dialog" title="Close" className="h-3.5 w-3.5 rounded-full bg-danger transition-transform hover:scale-110" />
            <button type="button" onClick={onClose} aria-label="Minimize" title="Minimize" className="h-3.5 w-3.5 rounded-full bg-gold transition-transform hover:scale-110" />
            <button type="button" onClick={onClose} aria-label="Maximize" title="Maximize" className="h-3.5 w-3.5 rounded-full bg-success transition-transform hover:scale-110" />
          </div>
          <h2 className="text-sm font-semibold">Connect {providerName}</h2>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {riskNotice && (
            <div className="mb-4 rounded-xl border border-[#ff6b35]/30 bg-[#ff6b35]/10 p-3">
              <p className="flex items-start gap-1.5 text-[11px] font-semibold text-[#ff6b35]">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Read this before connecting
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-[#ff6b35]">{riskNotice}</p>
              <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-muted">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#ff6b35]"
                />
                I have read this and accept the risk.
              </label>
            </div>
          )}

          {onChooser && !showingMethod && (
            <>
              <p className="muted text-[11px]">Choose your authentication method:</p>
              <ul className="mt-3 space-y-2">
                {KIRO_METHODS.map((entry) => {
                  const Icon = methodIcons[entry.id];
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setMethod(entry.id);
                          setError('');
                          setMessage('');
                          settledRef.current = false;
                          // The four methods that need nothing typed start on this click,
                          // and the two that do (a start URL, a pasted credential) wait
                          // for it. Asking for a second click before anything happens is
                          // what left the tab on about:blank while the dialog waited.
                          if (entry.id === 'builder-id') {
                            openSignInTab();
                            void runDeviceFlow();
                            return;
                          }
                          if (entry.id === 'google' || entry.id === 'github') {
                            openSignInTab();
                            void runSocialFlow(entry.id);
                            return;
                          }
                          if (entry.id === 'import-token' || entry.id === 'api-key') {
                            // No browser involved, so no tab is opened for nothing.
                            document.getElementById('kiro-secret')?.focus();
                          }
                        }}
                        className="flex w-full items-start gap-3 rounded-lg border border-line bg-bg-soft/40 p-3 text-left transition-colors hover:border-line-strong hover:bg-bg-soft disabled:opacity-50"
                        // Nothing is sent to Kiro or AWS until the risk is acknowledged.
                        disabled={Boolean(riskNotice) && !acknowledged}
                      >
                        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-gold-text" aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block text-xs font-semibold text-text">{entry.title}</span>
                          <span className="muted mt-1 block text-[11px] leading-relaxed">{entry.detail}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {showingMethod && method && chosen && (
            <div>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line bg-bg-soft text-gold-text">
                  {phase === 'failed' ? <CircleAlert className="h-4 w-4" /> : <LoaderCircle className="h-4 w-4 animate-spin" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold" role="status" aria-live="polite">
                    {phase === 'failed' ? 'Could not connect' : chosen.title}
                  </p>
                  {error && <p className="mt-1 text-[11px] leading-relaxed text-danger">{error}</p>}
                  {/* The live status wins over the method's hint: once a request is in
                      flight, "what this method is" is less useful than "what is happening". */}
                  {!error && message && <p className="muted mt-1 text-[11px] leading-relaxed">{message}</p>}
                  {!error && !message && chosen.hint && <p className="muted mt-1 text-[11px] leading-relaxed">{chosen.hint}</p>}
                </div>
              </div>

              {(method === 'builder-id' || method === 'organization') && (
                <>
                  {method === 'organization' && (
                    <div className="mt-4">
                      <label htmlFor="kiro-start-url" className="block text-[11px] font-semibold">
                        Company start URL
                      </label>
                      <input
                        id="kiro-start-url"
                        value={startUrl}
                        onChange={(event) => setStartUrl(event.target.value)}
                        placeholder="https://your-org.awsapps.com/start"
                        autoComplete="off"
                        spellCheck={false}
                        className="mt-1.5 w-full rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-[11px] text-text outline-none focus:border-gold/50"
                      />
                    </div>
                  )}

                  {deviceCode && (
                    <div className="mt-4 rounded-xl border border-gold/25 bg-gold-soft p-3">
                      <p className="text-[11px] font-semibold text-gold-text">Approve this code at {providerName}</p>
                      <p className="mt-1 select-all font-mono text-lg tracking-[0.18em] text-text">{deviceCode.userCode}</p>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                        The code is filled in for you. If you are asked to sign in first, sign in there and it will bring
                        you back to this approval.
                      </p>
                      <a href={deviceCode.verificationUrl} target="_blank" rel="noreferrer" className="btn-ghost mt-2 inline-flex !h-7 !px-2.5 !text-[11px]">
                        Open the code page
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                    </div>
                  )}

                  {method === 'organization' && (
                    <button
                      type="button"
                      onClick={() => {
                        settledRef.current = false;
                        openSignInTab();
                        void runDeviceFlow(startUrl.trim());
                      }}
                      disabled={phase === 'running' || !startUrl.trim()}
                      className="btn-gold mt-4 w-full !h-9 !text-xs"
                    >
                      {phase === 'running' ? 'Starting…' : 'Continue'}
                    </button>
                  )}
                </>
              )}



              {(method === 'import-token' || method === 'api-key') && (
                <>
                  <div className="mt-4">
                    <label htmlFor="kiro-secret" className="block text-[11px] font-semibold">
                      {method === 'import-token' ? 'Refresh token' : 'API key'}
                    </label>
                    <input
                      id="kiro-secret"
                      type="password"
                      value={secret}
                      onChange={(event) => {
                        setSecret(event.target.value);
                        setError('');
                      }}
                      autoComplete="off"
                      spellCheck={false}
                      className="mt-1.5 w-full rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-[11px] text-text outline-none focus:border-gold/50"
                    />
                    <p className="muted mt-1.5 text-[11px] leading-relaxed">
                      {method === 'import-token'
                        ? 'It is spent once to get a session, and what gets stored is the access token, not this.'
                        : 'Stored encrypted in your local vault, and used as a bearer credential.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      settledRef.current = false;
                      void submitSecret();
                    }}
                    disabled={phase === 'running' || !secret.trim()}
                    className="btn-gold mt-4 w-full !h-9 !text-xs"
                  >
                    {phase === 'running' ? 'Connecting…' : 'Connect'}
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => {
                  setMethod(null);
                  reset();
                }}
                className="btn-ghost mt-2 w-full !h-8 !text-[11px]"
              >
                Choose a different method
              </button>
            </div>
          )}

          {phase === 'waiting' && (
            <div className="mt-4 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-bg-soft" role="progressbar" aria-label="Waiting for the sign-in to complete">
                <div className="h-full w-1/3 animate-[pulse_1.4s_ease-in-out_infinite] rounded-full bg-gold" />
              </div>
            </div>
          )}

          {phase === 'connected' && (
            <p className="mt-4 flex items-center gap-2 text-[11px] text-success">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {message}
            </p>
          )}
        </div>
      </div>
    </div>,
    portalNode,
  );
}
