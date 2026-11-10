import { useEffect, useRef } from 'react';
import { openGatewayLogStream, type GatewayLogEvent } from '../lib/gatewayClient';
import { useToast } from './Toast';

/**
 * A failed request, announced.
 *
 * ## Why the log stream
 *
 * The gateway already records every finished request and streams each one over
 * `GET /v1/logs/stream` — the same feed the Logs page renders. A failure that used to be visible only
 * if the operator happened to be reading that page is now a notification wherever they are. A
 * credential that can no longer be renewed surfaces here too, because in this gateway renewal happens
 * per request: the renewal fails, the request fails, the record names the code.
 *
 * ## Why not every event
 *
 * A provider outage produces a failure every few seconds; toasting each one would bury the page in
 * identical cards. So failures that share a provider and an error code inside a short window collapse
 * into the first toast — the stream, the Logs page and the usage records still hold every one of
 * them. Cancellations are not failures and never toast: stopping a request is an action, not an
 * error.
 */
export function FailureNotifications() {
  const { notify } = useToast();
  const recent = useRef(new Map<string, number>());

  useEffect(() => {
    const COLLAPSE_MS = 1500;
    let announcedDown = false;
    return openGatewayLogStream((event: GatewayLogEvent) => {
      if (event.outcome !== 'failure') return;
      const key = `${event.providerId ?? 'gateway'}:${event.errorCode ?? ''}`;
      const now = Date.now();
      for (const [seen, at] of recent.current) {
        if (now - at > COLLAPSE_MS) recent.current.delete(seen);
      }
      if (recent.current.has(key)) return;
      recent.current.set(key, now);
      const who = event.providerId ?? 'The gateway';
      const what = event.model ? ` (${event.model})` : '';
      const why = event.errorCode ? ` — ${event.errorCode}` : '';
      const after = event.attempts > 1 ? `, after ${event.attempts} attempts` : '';
      notify(`${who}${what} request failed${after}${why}`, 'error');
    }, (connected) => {
      // The feed can be unavailable for a real reason (built dashboard, refused origin, gateway down).
      // Saying so once is the difference between "quiet" and "silent".
      if (connected) announcedDown = false;
      else if (!announcedDown) {
        announcedDown = true;
        notify('Live failure feed unavailable. Failed requests will not be announced.', 'error');
      }
    });
  }, [notify]);

  return null;
}
