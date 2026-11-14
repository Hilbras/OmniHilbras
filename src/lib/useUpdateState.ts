import { useCallback, useEffect, useRef, useState } from 'react';
import { version as repoVersion } from 'virtual:omnihilbras-version';
import { desktopBridge, type UpdateState } from './electronBridge';
import { compareVersions } from './versionCompare.mjs';

/**
 * One answer to "is there a newer version?", wherever the dashboard is running.
 *
 * Two sources, because the two builds can do different things:
 *
 * - **The desktop app** has a real updater. The main process owns it — it checks on launch and on a timer,
 *   knows whether this platform can replace itself, and reports progress — so the dashboard *subscribes*
 *   to that state rather than duplicating any of it. Anything else would be a second opinion about a fact
 *   the main process already has.
 * - **A browser** has no updater. It can still find out, by asking GitHub for the newest release, and it
 *   must then say what it *cannot* do: install. That is why the surface for a browser offers the release
 *   page and the install command, never a button that would silently do nothing.
 *
 * ## What this deliberately does not copy from the reference implementation
 *
 * Theirs checked **once**, 2.5 s after mount, and never again — so a tab left open learned about a release
 * only by being reloaded, and their badge could not be dismissed at all, reappearing on every load. Here:
 * a periodic re-check plus one on focus, and a skip that is remembered **per version**, so skipping 3.49.0
 * does not hide 3.50.0.
 */

/** How the surface should read, whichever source produced it. */
export type UpdateView = UpdateState & {
  source: 'desktop' | 'github';
  /** Present for a browser, which cannot install: where the person can go instead. */
  releaseUrl?: string;
};

const GITHUB_LATEST_RELEASE = 'https://api.github.com/repos/Hilbras/OmniHilbras/releases/latest';
const RELEASE_PAGE = 'https://github.com/Hilbras/OmniHilbras/releases/latest';

/** How long a browser's answer is trusted before asking again. */
const RELEASE_CACHE_MS = 6 * 60 * 60 * 1000;
/** And how often focusing the tab may trigger a fresh ask. */
const REFOCUS_MIN_INTERVAL_MS = 30 * 60 * 1000;
/** A slow registry must never hold up the UI, so the request is abandoned rather than awaited forever. */
const RELEASE_TIMEOUT_MS = 4_000;

/**
 * The version a person asked not to be told about again.
 *
 * `localStorage` rather than the database: it is a per-browser display preference about a version *string*,
 * holds nothing sensitive, and losing it costs one repeated notice. The storage guard in
 * `tests/browser-storage.test.js` requires this key on its allowlist with a sentence saying what it holds —
 * this is that key.
 */
const skippedVersionKey = 'omnihilbras.update.skipped';

function readSkippedVersion(): string | undefined {
  try {
    return window.localStorage.getItem(skippedVersionKey)?.trim() || undefined;
  } catch {
    // Storage can be denied by the browser's settings; a preference that cannot be read is not an error.
    return undefined;
  }
}

function writeSkippedVersion(version: string | undefined) {
  try {
    if (version) window.localStorage.setItem(skippedVersionKey, version);
    else window.localStorage.removeItem(skippedVersionKey);
  } catch {
    // Same: the notice comes back next time, which is a cosmetic cost, not a failure.
  }
}

/** A module-level cache, so several components mounting at once make one request. */
let releaseCache: { at: number; state: UpdateState } | undefined;
let inFlight: Promise<UpdateState> | undefined;

async function fetchLatestRelease(): Promise<UpdateState> {
  const now = Date.now();
  if (releaseCache && now - releaseCache.at < RELEASE_CACHE_MS) return releaseCache.state;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(GITHUB_LATEST_RELEASE, {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const body = (await response.json()) as { tag_name?: string; html_url?: string };
      const latest = body.tag_name?.trim();
      if (!latest) throw new Error('the release has no tag');
      const state: UpdateState = compareVersions(latest, repoVersion) > 0
        ? { status: 'available', version: latest.replace(/^v/i, ''), canInstall: false }
        : { status: 'current' };
      releaseCache = { at: Date.now(), state };
      return state;
    } catch (error) {
      /**
       * A failed check is reported as a failed check. The reference implementation swallowed it and
       * rendered "up to date" — a claim it had no basis for, which is the same class of dishonesty as a
       * green tick from a request nobody made.
       */
      const state: UpdateState = { status: 'error', reason: error instanceof Error ? error.message : 'the update check failed' };
      releaseCache = { at: Date.now(), state };
      return state;
    } finally {
      inFlight = undefined;
    }
  })();

  return inFlight;
}

export { compareVersions };

export function useUpdateState() {
  const bridge = desktopBridge();
  const [state, setState] = useState<UpdateState | undefined>(bridge ? undefined : { status: 'idle' });
  const [skipped, setSkipped] = useState<string | undefined>(() => readSkippedVersion());
  const checkedAtRef = useRef(0);

  // Desktop: the main process is the source of truth. Subscribe rather than ask on a timer, because it
  // already has a timer and two clocks would disagree about when the last check happened.
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.updates.getState().then((next) => {
      if (active) setState(next);
    });
    const off = bridge.updates.onState((next) => setState(next));
    return () => {
      active = false;
      off();
    };
  }, [bridge]);

  // Browser: ask GitHub, then keep asking — periodically, and when the tab comes back into view.
  useEffect(() => {
    if (bridge) return;
    let active = true;
    const ask = async () => {
      checkedAtRef.current = Date.now();
      const next = await fetchLatestRelease();
      if (active) setState(next);
    };
    void ask();

    const timer = window.setInterval(() => {
      // The cache makes this cheap: a re-check inside its window returns the stored answer without a request.
      void ask();
    }, RELEASE_CACHE_MS);

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - checkedAtRef.current < REFOCUS_MIN_INTERVAL_MS) return;
      void ask();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [bridge]);

  const skip = useCallback((version: string | undefined) => {
    writeSkippedVersion(version);
    setSkipped(version);
  }, []);

  /**
   * The two actions only the desktop can perform.
   *
   * Exposed here rather than reached for directly by the component, so there is one place that knows what
   * this build can do — and so a browser, which has no `download` at all, gets an `undefined` it can test
   * instead of a function that would fail at the click.
   */
  const download = useCallback(async () => {
    if (!bridge) return undefined;
    const next = await bridge.updates.download();
    if (next) setState(next);
    return next;
  }, [bridge]);

  const install = useCallback(async (options?: { allowUnsigned?: boolean }) => {
    if (!bridge) return;
    // `install` returns nothing: the main process relaunches, and progress arrives as events on the
    // subscription above. Anything this returned would be a state the app is about to stop existing in.
    await bridge.updates.install(options);
  }, [bridge]);

  const check = useCallback(async () => {
    if (bridge) {
      const next = await bridge.updates.check();
      setState(next);
      return next;
    }
    releaseCache = undefined;
    const next = await fetchLatestRelease();
    setState(next);
    return next;
  }, [bridge]);

  const version = state?.version;
  // A skipped version stays quiet until a *different* one arrives — which is why the skip stores the
  // version and not a boolean.
  const visible = state !== undefined && !(state.status === 'available' && version !== undefined && version === skipped);

  return {
    state: visible ? state : undefined,
    raw: state,
    source: bridge ? ('desktop' as const) : ('github' as const),
    skipped,
    skip,
    check,
    download: bridge ? download : undefined,
    install: bridge ? install : undefined,
    releaseUrl: RELEASE_PAGE,
    currentVersion: repoVersion,
    canInstall: Boolean(bridge && state?.canInstall),
  };
}
