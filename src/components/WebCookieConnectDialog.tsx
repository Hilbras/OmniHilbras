import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleAlert, Cookie, ExternalLink, LoaderCircle, LogIn, ShieldAlert, Tag } from 'lucide-react';
import { providerSlug } from '@hilbras/omnihilbras';
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
  /**
   * How to get it, in the order a person should try.
   *
   * The first step is a console one-liner rather than a DevTools navigation, because the
   * navigation is where people get lost: a wrong click yields a cookie object, or the signed
   * out placeholder, and neither is obvious at the point of failure. Pasting the value of
   * `localStorage` is one line and it is the same value either way.
   */
  extractionSteps: Array<{ label: string; body: string; snippet?: string }>;
  /** The sign-in routes, when the provider has them. */
  /** The paste route, when there is one. */
  paste?: {
    path: string;
    field: string;
    placeholder: string;
    supportsFreeOnly?: boolean;
    /** The collapsed section's own label, and the field's label. */
    sectionLabel: string;
    fieldLabel: string;
  };
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

/**
 * A probe, for a provider whose one open question cannot be answered offline.
 *
 * Qwen is the case: whether Alibaba's bot-protection gate applies to an *authenticated* request
 * is unknown until a signed-in credential is tried, and it refuses with HTTP 200 and a refusal in
 * the body. So there is nothing to save and nothing to narrow — the answer is three facts, and
 * the provider's own words are shown rather than a verdict.
 */
type ProbeResult = {
  authenticated: boolean;
  turnServed: boolean;
  detail: string;
  authDetail: string;
  models: string[];
};

