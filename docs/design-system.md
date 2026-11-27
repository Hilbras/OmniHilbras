# The dashboard's design system

The dashboard's visual language is a small set of tokens and rules, not a component library. This
page states what exists so a new page can use it instead of inventing a fourth shade of grey.

## Tokens

Defined once in `src/index.css` under `:root` and `[data-theme="dark"]`:

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--bg` | `#faf9f5` | `#0c0b09` | the page |
| `--surface` | `#ffffff` | `#15130e` | cards, panels |
| `--surface-2` | `#f7f4ec` | `#1b1812` | inputs, inset rows |
| `--text` | `#17150f` | `#f2efe6` | primary text |
| `--muted` | `#6f6857` | `#9c9584` | secondary text |
| `--gold` | `#d4af37` | `#e2bd52` | the one accent, for the active/primary action |

`--line` and `--line-strong` carry borders; `--success`, `--warn` and `--bad` carry state. A colour
that is not one of these is a local decision that should say why it exists.

## Rules

- **The accent is not decoration.** Gold marks the primary action or the current state; a second
  gold thing on the same screen means neither is primary.
- **A measured value is labelled.** A card may show `—` or "unpriced"; it may not show an invented
  number. This is the same rule `tests/provider-card-honesty.test.js` enforces.
- **Opacity is not blur.** A sticky header is opaque; a `backdrop-filter` behind scrolling content
  re-samples every frame and `tests/ui-performance.test.js` fails on it.
- **Focus is visible.** `:focus-visible` is defined globally; a custom control keeps it.
- **Motion is opt-in.** Animations live inside `prefers-reduced-motion: no-preference`, and a
  reduced-motion user gets the final state rather than a faster animation.
- **Density is one step.** Rows use the `text-[11px]`/`text-[13px]` pairs already in the pages;
  a new scale is a design change, not a styling choice.
- **Right-to-left works.** Layout uses logical properties (`ps-*`, `me-*`, `text-start`) where a
  direction matters; the Arabic catalogue in `src/i18n` exists to prove it.

## Not here yet

A component library, a spacing scale beyond the four values in use, and a documented chart palette.
Adding them is a design decision with a page to prove it, not a refactor.
