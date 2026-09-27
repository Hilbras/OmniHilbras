import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleAlert, LoaderCircle, ShieldAlert, Upload } from 'lucide-react';
import { requestJson, type GatewayConnection } from '../lib/gatewayClient';

/**
 * Connecting to a Web Cookie provider.
 *
 * There is no sign-in button here and there will not be one. The only way in is a session
 * the user exports from their own browser, so the dialog's job is to say what to export,
 * what will happen to it, and to keep the paste out of anything that is not the gateway.
 *
 * The risk gate is the reason this dialog exists. The credential is a live session for a
 * whole account, not a token scoped to inference, and the flow drives a web app past its
 * own anti-automation checks. Both are stated before the field is enabled, because a
 * warning that appears after you have pasted your session cookie is not a warning.
 */

type Props = {
  providerName: string;
  riskNotice?: string;
  riskSeverity?: 'standard' | 'high';
  onConnected: (connection: GatewayConnection) => void | Promise<void>;
  onClose: () => void;
};

const exportSteps = [
  'Open chatgpt.com in your own browser, signed in.',
  'Open DevTools → Application → Cookies → https://chatgpt.com.',
  'Export the cookies, or copy the whole Cookie request header.',
  'Paste it below. It is stored encrypted in your local vault and never reaches browser storage.',
];

export function WebCookieConnectDialog({ providerName, riskNotice, riskSeverity = 'standard', onConnected, onClose }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [exported, setExported] = useState('');
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
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

  const submit = useCallback(async () => {
    if (settledRef.current) return;
    setPhase('running');
    setError('');
    try {
      const result = await requestJson<{ connection: GatewayConnection }>('/v1/web-cookie/chatgpt/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Sent to the gateway and nowhere else, so the browser is not trusted to decide
        // which cookies belong to this connection.
        body: JSON.stringify({ storageState: exported }),
      });
      settledRef.current = true;
      setPhase('done');
      await onConnected(result.connection);
      onClose();
    } catch (submitError) {
      // The paste is cleared on failure. Leaving a whole-account session in a field next
      // to an error is how it ends up in a screenshot.
      setExported('');
      setPhase('idle');
      setError(submitError instanceof Error ? submitError.message : 'That export could not be connected.');
    }
  }, [exported, onClose, onConnected]);

  if (!portalNode) return null;
  const high = riskSeverity === 'high';

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
        className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[520px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
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

          <div className="mt-4">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold">
              <Upload className="h-3.5 w-3.5 text-gold-text" aria-hidden="true" />
              Export your session
            </p>
            <ol className="mt-2 space-y-1.5">
              {exportSteps.map((step, index) => (
                <li key={step} className="flex gap-2 text-[11px] leading-relaxed text-muted">
                  <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-line font-mono text-[9px] text-gold-text">
                    {index + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          <div className="mt-4">
            <label htmlFor="web-cookie-export" className="block text-[11px] font-semibold">
              Paste the export
            </label>
            <textarea
              id="web-cookie-export"
              value={exported}
              onChange={(event) => {
                setExported(event.target.value);
                setError('');
              }}
              rows={4}
              spellCheck={false}
              autoComplete="off"
              disabled={!acknowledged}
              placeholder='{"cookies":[{"name":"…","value":"…"}]}  or  __Secure-next-auth.session-token=…; oai-did=…'
              className="mt-1.5 w-full resize-y rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-[11px] text-text outline-none focus:border-gold/50 disabled:opacity-50"
            />
            <p className="muted mt-1.5 text-[11px] leading-relaxed">
              Only chatgpt.com and openai.com cookies are kept. Anything else in the export is dropped before it is stored.
            </p>
          </div>

          {error && (
            <p role="alert" className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-danger">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={phase === 'running' || !exported.trim() || (Boolean(riskNotice) && !acknowledged)}
            className="btn-primary mt-4 w-full !h-9 !text-xs"
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

          <p className="muted mt-2 text-center text-[10px] leading-relaxed">
            The gateway stores it encrypted in the local vault. It never reaches browser storage.
          </p>
        </div>
      </div>
    </div>,
    portalNode,
  );
}
