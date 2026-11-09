import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CheckCircle2, Info, X } from 'lucide-react';

/**
 * Notifications, app-wide.
 *
 * ## Why a toast rather than a banner in the page
 *
 * A banner is attached to the page that produced it, so a failure that happens while the user is
 * scrolled into a long provider form appears somewhere they are not looking — or pushes the layout
 * down under their cursor as they click. Measured on the Kiro card: a `403` from a reconnect attempt
 * rendered as a strip above the fold, and the user reported "nothing happened".
 *
 * A toast is attached to the viewport. It cannot be missed, it does not move the page, and it stacks,
 * so three failures in a row are three visible facts rather than one that overwrote the last.
 *
 * ## What this deliberately does not do
 *
 * It does not swallow errors into a toast and leave the page looking fine. A page that *cannot load*
 * still says so inline (`role="alert"` in its own markup), because a notification that disappears after
 * five seconds is the wrong place to explain why the screen is empty. Toasts are for **outcomes of
 * actions** — save, connect, test, refresh — and inline text is for **state the page is in**.
 */

export type ToastTone = 'success' | 'error' | 'info';

export type Toast = {
  id: number;
  message: string;
  tone: ToastTone;
};

type ToastContextValue = {
  notify: (message: string, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
  toasts: readonly Toast[];
};

const ToastContext = createContext<ToastContextValue | null>(null);

/** How long a toast stays. Errors are given longer, because they carry a reason worth reading. */
const DURATION_MS: Record<ToastTone, number> = { success: 4_000, info: 5_000, error: 8_000 };

/** At most this many on screen; the oldest is dropped so a loop of failures cannot bury the page. */
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback((message: string, tone: ToastTone = 'success') => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message: trimmed, tone }].slice(-MAX_VISIBLE));
    timers.current.set(id, setTimeout(() => dismiss(id), DURATION_MS[tone]));
  }, [dismiss]);

  // Timers outlive a toast that was pushed out by MAX_VISIBLE, so they are cleared on unmount.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo(() => ({ notify, dismiss, toasts }), [notify, dismiss, toasts]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const TONE_STYLES: Record<ToastTone, { container: string; Icon: typeof CircleAlert }> = {
  success: { container: 'border-success/30 bg-success/10 text-success', Icon: CheckCircle2 },
  error: { container: 'border-danger/30 bg-danger/10 text-danger', Icon: CircleAlert },
  info: { container: 'border-line bg-surface text-text', Icon: Info },
};

function ToastViewport({ toasts, onDismiss }: { toasts: readonly Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      // `aria-live` on the container, so a toast is announced without stealing focus. `polite` rather
      // than `assertive`: an error must be surfaced, but interrupting the user mid-word is its own fault.
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 top-3 z-[70] flex flex-col items-center gap-2 px-3 sm:inset-x-auto sm:right-4 sm:top-4 sm:items-end"
    >
      {toasts.map((toast) => {
        const { container, Icon } = TONE_STYLES[toast.tone];
        return (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl border px-3.5 py-3 text-xs shadow-lg backdrop-blur ${container}`}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 leading-relaxed break-words">{toast.message}</p>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss notification"
              className="-mr-1 -mt-1 rounded-md p-1 opacity-60 transition-opacity hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The only way a page reports an outcome.
 *
 * Deliberately not optional: a component outside the provider would be a silent failure — the error
 * would vanish entirely — so it throws rather than returning a no-op.
 */
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider.');
  return context;
}
