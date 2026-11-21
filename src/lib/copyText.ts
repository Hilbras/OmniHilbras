import { desktopBridge } from './electronBridge';

/**
 * Copy text in every surface, and report only a write that actually happened.
 *
 * A packaged desktop page is served from `app://omnihilbras`, where `navigator.clipboard` is not
 * dependable — the buttons looked alive but nothing reached the OS clipboard. The Electron bridge owns
 * the clipboard there; a browser or a paired Android WebView keeps the standard API. A failed write is
 * returned as `false` so a button can say "could not copy" rather than pretending it worked.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof text !== 'string' || !text) return false;
  const bridge = desktopBridge();
  if (bridge?.clipboard) {
    try {
      return await bridge.clipboard.writeText(text) === true;
    } catch {
      return false;
    }
  }
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
