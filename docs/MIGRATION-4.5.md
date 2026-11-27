# Migrating to 4.5.0

4.5 closes the product-surface slice: an installable offline shell, a two-language catalogue, an
automated accessibility floor, the design-system reference and a measured desktop decision. No API
changes; no migration step.

## PWA

The dashboard now registers `public/sw.js` in a production build. It caches the shell and answers a
navigation offline with the cached dashboard or `public/offline.html`. **It never caches `/v1` or
`/metrics`** — a cached measurement is the one thing this dashboard refuses to show.

## Languages

`src/i18n` carries English and Arabic catalogues. The locale comes from `navigator.language` for the
session; the provider sets `dir="rtl"` for Arabic. The catalogue is deliberately small and covers the
shell and the new spend labels; a missing message falls back to English and the parity test
(`tests/i18n.test.js`) fails on a gap.

## Accessibility

`tests/e2e/a11y.spec.ts` runs axe on `/dashboard`, `/dashboard/keys` and `/dashboard/usage` with
`wcag2a`/`wcag2aa`; serious and critical violations fail. The light-theme muted, gold-text, warning
and danger tokens were darkened to meet 4.5:1 against the tinted backgrounds, which is why the keys
visual baselines changed.

## Design system and desktop

`docs/design-system.md` states the tokens and rules. `docs/reports/desktop-packaging-decision-2026-11-27.md`
records the measured 275 MB Electron 45 distribution and the decision: trim/keep Electron for now, no
Tauri rewrite inside a capability release.


## 4.5.1

- The prompt registry has its dashboard page at `/dashboard/prompts`: create, append a version,
  activate an older one, remove, with the active content and its variables shown.
- The axe gate now runs on **every** dashboard page, not three; all seventeen pass with zero serious
  or critical findings.
