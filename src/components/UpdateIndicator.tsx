import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, ExternalLink, Power, X } from 'lucide-react';
import type { UpdateState } from '../lib/electronBridge';
import { shutdownGateway } from '../lib/gatewayClient';
import { useUpdateState } from '../lib/useUpdateState';

/**
 * "A newer version exists" — in the sidebar, directly under the gateway badge.
 *
 * ## The design is the reference card's, on purpose
 *
 * Same position, same shape, same amber pill: a pulsing dot and `New version: v{version}` on one line, the
 * command (or what the updater is doing) in mono underneath, one gold action. It read as two status
 * statements about *this installation* — is the gateway answering, and is this the current version — sitting
 * together above the navigation, where a person looks before wondering why something behaves oddly.
 *
 * ## What the button opens
 *
 * A popup with the manual path in it, which is the part a browser and a server install actually need: the
 * install command with a copy button, a link to the release, and a stop button — stop the gateway, run the
 * command in a terminal, start again. The desktop's own download and install sit at the top of the same
 * popup when the bridge offers them, because a build that *can* replace itself should not be pushed through
 * the manual steps to reach the button that does it.
 *
 * ## What it refuses to do
 *
 * - **It never claims a version it did not learn.** No version is rendered unless a check returned one;
 *   a failed check says it failed rather than showing "up to date".
 * - **It never offers to install where installing is impossible.** In a browser there is nothing to
 *   install into, so the browser sees the release page and the command; the Download button only exists
 *   when the desktop bridge said `canInstall`. A button that does nothing is worse than no button.
 * - **It does not shout.** `current`, `idle` and a skipped version render nothing at all: an update is
 *   news once.
 */

/** The command a build that cannot replace itself is given. Kept in one place: the card shows it, the popup
 * shows it, and the copy button copies exactly what is on screen. */
const INSTALL_COMMAND = 'npm i -g @hilbras/omnihilbras@latest';

export function UpdateIndicator({ collapsed }: { collapsed: boolean }) {
  const { state, skip, releaseUrl, canInstall, download, install } = useUpdateState();
  const [popupOpen, setPopupOpen] = useState(false);

  if (!state) return null;
  // Only the states that are worth taking space for. `checking` is silent because a check that finds
  // nothing is the normal case, and a spinner that appears on every load is noise.
  const interesting = state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded';
  if (!interesting) return null;

  const version = state.version;
  // A browser has nothing to download into, so the line under the label is the command. Anything else the
  // card says is what the updater actually reported, and never an invented step.
  const showCommand = download === undefined && state.status === 'available';
  const percent = state.percent === undefined ? undefined : Math.round(Math.max(0, Math.min(100, state.percent)));
  const detail = state.status === 'downloading'
    ? `Downloading${percent === undefined ? '' : ` ${percent}%`}`
    : state.status === 'downloaded'
      ? 'Downloaded — restart to install'
      : showCommand
        ? INSTALL_COMMAND
        : state.reason;

  return (
    <>
      <div
        className={`mx-4 mb-4 rounded-xl border border-warning/30 bg-warning/10 ${collapsed ? 'flex justify-center p-2.5' : 'p-3'}`}
        title={collapsed ? `New version: v${version}` : undefined}
        aria-label={`New version available: ${version ?? ''}`}
        role="status"
      >
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2'}`}>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-warning" />
          </span>
          {!collapsed && <span className="text-xs font-semibold text-warning">New version: v{version}</span>}
        </div>

        {!collapsed && detail && <p className="muted mt-1.5 pl-4 font-mono text-[10px]">{detail}</p>}

        {!collapsed && (
          <div className="mt-2 pl-4">
            <button type="button" onClick={() => setPopupOpen(true)} className="btn-gold !px-2.5 !py-1.5 !text-[11px]">
              Update now
            </button>
          </div>
        )}

        {!collapsed && state.status === 'available' && !canInstall && (
          <p className="muted mt-2 pl-4 text-[10px] leading-relaxed">
            {/* Why there is no install button here, said rather than implied. */}
            This build cannot replace itself. Update through the installer or the command above.
          </p>
        )}

        {!collapsed && version && (
          <button
            type="button"
            onClick={() => skip(version)}
            className="muted mt-2 inline-flex items-center gap-1 pl-4 text-[10px] transition-colors hover:text-text"
            title={`Do not tell me about v${version} again`}
          >
            <X className="h-3 w-3" aria-hidden="true" />
            Skip this version
          </button>
        )}
      </div>

      {popupOpen && (
        <UpdatePopup
          state={state}
          version={version}
          releaseUrl={releaseUrl}
          download={download}
          install={install}
          onClose={() => setPopupOpen(false)}
        />
      )}
    </>
  );
}

