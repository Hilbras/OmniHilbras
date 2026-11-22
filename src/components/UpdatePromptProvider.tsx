import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '../ui/Dialog';
import { desktopBridge, type UpdateState } from '../lib/electronBridge';
import { readSkippedVersion } from '../lib/updateSkip';
import { runUpdateDownload, runUpdateInstall } from '../lib/updateActions';
import { useToast } from './Toast';

/**
 * The two decisions in an update, asked in one place.
 *
 * The main process already owns detection, download and install; it reports every transition on
 * `update:state`. What it cannot do is ask a person. Both the sidebar popup and Settings used to reach
 * the bridge directly, and only one of them remembered to warn about an unsigned installer. This
 * provider owns both questions: one dialog, one set of buttons, and one answer for every surface.
 *
 * The dialogs open on the `available` and `downloaded` transitions — not on a click — because that is
 * what "tell me when there is an update" means. A per-version record keeps a progress broadcast from
 * reopening them, and a decline is remembered only until the user asks again from the badge or
 * Settings; nothing is skipped by declining.
 */

type PromptKind = 'download' | 'install';
type Pending = { kind: PromptKind; state: UpdateState; automatic: boolean; resolve: (accepted: boolean) => void };

export type UpdateConsent = {
  confirmDownload: (state: UpdateState | undefined) => Promise<boolean>;
  confirmInstall: (state: UpdateState | undefined) => Promise<boolean>;
  /** A manual button press is a fresh request, even if the automatic question was declined. */
  clearDecline: (kind: PromptKind) => void;
  /** Lets an already-open update popup leave Escape to this dialog instead of closing both. */
  promptOpen: boolean;
};

const UpdateConsentContext = createContext<UpdateConsent | undefined>(undefined);

export function useUpdateConsent(): UpdateConsent {
  const value = useContext(UpdateConsentContext);
  if (!value) throw new Error('Update consent provider is missing from the dashboard root.');
  return value;
}

export function UpdatePromptProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | undefined>();
  const pendingRef = useRef<Pending | undefined>(undefined);
  const prompted = useRef<Partial<Record<PromptKind, string>>>({});
  const declined = useRef<Partial<Record<PromptKind, string>>>({});

  const { notify } = useToast();

  const ask = useCallback((kind: PromptKind, state: UpdateState | undefined, automatic: boolean): Promise<boolean> => {
    if (!state) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      // A second question supersedes the first; its caller is told "no" rather than left waiting.
      pendingRef.current?.resolve(false);
      const next = { kind, state, automatic, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const answer = useCallback((accepted: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = undefined;
    setPending(undefined);
    if (!accepted && current?.state.version) declined.current[current.kind] = current.state.version;
    current?.resolve(accepted);
    // An automatic question has no caller waiting to do the work: accepting it *is* the instruction to
    // download or install. A manual button's caller runs the bridge call after this promise resolves,
    // so running it here as well would pay for the same update twice.
    if (accepted && current?.automatic) {
      const action = current.kind === 'download' ? runUpdateDownload() : runUpdateInstall(current.state);
      void action.catch((error: unknown) => {
        notify(error instanceof Error ? error.message : 'The update action failed.', 'error');
      });
    }
  }, [notify]);

  const clearDecline = useCallback((kind: PromptKind) => {
    declined.current[kind] = undefined;
  }, []);

  const value = useMemo<UpdateConsent>(() => ({
    confirmDownload: (state) => ask('download', state, false),
    confirmInstall: (state) => ask('install', state, false),
    clearDecline,
    promptOpen: pending !== undefined,
  }), [ask, clearDecline, pending]);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return; // A browser can read about a release but cannot download or install it.
    let active = true;
    const apply = (next: UpdateState) => {
      if (!active) return;
      if (next.status === 'idle' || next.status === 'current') {
        prompted.current = {};
        declined.current = {};
        return;
      }
      // A build that cannot replace itself has no install question to ask. Its badge still points at
      // the release page, which is the honest alternative already built into the indicator.
      if (!next.canInstall || !next.version || next.version === readSkippedVersion()) return;
      if (next.status === 'available' && prompted.current.download !== next.version && declined.current.download !== next.version) {
        prompted.current.download = next.version;
        void ask('download', next, true);
      }
      if (next.status === 'downloaded' && prompted.current.install !== next.version && declined.current.install !== next.version) {
        prompted.current.install = next.version;
        void ask('install', next, true);
      }
    };
    void bridge.updates.getState().then(apply);
    const off = bridge.updates.onState(apply);
    return () => { active = false; off(); };
  }, [ask]);

  const kind = pending?.kind;
  const version = pending?.state.version;
  const installMethod = pending?.state.installMethod;
  const titleId = 'update-prompt-title';

  return (
    <UpdateConsentContext.Provider value={value}>
      {children}
      <Dialog open={pending !== undefined} onClose={() => answer(false)} labelledBy={titleId} className="max-w-[440px]">
        <h2 id={titleId} className="text-sm font-semibold">
          {kind === 'download' ? 'Update available' : 'Update downloaded'}
        </h2>
        <p className="muted mt-2 text-xs leading-relaxed">
          {kind === 'download'
            ? `Version ${version ?? ''} is available. Download it now?`
            : `Version ${version ?? ''} has been downloaded. ${installMethod === 'deb' ? 'Open the installer to continue.' : 'Install it and restart now?'}`}
        </p>
        {kind === 'install' && pending?.state.signed === false && (
          <p role="note" className="mt-3 rounded-lg border border-gold/25 bg-gold-soft p-2.5 text-[11px] leading-relaxed text-gold-text">
            {pending.state.trustReason ?? 'This update cannot be verified.'}
            {' '}Install only if you trust this release.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => answer(false)} className="rounded-md px-3 py-2 text-xs font-semibold text-muted hover:bg-bg-soft hover:text-text">
            Not now
          </button>
          <button type="button" onClick={() => answer(true)} className="btn-gold !px-3 !py-2 !text-xs">
            {kind === 'download' ? 'Download' : installMethod === 'deb' ? 'Open installer' : 'Install and restart'}
          </button>
        </div>
      </Dialog>
    </UpdateConsentContext.Provider>
  );
}
