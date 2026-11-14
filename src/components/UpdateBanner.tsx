import { useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw, X } from 'lucide-react';
import { desktopBridge, type UpdateState } from '../lib/electronBridge';

/**
 * The update notification.
 *
 * It appears from main's update events, never from a renderer-side version string. Download and install
 * only exist where the platform can replace itself — Windows NSIS, signed macOS. A `.deb` cannot, so
 * Linux gets the release page and the honest reason.
 */
export function UpdateBanner() {
  const bridge = desktopBridge();
  const [state, setState] = useState<UpdateState | undefined>();
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.updates.getState().then((next) => {
      if (active) setState(next);
    });
    const off = bridge.updates.onState((next) => {
      setState(next);
      if (next.status === 'available' || next.status === 'downloaded') setDismissed(false);
    });
    return () => {
      active = false;
      off();
    };
  }, [bridge]);

  if (!bridge || !state || dismissed) return null;
  const show = state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded' || state.status === 'error';
  if (!show) return null;

  const run = async (action: 'download' | 'install') => {
    setError(undefined);
    try {
      if (action === 'download') {
        await bridge.updates.download();
        return;
      }
      /**
       * An unverified update is a decision, not a click-through.
       *
       * `signed` comes from the main process: until release signing exists it is false, and the confirm is
       * what turns "the feed said so" into "the operator agreed".
       */
      if (state.signed === false && !window.confirm(`${state.trustReason ?? 'This update cannot be verified.'}\n\nInstall it anyway?`)) return;
      await bridge.updates.install(state.signed === false ? { allowUnsigned: true } : undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The update action failed.');
    }
  };

  return (
    <aside aria-label="Update" className="fixed bottom-4 right-4 z-[60] w-[min(360px,calc(100vw-2rem))] rounded-xl border border-gold/35 bg-bg p-4 shadow-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold">
            {state.status === 'downloaded' ? `Update ${state.version} is ready` : state.status === 'downloading' ? `Downloading ${state.version ?? 'update'}` : `OmniHilbras ${state.version ?? ''} is available`}
          </p>
          <p className="muted mt-1 text-[11px] leading-relaxed">
            {state.status === 'error'
              ? state.reason
              : state.installMethod === 'deb'
                ? 'Download the .deb, then open the system installer. It will ask for administrator permission.'
                : state.canInstall
                  ? 'Download, install, and restart into the new version.'
                  : 'This build cannot replace itself. Download the release for your platform.'}
          </p>
          {/* Said before the button is pressed, not only in the confirmation. An update nobody can
              prove came from this project should look different from one that can. */}
          {state.signed === false && state.status !== 'error' && (
            <p className="mt-1 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">
              This update cannot be verified: {state.trustReason ?? 'no release-signing key is configured.'}
            </p>
          )}
        </div>
        <button type="button" aria-label="Dismiss update" onClick={() => setDismissed(true)} className="muted rounded-md p-1 hover:text-text"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
      </div>
      {state.status === 'downloading' && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-soft">
          <div className="h-full bg-gold transition-[width]" style={{ width: `${state.percent ?? 0}%` }} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {state.canInstall && state.status === 'available' && (
          <button type="button" onClick={() => void run('download')} className="btn-gold !px-3 !py-1.5 !text-[11px]"><Download className="h-3.5 w-3.5" aria-hidden="true" />Download</button>
        )}
        {state.canInstall && state.status === 'downloaded' && (
          <button type="button" onClick={() => void run('install')} className="btn-gold !px-3 !py-1.5 !text-[11px]"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{state.installMethod === 'deb' ? 'Open installer' : 'Install and restart'}</button>
        )}
        {(!state.canInstall || state.status === 'error') && (
          <button type="button" onClick={() => void bridge.updates.openRelease()} className="btn-ghost !px-3 !py-1.5 !text-[11px]"><ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />Release page</button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-[10px] text-danger">{error}</p>}
    </aside>
  );
}
