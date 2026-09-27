import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Building2, Check, CircleAlert, ExternalLink, GitBranch, KeyRound, LoaderCircle, LogIn, ShieldCheck, Upload } from 'lucide-react';
import {
  KIRO_METHODS,
  connectKiroApiKey,
  exchangeKiroSocialCode,
  extractKiroCode,
  getKiroSignInStatus,
  importKiroRefreshToken,
  kiroMethod,
  startKiroDeviceSignIn,
  startKiroSocialSignIn,
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

export function KiroConnectDialog({ providerName, riskNotice, onConnected, onClose }: Props) {
  const [method, setMethod] = useState<KiroAuthMethod | null>(null);
  const [phase, setPhase] = useState<Phase>('choose');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [startUrl, setStartUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [deviceCode, setDeviceCode] = useState<{ userCode: string; verificationUrl: string } | null>(null);
  const [socialUrl, setSocialUrl] = useState('');
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const pollRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const settledRef = useRef(false);
  const socialSessionRef = useRef<string | null>(null);

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
      setPhase('waiting');
      setMessage('Approve the request in your browser using the code below. This tab will finish the connection.');
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
        watchDeviceSession(signIn.sessionId);
      } catch (startError) {
        fail(startError instanceof Error ? startError.message : 'The sign-in could not be started.');
      }
    },
    [fail, watchDeviceSession],
  );

  const runSocialFlow = useCallback(
    async (provider: 'google' | 'github') => {
      setPhase('running');
      setError('');
      try {
        const signIn = await startKiroSocialSignIn(provider);
        if (settledRef.current) return;
        setSocialUrl(signIn.authUrl);
        setDeviceCode({ userCode: '', verificationUrl: signIn.authUrl });
        setPhase('waiting');
        setMessage('Sign in on the page that just opened, then copy the code from your address bar and paste it below.');
        socialSessionRef.current = signIn.sessionId;
      } catch (startError) {
        fail(startError instanceof Error ? startError.message : 'The sign-in could not be started.');
      }
    },
    [fail],
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

  const submitSocialCode = useCallback(async () => {
    const sessionId = socialSessionRef.current;
    if (!sessionId) return;
    const extracted = extractKiroCode(code);
    if (!extracted) {
      setError('No code found in that. Paste the whole address, or just the code from it.');
      return;
    }
    setPhase('running');
    setError('');
    try {
      const result = await exchangeKiroSocialCode(sessionId, extracted);
      await finish(result.connection);
    } catch (submitError) {
      setCode('');
      setPhase('failed');
      setError(submitError instanceof Error ? submitError.message : 'That code could not be exchanged.');
    }
  }, [code, finish]);

  const reset = useCallback(() => {
    stopWaiting();
    settledRef.current = false;
    socialSessionRef.current = null;
    setPhase('choose');
    setError('');
    setMessage('');
    setDeviceCode(null);
    setSocialUrl('');
    setStartUrl('');
    setSecret('');
    setCode('');
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

                  <button
                    type="button"
                    onClick={() => {
                      settledRef.current = false;
                      void runDeviceFlow(method === 'organization' ? startUrl.trim() : undefined);
                    }}
                    disabled={phase === 'running' || (method === 'organization' && !startUrl.trim())}
                    className="btn-primary mt-4 w-full !h-9 !text-xs"
                  >
                    {phase === 'running' ? 'Starting…' : 'Continue'}
                  </button>
                </>
              )}

              {(method === 'google' || method === 'github') && (
                <>
                  {socialUrl && (
                    <a href={socialUrl} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1 text-[11px] text-gold-text hover:underline">
                      Reopen the sign-in page
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                  <div className="mt-4">
                    <label htmlFor="kiro-social-code" className="block text-[11px] font-semibold">
                      Code from your address bar
                    </label>
                    <input
                      id="kiro-social-code"
                      value={code}
                      onChange={(event) => {
                        setCode(event.target.value);
                        setError('');
                      }}
                      placeholder="kiro://kiro.kiroAgent/authenticate-success?code=…"
                      autoComplete="off"
                      spellCheck={false}
                      className="mt-1.5 w-full rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-[11px] text-text outline-none focus:border-gold/50"
                    />
                    <p className="muted mt-1.5 text-[11px] leading-relaxed">
                      Your browser will show a &ldquo;can&rsquo;t open this page&rdquo; message. That is expected — the code
                      is in the address bar above it.
                    </p>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        settledRef.current = false;
                        void runSocialFlow(method);
                      }}
                      disabled={phase === 'running' || Boolean(socialUrl)}
                      className="btn-ghost !h-9 flex-1 !px-2.5 !text-[11px]"
                    >
                      {socialUrl ? 'Page opened' : `Open ${method === 'google' ? 'Google' : 'GitHub'} sign-in`}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        settledRef.current = false;
                        void submitSocialCode();
                      }}
                      disabled={phase === 'running' || !code.trim()}
                      className="btn-primary !h-9 flex-1 !text-xs"
                    >
                      {phase === 'running' ? 'Checking…' : 'Connect'}
                    </button>
                  </div>
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
                    className="btn-primary mt-4 w-full !h-9 !text-xs"
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
