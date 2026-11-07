import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound, LogIn, X } from 'lucide-react';

/**
 * The choice a provider with two ways in must ask for.
 *
 * Nous Research accepts a portal sign-in **and** an API key. Offering one button that silently picks
 * either left the other unreachable — and the first attempt at two buttons put *both* dialogs on screen,
 * because the sign-in dialog's own gate did not know a key had been chosen.
 *
 * So the choice is asked once, in its own small dialog, before either flow starts. Two cards rather than a
 * select: each path needs a sentence about what it does, and a select cannot carry one.
 */
export function ConnectionMethodDialog({
  providerName,
  onSignIn,
  onApiKey,
  onClose,
}: {
  providerName: string;
  onSignIn: () => void;
  onApiKey: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="connection-method-title" className="w-full max-w-[430px] rounded-xl border border-line bg-surface p-4 shadow-2xl outline-none">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="connection-method-title" className="text-sm font-semibold">Connect {providerName}</h2>
            <p className="muted mt-1 text-xs">{providerName} accepts two kinds of credential. Both connect the same provider.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-bg-soft hover:text-text">
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
          <button
            type="button"
            onClick={onSignIn}
            className="flex flex-col items-start gap-2 rounded-xl border border-line bg-bg-soft p-3.5 text-left transition-colors hover:border-gold/40 hover:bg-gold-soft/40"
          >
            <span className="grid h-8 w-8 place-items-center rounded-lg border border-gold/25 bg-gold-soft text-gold-text"><LogIn className="h-4 w-4" aria-hidden="true" /></span>
            <span className="text-xs font-semibold">Sign in</span>
            <span className="muted text-[11px] leading-relaxed">Approve a code on {providerName}&rsquo;s own page. No key to copy.</span>
          </button>
          <button
            type="button"
            onClick={onApiKey}
            className="flex flex-col items-start gap-2 rounded-xl border border-line bg-bg-soft p-3.5 text-left transition-colors hover:border-gold/40 hover:bg-gold-soft/40"
          >
            <span className="grid h-8 w-8 place-items-center rounded-lg border border-line-strong bg-surface text-muted"><KeyRound className="h-4 w-4" aria-hidden="true" /></span>
            <span className="text-xs font-semibold">API key</span>
            <span className="muted text-[11px] leading-relaxed">Paste a key from {providerName}&rsquo;s dashboard. Checked against the provider before it is saved.</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}