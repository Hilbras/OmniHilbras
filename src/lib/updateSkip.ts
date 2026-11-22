/**
 * The one place that knows how a dismissed update version is remembered.
 *
 * The hook displays the badge and the auto-prompt provider decides whether to ask; both must answer the
 * same question about a skipped version. A duplicate literal would let one of them forget a skip and pop
 * a dialog for a release the person already declined.
 *
 * `localStorage` holds a version *string*, nothing sensitive. The storage guard in
 * `tests/browser-storage.test.js` requires this key on its allowlist with a sentence saying what it holds.
 */
export const skippedVersionKey = 'omnihilbras.update.skipped';

export function readSkippedVersion(): string | undefined {
  try {
    return window.localStorage.getItem(skippedVersionKey)?.trim() || undefined;
  } catch {
    // Storage can be denied by the browser's settings; a preference that cannot be read is not an error.
    return undefined;
  }
}

export function writeSkippedVersion(version: string | undefined) {
  try {
    if (version) window.localStorage.setItem(skippedVersionKey, version);
    else window.localStorage.removeItem(skippedVersionKey);
  } catch {
    // The notice comes back next time, which is a cosmetic cost, not a failure.
  }
}
