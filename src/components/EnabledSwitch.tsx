import { Power } from 'lucide-react';

/**
 * The control that turns one account on and off.
 *
 * **Icon only, no caption.** The row it sits in already says which account it is, and the switch's own
 * position says the state: right is on, left is off, and an off switch is drawn dark. A word beside it
 * ("Enabled"/"Disabled") was a third statement of the same fact in a row that already carries a name, a
 * credential kind and a latency — and it is the one a reader can see without being told.
 *
 * The state still has to reach a reader who cannot see it, so the **accessible name** carries both the
 * account and the state, and changes with it: `Disable account 2 …` while it is on, `Enable account 2 …`
 * while it is off. That is also why this is `role="switch"` with `aria-checked` rather than a button
 * whose label happens to flip — a screen reader announces on/off, not a promise about what a click does.
 *
 * Both surfaces that show it — the Connections card and the accounts panel — render this one component
 * against the same `enabled` fact.
 */
export function EnabledSwitch({
  enabled,
  busy = false,
  onToggle,
  label,
}: {
  enabled: boolean;
  /** A call is in flight; the switch is inert until the gateway answers. */
  busy?: boolean;
  onToggle: () => void;
  /** The account and the action, for a screen reader. */
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      disabled={busy}
      onClick={onToggle}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-wait disabled:opacity-50 ${enabled ? 'border-success/40 bg-success/30' : 'border-line-strong bg-black/60'}`}
    >
      <span
        className={`block h-3.5 w-3.5 rounded-full shadow-sm transition-transform ${enabled ? 'translate-x-[18px] bg-text' : 'translate-x-[2px] bg-muted'}`}
        aria-hidden="true"
      />
      {/* The power glyph lives in the track, so the control is recognisable without a caption. */}
      <Power className={`pointer-events-none absolute h-2.5 w-2.5 ${enabled ? 'left-1 text-success' : 'right-1 text-muted/70'}`} aria-hidden="true" />
    </button>
  );
}