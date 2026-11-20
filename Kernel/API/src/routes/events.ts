import type { RouteContext } from './route-context.js';

const eventsPath = '/v1/events';

/**
 * `GET /v1/events`: a live change-notification channel for the dashboard (Phase 4).
 *
 * The dashboard used to poll `/v1/connections` every 4 s to notice a connection or health change. This
 * replaces the *wait* with a push: the route polls the gateway's own cheap, secret-free `stateFingerprint()`
 * once a second and emits a tiny event only when that fingerprint changes. The client still refetches the
 * actual data (and keeps its poll as a fallback) — this channel never carries connections, credentials or
 * usage content, only "something changed, refresh".
 *
 * Why server-side change detection instead of an event emitter on every mutation: it also catches changes
 * that do not come through a route (the periodic health monitor, a token renewal, a store write from a
 * different code path) without instrumenting each one. A fingerprint is in-memory only and never probes a
 * provider, so its cost is a JSON.stringify a second — no upstream request, no credential decryption.
 *
 * Backpressure mirrors `/v1/logs/stream`: `write` returning false means a slow browser, and dropping a
 * notification is safe because the client's fallback poll will catch the next change. A heartbeat keeps
 * proxies from treating an idle stream as dead.
 */
export async function handleEventsRoute(context: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, signal } = context;
  if (request.method !== 'GET' || url.pathname !== eventsPath) return false;

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
  });
  response.flushHeaders();
  response.write(': connected\n\n');

  let writable = true;
  response.on('drain', () => { writable = true; });
  const send = (payload: Record<string, unknown>) => {
    if (!writable || response.writableEnded) return;
    writable = response.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let last: string | undefined;
  let inFlight = false;
  const check = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const next = await service.stateFingerprint();
      if (last !== undefined && next !== last) send({ type: 'state', at: new Date().toISOString() });
      last = next;
    } catch {
      // A store read failing must not kill a live stream; the next tick retries.
    } finally {
      inFlight = false;
    }
  };

  // Send the initial fingerprint without a notification (the client has just loaded its data).
  await check();
  const poll = setInterval(() => { void check(); }, 1000);
  poll.unref();
  const heartbeat = setInterval(() => {
    if (!writable || response.writableEnded) return;
    writable = response.write(': keep-alive\n\n');
  }, 15_000);
  heartbeat.unref();

  const finish = () => {
    clearInterval(poll);
    clearInterval(heartbeat);
  };
  signal.addEventListener('abort', finish, { once: true });
  response.on('close', finish);
  return true;
}
