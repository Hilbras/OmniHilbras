import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleAlert, Cookie, ExternalLink, LoaderCircle, LogIn, ShieldAlert, Tag } from 'lucide-react';
import { requestJson, type GatewayConnection } from '../lib/gatewayClient';

/**
 * Connecting to a Web Cookie provider.
 *
 * There is no sign-in button here and there will not be one. The only way in is a session
 * the user exports from their own browser, so the dialog's job is to say exactly what to copy,
 * let them check it before committing, and keep the paste out of anything but the gateway.
 *
 * The risk gate is the reason this dialog exists. The credential is a live session for a whole
 * account, not a token scoped to inference, and the flow drives a web app past its own
 * anti-automation checks. Both are stated before the field is enabled, because a warning that
 * appears after you have pasted your session cookie is not a warning.
 */

/**
 * What a web-session provider has to tell the dialog, so the dialog itself is not a
 * ChatGPT dialog with the names swapped.
 */
export type WebSessionDescriptor = {
  id: string;
  name: string;
  website: string;
  /** The one credential that matters, named in the guide. */
  credentialName: string;
  /** How to get it, in the order a person should try. */
  extractionSteps: Array<{ label: string; body: string }>;
  /** The sign-in routes, when the provider has them. */
  /**
   * The sign-in routes, when the provider has them, and what to tell the user about them.
   *
   * The note lives here rather than in the dialog body because the dialog used to hardcode a
   * ChatGPT sentence and cheerfully told DeepSeek users that a chatgpt.com window was about to
   * open. Anything provider-specific belongs to the provider.
   */
  signIn?: { start: string; status: (sessionId: string, freeOnly: boolean) => string; note: string };
  /** The paste route, when there is one. */
  paste?: { path: string; field: string; placeholder: string; supportsFreeOnly?: boolean };
  /** The check route, when a check exists. */
  check?: { path: string; field: string };
  /** What a signed-in account offers, when the provider varies its models by plan. */
  planNote?: string;
};

type Props = {
  provider: WebSessionDescriptor;
  riskNotice?: string;
  riskSeverity?: 'standard' | 'high';
  onConnected: (connection: GatewayConnection) => void | Promise<void>;
  onClose: () => void;
};

type CheckResult = {
  planType: string | null;
  isFreePlan: boolean;
  models: Array<{ id: string; name: string }>;
};

