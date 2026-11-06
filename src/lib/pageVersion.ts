/**
 * The version of the checkout this page was served from.
 *
 * Read from a virtual module rather than `package.json`: the manifest is not part of the browser
 * module graph, and this value is what lets the sidebar say whether the gateway answering it is
 * running the code in front of us.
 *
 * It was first done with a build-time `define`, which does **not** reach a dev-served source module —
 * the identifier survived the transform untouched, so guarding it was guarding something that was
 * genuinely undefined and the sidebar threw. A blank dashboard, from a value used only for a
 * comparison. The virtual module resolves the same way in dev and in a build, and in development the
 * drift check matters most: the page is served from source while the gateway runs from `dist`.
 */
import { version } from 'virtual:omnihilbras-version';

export const PAGE_VERSION: string = version || 'unknown';