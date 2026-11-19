import { KeyRound, LogIn, X } from 'lucide-react';
import { Dialog } from '../ui/Dialog';

/**
 * The choice a provider with two ways in must ask for.
 *
 * Nous Research accepts a portal sign-in **and** an API key. Offering one button that silently picks
 * either left the other unreachable. The choice is asked once, in its own dialog, before either flow
 * starts.
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
  return (
    <Dialog open onClose={onClose} labelledBy="connection-method-title" className="max-w-[430px]">
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
          <span className="muted text-[11px] leading-relaxed">Approve the sign-in in your browser. No key to copy.</span>
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
    </Dialog>
  );
}
