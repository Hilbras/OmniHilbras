import { useEffect, useState } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { desktopBridge } from '../lib/electronBridge';

/**
 * Window controls for the frameless desktop window.
 *
 * The app header is the title bar, so the operating system's title bar is one less bar above the
 * navigation. macOS keeps its traffic lights and renders nothing here; Linux and Windows get these
 * controls at the right edge of the same header.
 *
 * Every button is `window-no-drag`: the header around them is a drag region, and a control inside a
 * drag region cannot be clicked.
 */
export function WindowControls() {
  const bridge = desktopBridge();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge || bridge.platform === 'darwin') return;
    let active = true;
    void bridge.windowControls.isMaximized().then((value) => {
      if (active) setMaximized(value);
    });
    const off = bridge.windowControls.onMaximized(setMaximized);
    return () => {
      active = false;
      off();
    };
  }, [bridge]);

  if (!bridge || bridge.platform === 'darwin') return null;

  return (
    <div className="window-no-drag ml-1 flex items-center gap-0.5 border-l border-line/70 pl-2">
      <button type="button" aria-label="Minimize window" title="Minimize" onClick={() => bridge.windowControls.minimize()} className="grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-bg-soft hover:text-text">
        <Minus className="h-4 w-4" aria-hidden="true" />
      </button>
      <button type="button" aria-label={maximized ? 'Restore window' : 'Maximize window'} title={maximized ? 'Restore' : 'Maximize'} onClick={() => bridge.windowControls.toggleMaximize()} className="grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-bg-soft hover:text-text">
        {maximized ? <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />}
      </button>
      <button type="button" aria-label="Close window" title="Close" onClick={() => bridge.windowControls.close()} className="grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-danger/15 hover:text-danger">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
