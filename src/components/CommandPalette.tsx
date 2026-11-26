import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { prefetchRoute } from '../lib/pageChunks';

export type CommandPaletteItem = {
  label: string;
  to: string;
  hint?: string;
};

/**
 * The V4 shell's command palette.
 *
 * Cmd/Ctrl+K is the one shortcut every operator already knows, and the dashboard has seventeen routes.
 * The palette is a real listbox rather than a search box that happens to navigate: focus moves with
 * the arrow keys, `aria-activedescendant` names the active row, Escape closes and the element that
 * opened it gets focus back. It is deliberately not a remote search — every entry is a route the
 * router already serves, so a result that does not exist cannot be shown.
 */
export function CommandPalette({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: readonly CommandPaletteItem[];
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => `${item.label} ${item.to} ${item.hint ?? ''}`.toLowerCase().includes(needle));
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery('');
    setActive(0);
    // Focus after the dialog exists; the input is the only focusable control until the list renders.
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      restoreRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [filtered.length, active]);

  if (!open) return null;

  const choose = (item: CommandPaletteItem | undefined) => {
    if (!item) return;
    onClose();
    navigate(item.to);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/45 px-4 pt-[12vh]" role="presentation" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-line-strong bg-bg shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={filtered[active] ? `command-palette-${active}` : undefined}
            aria-autocomplete="list"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
              if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => Math.min(filtered.length - 1, value + 1)); return; }
              if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); return; }
              if (event.key === 'Enter') { event.preventDefault(); choose(filtered[active]); }
            }}
            placeholder="Search pages and destinations"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted/70"
            aria-label="Search dashboard"
          />
          <kbd className="hidden rounded border border-line-strong px-1.5 py-0.5 font-mono text-[10px] text-muted sm:block">Esc</kbd>
        </div>
        <ul id="command-palette-list" role="listbox" aria-label="Dashboard destinations" className="max-h-[52vh] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-muted">No destination matches “{query.trim()}”.</li>
          ) : filtered.map((item, index) => (
            <li key={item.to} id={`command-palette-${index}`} role="option" aria-selected={index === active}>
              <button
                type="button"
                onMouseEnter={() => { setActive(index); prefetchRoute(item.to); }}
                onFocus={() => setActive(index)}
                onClick={() => choose(item)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] ${index === active ? 'bg-gold-soft text-gold-text' : 'text-text hover:bg-surface'}`}
              >
                <span className="min-w-0"><span className="block font-medium">{item.label}</span>{item.hint && <span className="muted mt-0.5 block truncate text-[11px]">{item.hint}</span>}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted">{item.to}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-line px-4 py-2 text-[10px] text-muted">↑ ↓ to move · Enter to open · Esc to close</div>
      </div>
    </div>
  );
}