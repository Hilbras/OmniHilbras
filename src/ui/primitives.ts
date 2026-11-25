/**
 * The variants that were being spelled out by hand, and how often.
 *
 * Measured before this file existed: `border-success/20 bg-success/10 text-success` appeared **7 times**,
 * `border-gold/30 bg-gold-soft text-gold-text` **11**, `border-danger/25 bg-danger/10 text-danger` **12**. Thirty
 * copies of three decisions, each one a place where a change of tone (a new token name, a warmer success colour)
 * has to be made three dozen times or drift.
 *
 * A component library would be the wrong answer here. The dashboard already has primitives in `index.css`
 * (`btn-gold`, `btn-ghost`, `card`, `input`, `muted`) built on Tailwind-4 custom properties, and rebuilding those
 * in TypeScript would be a second system to keep in step. This is the smaller thing: the class *strings* that carry
 * a decision, named once. `tests/frontend-upgrade.test.js` fails if a page spells one out again.
 */

/** Tone → the border, fill and text that carry it. */
export const badgeTone = {
  /** Something worked and was checked. */
  ok: 'border-success/20 bg-success/10 text-success',
  /** Something needs attention but is not broken. */
  warn: 'border-gold/30 bg-gold-soft text-gold-text',
  /** Something failed, or needs a person. */
  bad: 'border-danger/25 bg-danger/10 text-danger',
  /** No claim either way: unmeasured, unset, or informational. */
  neutral: 'border-line-strong bg-surface text-muted',
} as const;

/** The pill every badge in the dashboard draws itself with. */
export const badgeBase = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px]';
