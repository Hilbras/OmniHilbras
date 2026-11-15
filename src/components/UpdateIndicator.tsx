import { useState } from 'react';
import { X } from 'lucide-react';
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
 * ## What differs from it
 *
 * Only the action, because our two builds can do different things. The desktop downloads and installs from
 * here through `electron-updater`; a browser cannot replace itself, so it gets the command above (click to
 * copy) and the release page. The command line is also where a running download reports its percentage,
 * rather than a progress bar the reference card did not have.
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

/** The command a build that cannot replace itself is given. Kept in one place: the card shows it, and the
 * click copies exactly what is shown. */
const INSTALL_COMMAND = 'npm i -g @hilbras/omnihilbras@latest';

export function UpdateIndicator({ collapsed }: { collapsed: boolean }) {
  const { state, skip, releaseUrl, canInstall, download, install } = useUpdateState();
  const [copied, setCopied] = useState(false);

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

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // A browser that refuses the clipboard keeps the line readable and selectable. Nothing is claimed
      // about a copy that did not happen.
    }
  };

  return (
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

      {!collapsed && copied && <p className="muted mt-1.5 pl-4 font-mono text-[10px]">✓ copied</p>}

      {!collapsed && !copied && detail && showCommand && (
        <button
          type="button"
          onClick={() => void copyCommand()}
          title="Copy the install command"
          className="muted mt-1.5 block w-full truncate pl-4 text-left font-mono text-[10px] transition-colors hover:text-text"
        >
          {detail}
        </button>
      )}

      {!collapsed && !copied && detail && !showCommand && (
        <p className="muted mt-1.5 pl-4 font-mono text-[10px]">{detail}</p>
      )}

      {!collapsed && (
        <div className="mt-2 pl-4">
          {/* One action, whichever one this build can actually take. */}
          {state.status === 'downloaded' && install && (
            <button
              type="button"
              onClick={() => {
                /**
                 * An unverified update is a decision, not a click-through.
                 *
                 * `signed` comes from the main process: until release signing exists it is `false`, and
                 * this confirm is what turns "the feed said so" into "the operator agreed". The reason
                 * travels with it, so the prompt can say why rather than asking about nothing.
                 */
                if (state.signed === false && !window.confirm(`${state.trustReason ?? 'This update cannot be verified.'}\n\nInstall it anyway?`)) return;
                void install(state.signed === false ? { allowUnsigned: true } : undefined);
              }}
              className="btn-gold !px-2.5 !py-1.5 !text-[11px]"
            >
              Install and restart
            </button>
          )}
          {state.status === 'available' && download && (
            <button type="button" onClick={() => void download()} className="btn-gold !px-2.5 !py-1.5 !text-[11px]">
              Update now
            </button>
          )}
          {state.status === 'available' && !download && (
            <a href={releaseUrl} target="_blank" rel="noreferrer" className="btn-gold !px-2.5 !py-1.5 !text-[11px]">
              Update now
            </a>
          )}
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
  );
}
