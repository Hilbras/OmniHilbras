# Explicit update prompts — 3.93.0

## Why

The desktop updater already detected, downloaded and installed releases, but the two decisions were
implicit. Download had no question at all; install used a native `window.confirm` that only mentioned
the missing signing key, and only one of the two surfaces remembered to call it. The OS notification
even pointed at About, where no update controls exist.

## What changed

- `src/components/UpdatePromptProvider.tsx` owns one accessible in-app dialog and asks on the
  `available` and `downloaded` transitions. Accepting an automatic question runs the download or install
  through `src/lib/updateActions.ts`; declining records the version so the dialog does not reopen, but
  leaves the sidebar badge for a manual retry. Nothing is skipped.
- `src/lib/useUpdateState.ts` routes its manual `download`/`install` actions through the same questions.
  `src/pages/SettingsPage.tsx` and `src/components/UpdateIndicator.tsx` now call those actions instead of
  the bridge directly, so there is no second consent path.
- The install question carries the main process's `trustReason` when the build is unsigned, replacing the
  native confirm. The `allowUnsigned` gate in `desktop/main.mjs` is unchanged.
- Per-version skip storage moved to `src/lib/updateSkip.ts`, shared by the badge and the auto-prompt so
  they cannot disagree about a skipped release.
- The update popup leaves Escape to the stacked consent dialog instead of closing both at once.

## Verification

`pnpm verify`, the full Playwright suite (including two new fake-bridge cases in
`tests/e2e/update-prompt.spec.ts`), `tests/update-prompt.test.js`, and the rewritten
`tests/update-consent.test.js`. No real update was downloaded or installed during verification.

## Out of scope

Feed format, installer signing, per-platform install commands, time-based snooze, and the browser notice.
