import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * One modal contract.
 *
 * The dashboard grew four dialog designs, three fake traffic-light headers, one focus trap and one
 * scroll lock. This is the shared shape: portal, labelled dialog, scroll lock, focus trap, focus
 * restore, Escape and backdrop gated by the same `busy` flag. The entry animation is the global
 * `[role=dialog][aria-modal]` rule in `index.css`, so every dialog moves the same way.
 */
export function Dialog({
  open,
  onClose,
  labelledBy,
  children,
  busy = false,
  className = '',
  backdropClassName = '',
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
  busy?: boolean;
  className?: string;
  backdropClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus.current?.focus({ preventScroll: true });
      previousFocus.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !ref.current) return;
      const focusable = ref.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      role="presentation"
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3 ${backdropClassName}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`w-full max-w-[520px] rounded-xl border border-line bg-surface p-4 shadow-2xl outline-none ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
