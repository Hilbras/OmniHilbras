/**
 * Clipboard write with a fallback for browsers without the async API.
 *
 * The write is awaited and every failure (no permission, insecure context,
 * a blocked clipboard) is reported as `false` instead of an exception: the
 * callers only need to know whether the text made it.
 */
export async function copyToClipboard(text) {
  try {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }

    const doc = typeof document !== "undefined" ? document : null;
    if (!doc?.body) return false;

    const textarea = doc.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    doc.body.appendChild(textarea);
    textarea.select();
    const copied = doc.execCommand("copy");
    doc.body.removeChild(textarea);
    return copied !== false;
  } catch {
    // A blocked or unavailable clipboard is a normal failure, not a crash.
    return false;
  }
}