export function WebCookieConnectDialog({ provider: descriptor, riskNotice, riskSeverity = 'standard', onConnected, onClose }: Props) {
  const { name: providerName, website, credentialName: credential } = descriptor;
  const [acknowledged, setAcknowledged] = useState(false);
  const [exported, setExported] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [checked, setChecked] = useState<CheckResult | null>(null);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'signing-in' | 'running' | 'done'>('idle');
  /** What the sign-in flow last said, shown verbatim so a failure is never vague. */
  const [signIn, setSignIn] = useState<{ state: 'waiting' | 'headless' | 'error'; message: string } | null>(null);
  const [error, setError] = useState('');
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const settledRef = useRef(false);

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

  const host = (() => {
    try {
      return new URL(website).host;
    } catch {
      return website;
    }
  })();

  /**
   * Reads the export and reports what the account would get, without storing it.
   *
   * Worth a button of its own because the model set is not knowable in advance: a free account
   * has no picker at all and is served two models, so "connected but no models" is otherwise
   * the first sign that the export came from the wrong account.
   */
  const check = useCallback(async () => {
    setPhase('checking');
    setError('');
    try {
      if (!descriptor.check) return;
      const result = await requestJson<CheckResult>(descriptor.check.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [descriptor.check.field]: exported }),
      });
      setChecked(result);
      setPhase('idle');
    } catch (checkError) {
      setChecked(null);
      setPhase('idle');
      setError(checkError instanceof Error ? checkError.message : 'That export could not be read.');
    }
  }, [descriptor, exported]);

  /**
   * Sign in through a real browser window, rather than by hand.
   *
   * This is the primary path and the paste is the fallback. The four ways the paste could go
   * wrong — wrong cookie, a `Cookie:` prefix, numbered chunks, a truncated header — are all
   * things the browser can simply do, and a session read out of the browser that created it
   * keeps the Cloudflare clearance that a copied one tends to lose.
   *
   * The window opens on the **gateway's** machine, so when there is no display the flow says
   * so and points at the paste path instead of waiting for a sign-in nobody can perform.
   */
  const signInWithBrowser = useCallback(async () => {
    setPhase('signing-in');
    setError('');
    try {
      if (!descriptor.signIn) return;
      const started = await requestJson<{ sessionId: string; headed: boolean }>(descriptor.signIn.start, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!started.headed) {
        setPhase('idle');
        setSignIn({
          state: 'headless',
          message:
            'A ChatGPT window would open on the machine running OmniHilbras, and there is no display there — so there is nowhere to sign in. Paste a Cookie header below instead, or start OmniHilbras on a machine with a display.',
        });
        return;
      }
      setSignIn({ state: 'waiting', message: 'A ChatGPT window has opened on your desktop. Sign in there — this closes itself once you are signed in.' });

      for (let attempt = 0; attempt < 120; attempt += 1) {
        // A visible wait rather than a tight loop: the page needs time to fetch the account,
        // and polling harder than that only costs the machine.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        const status = await requestJson<{ status: string; error?: string; connection?: GatewayConnection }>(
          descriptor.signIn.status(started.sessionId, freeOnly),
        );
        if (status.status === 'pending') continue;
        if (status.status === 'denied') {
          setPhase('idle');
          setSignIn({ state: 'error', message: status.error ?? 'Sign-in did not complete.' });
          return;
        }
        if (status.connection) {
          settledRef.current = true;
          setPhase('done');
          setSignIn(null);
          await onConnected(status.connection);
          onClose();
          return;
        }
      }
      setPhase('idle');
      setSignIn({ state: 'error', message: 'That window was left without being signed in. Start again when you are ready.' });
    } catch (signInError) {
      setPhase('idle');
      setSignIn({
        state: 'error',
        message: signInError instanceof Error ? signInError.message : 'Sign-in could not be started.',
      });
    }
  }, [descriptor, freeOnly, onClose, onConnected]);

  const submit = useCallback(async () => {
    if (settledRef.current) return;
    setPhase('running');
    setError('');
    try {
      if (!descriptor.paste) return;
      const result = await requestJson<{ connection: GatewayConnection }>(descriptor.paste.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Sent to the gateway and nowhere else, so the browser is not trusted to decide
        // which cookies belong to this connection.
        body: JSON.stringify({ [descriptor.paste.field]: exported, freeOnly }),
      });
      settledRef.current = true;
      setPhase('done');
      await onConnected(result.connection);
      onClose();
    } catch (submitError) {
      // The paste is cleared on failure. Leaving a whole-account session in a field next to an
      // error is how it ends up in a screenshot.
      setExported('');
      setChecked(null);
      setPhase('idle');
      setError(submitError instanceof Error ? submitError.message : 'That export could not be connected.');
    }
  }, [exported, freeOnly, onClose, onConnected]);

  if (!portalNode) return null;
  const high = riskSeverity === 'high';
  const pasteReady = exported.trim().length > 0 && (!riskNotice || acknowledged);
  // The models the account would get, narrowed by the toggle — the same narrowing the save
  // applies, so what is shown here is what will be there afterwards.
  const offered = freeOnly && checked ? checked.models.filter((model) => model.id.includes('free')) : checked?.models ?? [];

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
        className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
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
            <div className={`rounded-xl border p-3 ${high ? 'border-danger/40 bg-danger/10' : 'border-[#ff6b35]/30 bg-[#ff6b35]/10'}`}>
              <p className={`flex items-start gap-1.5 text-[11px] font-semibold ${high ? 'text-danger' : 'text-[#ff6b35]'}`}>
                {high ? <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                {high ? 'This is your whole account session' : 'Read this before connecting'}
              </p>
              <p className={`mt-1.5 text-[11px] leading-relaxed ${high ? 'text-danger' : 'text-[#ff6b35]'}`}>{riskNotice}</p>
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

          {/* Sign-in first. It is the path that cannot be got wrong, and the paste below is
              the fallback for a gateway with nowhere to open a window. */}
          <div className="mt-4">
            <p className="text-[11px] font-semibold">Sign in</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              {/* The note comes from the provider, not from here. */}
              {descriptor.signIn?.note}
            </p>
            <button
              type="button"
              onClick={() => void signInWithBrowser()}
              disabled={!descriptor.signIn || !acknowledged || phase === 'signing-in' || phase === 'running'}
              className="btn-gold mt-2.5 w-full !h-9 !text-xs"
            >
              {phase === 'signing-in' ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Waiting for you to sign in
                </>
              ) : (
                <>
                  <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                  Sign in with ChatGPT
                </>
              )}
            </button>
            {signIn && (
              <p
                role="status"
                className={`mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed ${signIn.state === 'error' || signIn.state === 'headless' ? 'text-amber-600 dark:text-amber-400' : 'text-muted'}`}
              >
                {signIn.state === 'waiting' ? (
                  <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
                ) : (
                  <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                )}
                {signIn.message}
              </p>
            )}
          </div>

          {descriptor.paste && (
          <details className="mt-4 rounded-xl border border-line bg-bg-soft/40 p-3">
            <summary className="cursor-pointer text-[11px] font-semibold text-text">
              Or paste a session cookie instead
            </summary>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              For a gateway with no display to open a window on. The same credential either way — this is
              just the part you do by hand.
            </p>
            {/* The guide belongs beside the manual route it describes, not above a button that
              does it for you. */}
          <section className="rounded-xl border border-purple-500/25 bg-purple-500/10 p-3">
            <p className="flex items-start gap-1.5 text-[11px] font-semibold text-text">
              <Cookie className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#a78bfa]" aria-hidden="true" />
              How to get the session credential
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              {providerName} uses a browser web session instead of an API key. Required cookie:{' '}
              <code className="rounded bg-black/25 px-1 py-0.5 font-mono text-[10px] text-[#c4b5fd]">{credential}</code>
            </p>
            <ol className="mt-2 space-y-1.5">
              <li className="flex gap-2 text-[11px] leading-relaxed text-muted">
                <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-line font-mono text-[9px] text-gold-text">1</span>
                <span>
                  Sign in to {providerName} in your browser.
                  <a
                    href={website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1.5 inline-flex items-center gap-0.5 text-gold-text hover:underline"
                  >
                    Open {host}
                    <ExternalLink className="h-2.5 w-2.5" aria-hidden="true" />
                  </a>
                </span>
              </li>
              {descriptor.extractionSteps.map((step, index) => (
                <li key={step.label} className="flex gap-2 text-[11px] leading-relaxed text-muted">
                  <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-line font-mono text-[9px] text-gold-text">
                    {index + 2}
                  </span>
                  <span>
                    <span className="font-semibold text-text">{step.label}:</span> {step.body}
                  </span>
                </li>
              ))}
              <li className="flex gap-2 text-[11px] leading-relaxed text-muted">
                <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-line font-mono text-[9px] text-gold-text">4</span>
                Paste it below and check the cookie. If it stops working, sign in again and paste a fresh value.
              </li>
            </ol>
            <p className="mt-2.5 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">
              Treat this like a password: it may access your signed-in web account until it expires or is revoked.
            </p>
          </section>
            <div className="mt-3">
              <label htmlFor="web-cookie-export" className="block text-[11px] font-semibold">
              Session cookie
            </label>
            <textarea
              id="web-cookie-export"
              value={exported}
              onChange={(event) => {
                setExported(event.target.value);
                setChecked(null);
                setError('');
              }}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              disabled={!acknowledged}
              placeholder={descriptor.paste?.placeholder ?? ''}
              className="mt-1.5 w-full resize-y rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-[11px] text-text outline-none focus:border-gold/50 disabled:opacity-50"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {descriptor.check && (
              <button
                type="button"
                onClick={() => void check()}
                disabled={!descriptor.check || !pasteReady || phase === 'checking' || phase === 'running'}
                className="btn-ghost !h-8 !px-2.5 !text-[11px]"
              >
                {phase === 'checking' ? (
                  <>
                    <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />
                    Checking
                  </>
                ) : (
                  'Check cookie'
                )}
              </button>
              )}
              {descriptor.paste?.supportsFreeOnly && (
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
                <input
                  type="checkbox"
                  checked={freeOnly}
                  onChange={(event) => setFreeOnly(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[#ff6b35]"
                />
                Import only the free models
              </label>
              )}
            </div>
            {checked && (
              <div className="mt-2.5 rounded-lg border border-success/30 bg-success/10 p-2.5">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-success">
                  <Check className="h-3 w-3" aria-hidden="true" />
                  {checked.planType ? `${checked.planType} plan` : 'Signed in'}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-muted">
                  {offered.length} model{offered.length === 1 ? '' : 's'} would be imported.
                  {checked.isFreePlan
                    ? ' The plan is reported, not enforced — the page decides what the account can actually use.'
                    : ''}
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-1">
                  {offered.map((model) => (
                    <li key={model.id} className="flex items-center gap-1 rounded bg-black/25 px-1.5 py-0.5 font-mono text-[9px] text-muted">
                      <Tag className="h-2 w-2 shrink-0" aria-hidden="true" />
                      {model.id}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            </div>

            <button
              type="button"
              onClick={() => void submit()}
              disabled={!descriptor.paste || !pasteReady || phase === 'running' || phase === 'checking'}
              className="btn-gold mt-3 w-full !h-9 !text-xs"
            >
              {phase === 'running' ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Connecting
                </>
              ) : phase === 'done' ? (
                <>
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  Connected
                </>
              ) : (
                'Connect'
              )}
            </button>
          </details>
          )}

          {error && (
            <p role="alert" className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-danger">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}


          <p className="mt-2 text-center text-[10px] leading-relaxed text-muted">
            The gateway stores it encrypted in the local vault. It never reaches browser storage.
          </p>
        </div>
      </div>
    </div>,
    portalNode,
  );
}
