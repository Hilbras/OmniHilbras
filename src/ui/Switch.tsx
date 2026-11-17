import type { ReactNode } from 'react';

/**
 * The dashboard's one on/off control.
 *
 * Measured before this existed — five hand-rolled switches, each a different design:
 *
 * | where | track | thumb | state colour |
 * | --- | --- | --- | --- |
 * | `ApiKeysPage` | `h-6 w-11` | `h-4.5`, `translate-x-[1.45rem]` | `bg-gold/70`, border `gold/50` |
 * | `SettingsPage` | `h-5 w-9` | `h-3.5`, animated **`left`** | `bg-gold/70`, border `gold/60` |
 * | `ProviderCard` | `h-6 w-11` | `h-4`, `translate-x-5` | `#f0643b` — a hard-coded orange no token defines |
 * | `AddProviderModal` | `h-6 w-11` | `h-4`, `translate-x-5` | the same hard-coded `#f0643b` |
 * | `EnabledSwitch` | `h-5 w-9` | `h-3.5`, `translate-x-[18px]` | `bg-success/30`, power glyph |
 *
 * Three defects were shared by all five, which is what a copy-pasted control buys: **no focus ring at all**, so a
 * keyboard user could not see which switch had focus; **no `motion-reduce`**, so every one animated whatever the
 * system asked; and `SettingsPage`'s animated `left`, which is a layout property — the same mistake that cost this
 * dashboard measurable frames when a remount was animated instead of a transform.
 *
 * The design decisions, stated so the next one does not drift:
 *
 * - **Transform, never layout.** The thumb moves with `translate-x` and `transition-transform`; `left` is a layout
 *   property and animating it lays out the row every frame.
 * - **Colour from tokens.** On is `gold`, off is `surface-2`, and the thumb is `text` in both states — a white-ish
 *   knob reads on either track, which is why the hard-coded orange was unnecessary as well as untokenised.
 * - **Focus uses the one treatment the app already has.** `index.css` defines `:focus-visible { outline: 2px solid
 *   gold; outline-offset: 3px }` globally, so this control re-states the same outline rather than introducing a
 *   second, box-shadow-based ring two pixels closer — and it must never set `outline-none` without putting one back,
 *   which is how the five copies manually removed the only focus indication the app has.
 * - **The accessible name carries the action, not the widget.** Callers pass `Pause X` / `Enable Y`; `role="switch"`
 *   plus `aria-checked` already announces the state.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  busy = false,
  title,
  className = '',
  glyph,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The account or setting and the action it performs, for a screen reader. */
  label: string;
  disabled?: boolean;
  /** A request is in flight: inert, and announced as busy rather than silently ignoring a click. */
  busy?: boolean;
  title?: string;
  /** Extra classes for the element itself — placement and z-index stay the caller's business. */
  className?: string;
  /** An optional mark drawn inside the track, for a control that must read as on/off without a caption. */
  glyph?: ReactNode;
}) {
  const inert = disabled || busy;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={inert}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full border transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'border-gold bg-gold' : 'border-line-strong bg-surface-2'} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none block h-4 w-4 rounded-full shadow-sm transition-transform duration-150 ease-out motion-reduce:transition-none ${checked ? 'translate-x-[19px] bg-bg' : 'translate-x-[2px] bg-text'}`}
      />
      {glyph && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute ${checked ? 'left-[5px] text-bg' : 'right-[5px] text-muted'}`}
        >
          {glyph}
        </span>
      )}
    </button>
  );
}
