import { useCallback, useEffect, useRef, useState } from 'react';
import { gatewayBase, isGatewayReachable, onGatewayReachabilityChange } from './gatewayClient';

/**
 * Whether the gateway is answering, and a way to hear that it started again.
 *
 * Two things this fixes, both of which bit repeatedly:
 *
 * **The badge used to be hardcoded.** The sidebar said "Gateway online" because that string
 * was in the markup, not because anything had been asked. So during a gateway outage the
 * dashboard confidently reported the one thing that was false.
 *
 * **A page that rendered the offline error never recovered.** It fetched once on mount, the
 * fetch failed, and the message stayed — even after the gateway came back seconds later. The
 * only way out was a manual reload, which is the wrong instinct when the fix is "nothing, it
 * already recovered". Nothing was watching, because a page that had failed made no further
 * requests to notice a change.
 *
 * So this polls. `/v1/connections` answers in about five milliseconds, so the poll is free,
 * and it is the only way a page that has already failed can learn it stopped failing.
 */
const POLL_MS = 4_000;

export type GatewayState = {
  /** `undefined` until the first probe answers — "not known yet", not "up". */
  reachable: boolean | undefined;
  /** Ticks once each time the gateway comes back after being down. */
  restoredAt: number | null;
  /** Probes immediately, rather than waiting out the interval. */
  checkNow: () => void;
};

/** Dispatched on the window when the gateway returns, so any page can reload its data. */
export const GATEWAY_RESTORED_EVENT = 'omnihilbras:gateway-restored';

export function useGatewayStatus(): GatewayState {
  const [reachable, setReachable] = useState<boolean | undefined>(() => isGatewayReachable());
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const wasDown = useRef(false);

  const checkNow = useCallback(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Absolute, because the gateway is on a different port from the dashboard: a
        // relative `/v1/connections` reaches Vite, which answers with the app's own HTML —
        // that parses as a 200 and would report the gateway as up while it is down.
        const response = await fetch(`${gatewayBase}/v1/connections`, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });
        if (cancelled) return;
        setReachable(response.ok);
        if (!response.ok) wasDown.current = true;
        else if (wasDown.current) {
          // Only announce a *restoration*, never the first success — otherwise every page
          // load would fire the event and every listener would refetch for no reason.
          wasDown.current = false;
          setRestoredAt(Date.now());
          if (typeof window !== 'undefined') window.dispatchEvent(new Event(GATEWAY_RESTORED_EVENT));
        }
      } catch {
        if (cancelled) return;
        setReachable(false);
        wasDown.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onChange = onGatewayReachabilityChange((next) => {
      setReachable(next);
      if (next && wasDown.current) {
        wasDown.current = false;
        setRestoredAt(Date.now());
        if (typeof window !== 'undefined') window.dispatchEvent(new Event(GATEWAY_RESTORED_EVENT));
      }
    });
    const timer = window.setInterval(checkNow, POLL_MS);
    checkNow();
    return () => {
      onChange();
      window.clearInterval(timer);
    };
  }, [checkNow]);

  return { reachable, restoredAt, checkNow };
}

/**
 * Re-runs a loader when the gateway comes back.
 *
 * A page that failed to load has no other way to try again, and a page that loaded fine
 * should refresh anyway — its data was fetched while the gateway was in whatever state it was
 * in, and the whole point of the event is that this is worth redoing.
 */
export function useGatewayReload(loader: () => void, deps: readonly unknown[] = []): void {
  const latest = useRef(loader);
  latest.current = loader;
  useEffect(() => {
    const onRestored = () => latest.current();
    window.addEventListener(GATEWAY_RESTORED_EVENT, onRestored);
    return () => window.removeEventListener(GATEWAY_RESTORED_EVENT, onRestored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
