import { ExternalLink, X } from 'lucide-react';
import { useUpdateState } from '../lib/useUpdateState';

/**
 * "A newer version exists" — in the sidebar, directly under the gateway badge.
 *
 * That position is the one the reference implementation used, and it is the right one: it puts the two
 * *status* statements about this installation together — is the gateway answering, and is this the current
 * version — in the same place, above the navigation, where a person looks before wondering why something
 * behaves oddly.
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
export function UpdateIndicator({ collapsed }: { collapsed: boolean }) {
  const { state, source, skip, releaseUrl, canInstall, download, install } = useUpdateState();

  if (!state) return null;
  // Only the states that are worth taking space for. `checking` is silent because a check that finds
  // nothing is the normal case, and a spinner that appears on every load is noise.
  const interesting = state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded';
  if (!interesting) return null;

  const version = state.version;
  const label = state.status === 'downloaded'
    ? 'Restart to update'
    : state.status === 'downloading'
      ? `Downloading${state.percent === undefined ? '' : ` ${Math.round(state.percent)}%`}`
      : `Update${version ? ` v${version}` : ''} available`;

  return (
    <div
      className={`mx-4 mb-4 rounded-xl border border-gold/35 bg-gold-soft/60 ${collapsed ? 'flex justify-center p-2.5' : 'p-3'}`}
      title={collapsed ? label : undefined}
      aria-label={label}
      role="status"
    >
      <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-2'}`}>
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gold opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-gold" />
        </span>
        {!collapsed && <span className="text-xs font-semibold text-gold-text">{label}</span>}
      </div>

      {!collapsed && (
        <>
          {/* Progress is shown when the updater reported a percentage, and not invented when it did not. */}
          {state.status === 'downloading' && state.percent !== undefined && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-gold/20" aria-hidden="true">
              <div className="h-full rounded-full bg-gold transition-[width] duration-300" style={{ width: `${Math.min(100, Math.max(0, state.percent))}%` }} />
            </div>
          )}

          {state.reason && <p className="muted mt-1.5 pl-4 text-[10px] leading-relaxed">{state.reason}</p>}

          <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-4">
            {/*
              The desktop's own actions, and only where they exist. `download` is undefined in a browser,
              so the button below cannot be rendered into a click that does nothing.
            */}
            {state.status === 'available' && download && (
              <button
                type="button"
                onClick={() => void download()}
                className="rounded-lg border border-gold/40 bg-bg px-2.5 py-1 text-[10px] font-semibold text-gold-text transition-colors hover:border-gold/70"
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
                   * `signed` comes from the main process: until release signing exists it is `false`, and
                   * this confirm is what turns "the feed said so" into "the operator agreed". The reason
                   * travels with it, so the prompt can say why rather than asking about nothing.
                   */
                  if (state.signed === false && !window.confirm(`${state.trustReason ?? 'This update cannot be verified.'}\n\nInstall it anyway?`)) return;
                  void install(state.signed === false ? { allowUnsigned: true } : undefined);
                }}
                className="rounded-lg border border-gold/40 bg-gold-soft px-2.5 py-1 text-[10px] font-semibold text-gold-text transition-colors hover:border-gold/70"
              >
                Install and restart
              </button>
            )}
            {state.status === 'available' && !download && (
              <a
                href={releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[10px] font-semibold transition-colors hover:border-gold/50"
              >
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                Download
              </a>
            )}
            {state.status !== 'downloaded' && download && (
              <a
                href={releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[10px] font-semibold transition-colors hover:border-gold/50"
              >
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                Release notes
              </a>
            )}
            {source === 'github' && (
              <code className="muted rounded bg-bg-soft px-1.5 py-0.5 font-mono text-[10px]">npm i -g @hilbras/omnihilbras@latest</code>
            )}
            {version && (
              <button
                type="button"
                onClick={() => skip(version)}
                className="muted inline-flex items-center gap-1 text-[10px] transition-colors hover:text-text"
                title={`Do not tell me about v${version} again`}
              >
                <X className="h-3 w-3" aria-hidden="true" />
                Skip this version
              </button>
            )}
          </div>

          {state.status === 'available' && !canInstall && (
            <p className="muted mt-2 pl-4 text-[10px] leading-relaxed">
              {/* Why there is no install button here, said rather than implied. */}
              This build cannot replace itself. Update through the installer or the command above.
            </p>
          )}
        </>
      )}
    </div>
  );
}
