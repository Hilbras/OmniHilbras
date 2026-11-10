import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The renderer's only path to the gateway.
 *
 * The dashboard token is an admin credential. A browser renderer that held it could be made to leak
 * it by any script in the page, so the token stays in the main process and the renderer asks for a
 * path. That also removes CORS from the app: no browser origin reaches the gateway.
 */

export const dashboardTokenHeader = 'x-omnihilbras-dashboard-token';
// The gateway's default allowlist. The IPC client is not a browser, so this is a constant header
// rather than a policy — but it must be an allowlisted origin or the gateway refuses the call.
const DASHBOARD_ORIGIN = 'http://localhost:5173';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function dashboardTokenPath(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME?.trim();
  return join(configHome || join(homedir(), '.config'), 'omnihilbras', 'dashboard-token');
}

async function readToken() {
  try {
    return (await readFile(dashboardTokenPath(), 'utf8')).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Rejects anything that is not a gateway path. No absolute URLs, no traversal, no other hosts. */
export function assertGatewayPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Gateway requests must use a path beginning with /.');
  const url = new URL(path, 'http://127.0.0.1');
  if (url.origin !== 'http://127.0.0.1') throw new Error('Gateway requests must stay on the local gateway.');
  if (url.pathname.startsWith('//') || url.pathname.includes('..')) throw new Error('Gateway request path is invalid.');
  if (!url.pathname.startsWith('/v1/') && url.pathname !== '/health') throw new Error(`Gateway path ${url.pathname} is not allowed.`);
  return `${url.pathname}${url.search}`;
}

export function createGatewayClient({ host = '127.0.0.1', port }) {
  const portOf = typeof port === 'function' ? port : () => port;
  const base = () => `http://${host}:${portOf()}`;

  const headersFor = async (extra = {}) => {
    const token = await readToken();
    return {
      accept: 'application/json',
      ...extra,
      origin: DASHBOARD_ORIGIN,
      ...(token ? { [dashboardTokenHeader]: token } : {}),
    };
  };

  return {
    /**
     * One JSON request. The renderer receives the status and text and does its own parsing, so the
     * existing client's error shape survives unchanged.
     */
    async request({ method = 'GET', path, body } = {}) {
      const upper = String(method).toUpperCase();
      if (!ALLOWED_METHODS.has(upper)) throw new Error(`Gateway method ${method} is not allowed.`);
      const response = await fetch(`${base()}${assertGatewayPath(path)}`, {
        method: upper,
        headers: await headersFor(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(30_000),
      });
      return { ok: response.ok, status: response.status, text: await response.text() };
    },

    /**
     * A chat stream. Chunks arrive as text; the renderer keeps the SSE parser it already had.
     */
    async streamChat({ path = '/v1/chat/completions', body, signal } = {}) {
      const response = await fetch(`${base()}${assertGatewayPath(path)}`, {
        method: 'POST',
        headers: await headersFor({ 'content-type': 'application/json', accept: 'text/event-stream' }),
        body,
        ...(signal ? { signal } : {}),
      });
      return {
        ok: response.ok,
        status: response.status,
        stream: response.ok ? response.body : undefined,
        text: response.ok ? undefined : await response.text(),
      };
    },

    /** Subscribe to `/v1/logs/stream`; returns a function that closes the subscription. */
    async subscribeLogs(onEvent, { signal } = {}) {
      const response = await fetch(`${base()}/v1/logs/stream`, {
        headers: await headersFor({ accept: 'text/event-stream' }),
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`The gateway log stream answered ${response.status}.`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
              if (data) {
                try {
                  onEvent(JSON.parse(data));
                } catch {
                  // A frame that is not a record is skipped, not shown.
                }
              }
              boundary = buffer.indexOf('\n\n');
            }
          }
        } catch (error) {
          if (!signal?.aborted) onEvent({ streamError: error instanceof Error ? error.message : 'The log stream ended.' });
        }
      })();
      return () => reader.cancel().catch(() => undefined);
    },
  };
}