/**
 * The popup: install it here, or take the command and do it in a terminal.
 *
 * `Shutdown` stops the gateway through `POST /v1/system/shutdown`, which answers before it stops. It is a
 * real stop with a real question in front of it — the reference implementation counted down three seconds
 * with `Cancel` disabled and shut the server down as a side effect of copying a string, which is a one-way
 * door for a convenience.
 */
function UpdatePopup({
  state,
  version,
  releaseUrl,
  download,
  install,
  onClose,
}: {
  state: UpdateState;
  version: string | undefined;
  releaseUrl: string | undefined;
  download: (() => Promise<UpdateState | undefined>) | undefined;
  install: ((options?: { allowUnsigned?: boolean }) => Promise<void>) | undefined;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [stop, setStop] = useState<'idle' | 'stopping' | 'stopped' | 'failed'>('idle');
  const [stopError, setStopError] = useState<string | undefined>(undefined);

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

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // A browser that refuses the clipboard leaves the command selectable, and nothing is claimed about a
      // copy that did not happen.
    }
  };

  const stopGateway = async () => {
    if (stop === 'stopping') return;
    if (!window.confirm('Stop the gateway now?\n\nThe dashboard stops answering until you start it again (run `omnihilbras` in a terminal). Your accounts, keys and settings are not touched.')) return;
    setStop('stopping');
    setStopError(undefined);
    try {
      await shutdownGateway();
      setStop('stopped');
    } catch (error) {
      // A refusal is reported as a refusal. A stop that worked answers first and then goes, so reaching here
      // means the gateway said no rather than that it left.
      setStop('failed');
      setStopError(error instanceof Error ? error.message : 'The gateway refused to stop.');
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-popup-title"
        className="w-full max-w-[460px] rounded-xl border border-line bg-surface p-4 shadow-2xl outline-none"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="update-popup-title" className="text-sm font-semibold">
              Update OmniHilbras{version ? ` to v${version}` : ''}
            </h2>
            <p className="muted mt-1 text-xs">
              {download || install
                ? 'Install it here, or copy the command and run it in a terminal.'
                : 'Copy the command, stop the gateway, then run it in a terminal.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-bg-soft hover:text-text"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* The desktop's own actions first: a build that can replace itself should not be walked past them. */}
        {state.status === 'available' && download && (
          <button
            type="button"
            onClick={() => void download()}
            className="btn-gold mt-4 !px-3 !py-2 !text-xs"
          >
            Download
          </button>
        )}
        {state.status === 'downloaded' && install && (
          <button
            type="button"
            onClick={() => {
              /**
               * An unverified update is a decision, not a click-through.
               *
               * `signed` comes from the main process: until release signing exists it is `false`, and this
               * confirm is what turns "the feed said so" into "the operator agreed". The reason travels with
               * it, so the prompt can say why rather than asking about nothing.
               */
              if (state.signed === false && !window.confirm(`${state.trustReason ?? 'This update cannot be verified.'}\n\nInstall it anyway?`)) return;
              void install(state.signed === false ? { allowUnsigned: true } : undefined);
            }}
            className="btn-gold mt-4 !px-3 !py-2 !text-xs"
          >
            Install and restart
          </button>
        )}

        <p className="muted mt-4 text-[10px] uppercase tracking-wide">Install command</p>
        <div className="mt-1.5 flex items-stretch gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-line bg-bg-soft px-2.5 py-2 font-mono text-[11px]">{INSTALL_COMMAND}</code>
          <button
            type="button"
            onClick={() => void copyCommand()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[11px] font-semibold transition-colors hover:border-gold/50"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <p className="muted mt-2 text-[10px] leading-relaxed">
          Steps: copy the command, stop the gateway, paste it into a terminal, then run <code className="rounded bg-bg-soft px-1">omnihilbras</code> again.
        </p>

        {stop === 'stopped' ? (
          <p className="mt-4 rounded-lg border border-line bg-bg-soft p-2.5 text-[11px] leading-relaxed">
            The gateway is stopping. Paste the command into a terminal, then start it again with <code className="rounded bg-bg-soft px-1">omnihilbras</code>.
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {/* The two actions this popup exists for: where to download it, and getting the server out of
                the way so the command can replace it. */}
            <a href={releaseUrl ?? '#'} target="_blank" rel="noreferrer" className="btn-gold !px-3 !py-2 !text-xs">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Update release
            </a>
            <button
              type="button"
              onClick={() => void stopGateway()}
              disabled={stop === 'stopping'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-danger/50 px-3 py-2 text-xs font-semibold text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Power className="h-3.5 w-3.5" aria-hidden="true" />
              {stop === 'stopping' ? 'Stopping…' : 'Shutdown'}
            </button>
          </div>
        )}

        {stop === 'failed' && stopError && (
          <p className="mt-2 text-[11px] leading-relaxed text-danger">{stopError}</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
