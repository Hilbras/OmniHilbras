import { Power } from 'lucide-react';
import { Switch } from '../ui/Switch';

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
    <Switch
      checked={enabled}
      onChange={() => onToggle()}
      label={label}
      busy={busy}
      // The power glyph is what makes the control readable without a caption, which is the one thing this component
      // adds to the shared switch.
      glyph={<Power className="h-2.5 w-2.5" aria-hidden="true" />}
    />
  );
}
