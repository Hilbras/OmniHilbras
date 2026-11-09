import type { RouteContext } from './route-context.js';

const logStreamPath = '/v1/logs/stream';

/**
 * `GET /v1/logs/stream`: each finished request, as it is recorded, as a server-sent event.
 *
 * It carries the usage record's fields and nothing else. The store refuses message, prompt and content fields when
 * it writes, so a line shows what happened without showing what was said. The route sits behind the management gate,
 * because even these fields describe what the gateway is doing for whom.
 */
export async function handleLogsRoute(context: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, signal } = context;
  if (request.method !== 'GET') return false;
  if (url.pathname === logStreamPath) {
    // fall through to the stream below
  } else {
    return false;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
  });
  response.flushHeaders();
  response.write(': connected\n\n');

  // A push stream has no pull to slow it down. `write` returning false means the socket buffer is
  // full; recording that and dropping events until `drain` keeps a stalled browser from growing this
  // process's memory without bound. A log line is the one thing it is acceptable to lose.
  let writable = true;
  response.on('drain', () => { writable = true; });
  const stop = service.onUsageRecorded((record) => {
    if (!writable || response.writableEnded) return;
    writable = response.write(`data: ${JSON.stringify(record)}\n\n`);
  });
  // Comment frames keep path proxies from treating an idle stream as dead.
  const heartbeat = setInterval(() => {
    if (!writable || response.writableEnded) return;
    writable = response.write(': keep-alive\n\n');
  }, 15_000);
  heartbeat.unref();
  const finish = () => {
    clearInterval(heartbeat);
    stop();
  };
  signal.addEventListener('abort', finish, { once: true });
  response.on('close', finish);
  return true;
}