export function WebCookieConnectDialog({ provider: descriptor, riskNotice, riskSeverity = 'standard', onConnected, onClose }: Props) {
  const { name: providerName, website, credentialName: credential } = descriptor;
  const [acknowledged, setAcknowledged] = useState(false);
  const [exported, setExported] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [checked, setChecked] = useState<CheckResult | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'running' | 'done'>('idle');
  const [error, setError] = useState('');
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    setPortalNode(document.body);
  }, []);

  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Returns focus to the control that opened the dialog, so closing it does not drop a keyboard user at the top of the page.
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      previousFocusRef.current?.focus({ preventScroll: true });
      previousFocusRef.current = null;
    };
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
      const body = await requestJson<CheckResult & { probe?: ProbeResult }>(descriptor.check.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [descriptor.check.field]: exported }),
      });
      // A route that answers with a probe has no connection to offer, so it is kept apart
      // rather than read as a plan and a model list.
      if (body.probe) {
        setProbe(body.probe);
        setChecked(null);
        setPhase('idle');
        return;
      }
      setChecked(body);
      setProbe(null);
      setPhase('idle');
    } catch (checkError) {
      setChecked(null);
      setProbe(null);
      setPhase('idle');
      setError(checkError instanceof Error ? checkError.message : 'That export could not be read.');
    }
  }, [descriptor, exported]);

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
  /**
   * Whether there is anything to acknowledge at all.
   *
   * The textarea used to be gated on `!acknowledged` unconditionally, while the checkbox that
   * sets `acknowledged` renders only when `riskNotice` is set. A provider without a risk notice
   * therefore got a permanently disabled field and no way to unlock it — which reads as a broken
   * dialog, not as a lock. The gate and the thing that can open it have to be the same condition.
   */
  const mustAcknowledge = Boolean(riskNotice);
  const pasteReady = exported.trim().length > 0 && (!mustAcknowledge || acknowledged);
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

          {/*
            One button, and it opens the provider in **this** browser.

            There used to be a second path: OmniHilbras launching its own Chromium and
            reading the session out of that. It opened a window on the desktop, the user could
            not tell it from an unrelated browser, and it was broken — the window showed the
            provider's home page and the flow never detected the sign-in, so it just sat
            there. Two buttons, one of which was broken and unexplained, is worse than the
            paste path on its own, so the window flow is gone rather than demoted.

            The profile the window used to populate is still used for *turns* when it happens
            to be signed in; it is just no longer how a connection is made.
          */}
          <div className="mt-4">
            <p className="text-[11px] font-semibold">Sign in</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              Opens {website.replace(/^https?:\/\//, '').replace(/\/$/, '')} in a new tab in this browser.
              Sign in there, then copy {descriptor.credentialName} as described below and paste it.
            </p>
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-gold mt-2.5 flex w-full !h-9 items-center justify-center !text-xs no-underline"
            >
              <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
              Open {website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          </div>

          {(descriptor.paste ?? descriptor.check) && (
          <section className="mt-4 rounded-xl border border-line bg-bg-soft/40 p-3">
            <p className="text-[11px] font-semibold">Copy the credential</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              This is the only step that has to be done by hand, and it is one value.
            </p>
            {/* The guide belongs beside the manual route it describes, not above a button that
              does it for you. */}
          <section className="rounded-xl border border-purple-500/25 bg-purple-500/10 p-3">
            <p className="flex items-start gap-1.5 text-[11px] font-semibold text-text">
              <Cookie className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#a78bfa]" aria-hidden="true" />
              How to get the session credential
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              {providerName} uses a browser web session instead of an API key. What to copy:{' '}
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
                    {step.snippet && (
                      <>
                        {' '}
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard?.writeText(step.snippet as string).catch(() => undefined)}
                          title="Copy this line"
                          className="mt-1 block w-full overflow-x-auto rounded border border-line bg-bg-soft px-1.5 py-1 text-left font-mono text-[10px] text-gold-text hover:border-gold/50"
                        >
                          {step.snippet}
                        </button>
                      </>
                    )}
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
              {descriptor.paste?.fieldLabel ?? 'Cookie header'}
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
              disabled={mustAcknowledge && !acknowledged}
              placeholder={descriptor.paste?.placeholder ?? 'name=value; name=value'}
              className="mt-1.5 w-full resize-y rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-[11px] text-text outline-none focus:border-gold/50 disabled:opacity-50"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {descriptor.check && (
              <button
                type="button"
                onClick={() => void check()}
                disabled={!descriptor.check || !pasteReady || phase === 'checking' || phase === 'running'}
                // Hidden when there is nothing to save, because the primary action is then the
                // check itself and two buttons that do the same thing is a choice nobody wants.
                className={`btn-ghost !h-8 !px-2.5 !text-[11px] ${descriptor.paste ? '' : 'hidden'}`}
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
            {/*
              A probe reports three facts and nothing is saved. The turn is the one that
              matters, and the provider's own words are shown rather than a verdict — Qwen
              refuses bot-protected requests with HTTP 200 and a refusal in the body, so
              "the request succeeded" and "the answer was no" are the same wire event.
            */}
            {probe && (
              <div className={`mt-2.5 rounded-lg border p-2.5 ${probe.turnServed ? 'border-success/30 bg-success/10' : 'border-gold/30 bg-gold-soft'}`}>
                <p className={`flex items-center gap-1.5 text-[11px] font-semibold ${probe.turnServed ? 'text-success' : 'text-gold-text'}`}>
                  {probe.turnServed ? <Check className="h-3 w-3" aria-hidden="true" /> : <CircleAlert className="h-3 w-3" aria-hidden="true" />}
                  {probe.turnServed ? 'A turn was served' : 'A turn was refused'}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-muted">{probe.detail}</p>
                <p className="muted mt-1 text-[10px] leading-relaxed">
                  Credential at auth.qwen.ai: <span className="font-mono">{probe.authDetail}</span>
                </p>
                {probe.models.length > 0 && (
                  <>
                    <p className="muted mt-1.5 text-[10px]">
                      {probe.models.length} model{probe.models.length === 1 ? '' : 's'} served to guests:
                    </p>
                    <ul className="mt-1 flex flex-wrap gap-1">
                      {probe.models.map((model) => (
                        <li key={model} className="flex items-center gap-1 rounded bg-black/25 px-1.5 py-0.5 font-mono text-[9px] text-muted">
                          <Tag className="h-2 w-2 shrink-0" aria-hidden="true" />
                          {providerSlug(descriptor.id)}/{model}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p className="muted mt-2 text-[10px] leading-relaxed">
                  Nothing has been saved. A connection is only worth having once a turn is actually served.
                </p>
              </div>
            )}

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

            {!descriptor.paste && descriptor.check && (
              <button
                type="button"
                onClick={() => void check()}
                disabled={!pasteReady || phase === 'running' || phase === 'checking'}
                // Named rather than silently greyed. A disabled primary button with no
                // explanation is read as a broken feature, which is exactly the wrong
                // conclusion — the thing it wants is one field, described two steps above.
                title={pasteReady ? undefined : 'Paste the credential above first.'}
                className="btn-gold mt-3 w-full !h-9 !text-xs"
              >
                {phase === 'checking' ? (
                  <>
                    <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    Asking Qwen
                  </>
                ) : (
                  'Ask Qwen'
                )}
              </button>
            )}
            {!descriptor.paste && descriptor.check && phase === 'checking' && (
              <p className="muted mt-2 text-center text-[10px] leading-relaxed" role="status">
                {/* A spinner with nothing to say is the same as a dead button. Naming the three
                    questions, and the clock, is what makes a slow answer legible as progress. */}
                Asking Qwen three things: whether the cookie means anything, what models it serves,
                and whether a turn is really answered. This can take up to 20 seconds.
              </p>
            )}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!descriptor.paste || !pasteReady || phase === 'running' || phase === 'checking'}
              className={`btn-gold mt-3 w-full !h-9 !text-xs ${descriptor.paste ? '' : 'hidden'}`}
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
          </section>
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
