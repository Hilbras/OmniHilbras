import { constants, lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The renderer's only path to the gateway.
 *
 * The dashboard token is an admin credential. A browser renderer that held it could be made to leak
 * it by any script in the page, so the token stays in the main process and the renderer asks for a
 * path. That also removes CORS from the app: no browser origin reaches the gateway.
 *
 * Two rules hold at this boundary:
 *
 * 1. **Ownership precedes credentials.** The client is constructed with an `isOwned` callback (the
 *    supervisor's `ownsRunningChild` in the app). It is asked before the token file is read and again
 *    immediately before every fetch, so a gateway that stopped, failed, is starting or is restarting
 *    never sees a token and never sees the request.
 * 2. **Only this app's frames may drive it.** `isTrustedIpcSender` refuses any event whose sender is
 *    not the window's own `webContents` and whose document is not the `app://` origin.
 */

export const dashboardTokenHeader = 'x-omnihilbras-dashboard-token';
// The gateway's default allowlist. The IPC client is not a browser, so this is a constant header
// rather than a policy — but it must be an allowlisted origin or the gateway refuses the call.
const DASHBOARD_ORIGIN = 'http://localhost:5173';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** The only document origin this process serves. Kept here so sender validation cannot drift. */
export const APP_ORIGIN = 'app://omnihilbras';
/** The gateway's own reader caps the token at 256 bytes; this reads no more than that. */
export const MAX_DASHBOARD_TOKEN_BYTES = 256;

export function dashboardTokenPath(env = process.env, port = 20138) {
  const configHome = env.XDG_CONFIG_HOME?.trim();
  const name = port === 20138 ? 'dashboard-token' : `dashboard-token-${port}`;
  return join(configHome || join(homedir(), '.config'), 'omnihilbras', name);
}

/**
 * Read the dashboard token without trusting the path.
 *
 * This deliberately re-implements the gateway's `secure-store` reader rather than importing it: the
 * desktop shell is plain ESM and the store lives behind the gateway's build. The semantics are the
 * same and are worth stating, because a token reader is where a symlink or an unbounded read turns
 * into a credential leak:
 *
 * - **regular file only** — a directory, FIFO or device is refused, never read;
 * - **no symlinks** — refused by `O_NOFOLLOW` (ELOOP) and by an `lstat` check for platforms without it;
 * - **bounded bytes** — no more than `maxBytes` is ever read, whatever the file claims;
 * - **safe permissions** — on POSIX the file must be owner-only, the mode `atomicWrite` gives it. A
 *   looser mode means another local user could already have read it, so it is not a secret this
 *   process can vouch for.
 *
 * A missing, unreadable or malformed file is `undefined`, not an exception: that is a normal state
 * (the gateway may not have run yet) and every caller already treats a missing token as "no token".
 */
export async function readDashboardTokenFile(path = dashboardTokenPath(), { maxBytes = MAX_DASHBOARD_TOKEN_BYTES, platform = process.platform } = {}) {
  // `O_NOFOLLOW` is absent on Windows; there the pre-open `lstat` is the only symlink check available.
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) return undefined;
    handle = await open(path, constants.O_RDONLY | noFollow);
    // Re-check the opened inode: `lstat` and `open` are two syscalls, and the authoritative facts are
    // the ones describing the bytes actually attached to this handle.
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return undefined;
    if (platform !== 'win32' && (info.mode & 0o077) !== 0) return undefined;
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').trim() || undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Whether an IPC event came from this app's own window.
 *
 * The check is identity: `event.sender` must be the window's own `webContents`. A URL comparison alone
 * is not enough — a webContents that navigated to `app://` (a sign-in child could try) would pass it —
 * so the document origin is only used to *refuse* a window that is somehow no longer at the app
 * origin. Identity survives a reload, which is the case a URL-only rule was meant to cover; a new
 * window gets a new `webContents` and must not inherit this one's trust.
 */
export function isTrustedIpcSender(event, trustedWebContents) {
  const sender = event?.sender;
  if (!sender || !trustedWebContents) return false;
  // Electron identifies a WebContents by its numeric id. Identity by id survives a wrapper or reload;
  // a different id is a different frame even when its URL string looks the same.
  const sameContents = sender === trustedWebContents
    || (Number.isSafeInteger(sender.id) && Number.isSafeInteger(trustedWebContents.id) && sender.id === trustedWebContents.id);
  if (!sameContents) return false;
  const url = typeof sender.getURL === 'function' ? sender.getURL() : '';
  // An empty URL is the window before its first document commits. The identity is already ours.
  if (typeof url === 'string' && url.length > 0 && url !== APP_ORIGIN && !url.startsWith(`${APP_ORIGIN}/`)) return false;
  return true;
}

/**
 * Send one payload to an IPC sender, or nothing at all.
 *
 * A refused sender is not told why: the channel name and the fact of a refusal are themselves
 * information a foreign frame has no use for. Returns whether the payload was delivered.
 */
export function sendToTrustedIpc(event, trustedWebContents, channel, payload) {
  if (!isTrustedIpcSender(event, trustedWebContents)) return false;
  event.sender.send(channel, payload);
  return true;
}

/**
 * The controllers for credential-bearing streams (chat today).
 *
 * Kept as a tiny registry rather than a bare `Map` so "the child we were reading from is gone" has
 * one operation — `abortAll` — and so ownership loss cannot abort some streams and miss others.
 */
export function createStreamControllerRegistry() {
  const controllers = new Map();
  return {
    set(id, controller) {
      controllers.set(id, controller);
      return this;
    },
    get(id) {
      return controllers.get(id);
    },
    delete(id) {
      return controllers.delete(id);
    },
    /** Abort every tracked stream and empty the registry. Returns how many were aborted. */
    abortAll() {
      const active = [...controllers.values()];
      controllers.clear();
      for (const controller of active) controller.abort();
      return active.length;
    },
    get size() {
      return controllers.size;
    },
  };
}

/**
 * Abort credential streams the moment the supervisor stops owning a live child.
 *
 * The state event is the trigger, and `ownsRunningChild()` is the question — a `stopping`,
 * `restarting` or `failed` label all mean the same thing here: the process a stream was reading from
 * is not one this app owns. Returns an unsubscribe function.
 */
export function bindStreamAbortToOwnership(supervisor, registry) {
  const onState = () => {
    if (!supervisor.ownsRunningChild()) registry.abortAll();
  };
  supervisor.on('state', onState);
  // A binding installed after the loss must still abort what it inherited.
  onState();
  return () => supervisor.off('state', onState);
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

export function createGatewayClient({ host = '127.0.0.1', port, isOwned, env = process.env, readToken } = {}) {
  const portOf = typeof port === 'function' ? port : () => port;
  const base = () => `http://${host}:${portOf()}`;
  // `readToken` is injectable so a test can prove it was *not* called; the default is the hardened
  // file reader, which is the only reader the app uses.
  const tokenReader = readToken ?? (() => readDashboardTokenFile(dashboardTokenPath(env, Number(portOf()))));

  /**
   * Ownership is a precondition, not a hint.
   *
   * Called before the token is read and again immediately before every fetch. The second check is
   * the one that matters: reading the file is asynchronous, and a gateway can stop while a read is
   * in flight. Without an `isOwned` callback the client behaves as before, which is what a plain
   * Node consumer (and these tests' positive controls) need.
   */
  const assertOwned = () => {
    if (isOwned === undefined) return;
    if (typeof isOwned !== 'function') throw new Error('createGatewayClient expects isOwned to be a function.');
    if (!isOwned()) throw new Error('The local gateway is not running under this app.');
  };

  const headersFor = async (extra = {}) => {
    assertOwned();
    const token = await tokenReader();
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
      /**
       * A write announces JSON whether or not it has anything to send.
       *
       * The gateway refuses a `POST`/`PUT`/`PATCH` with no `content-type: application/json` with `415`,
       * before any route sees it — so the body-less writes (starting the opencode runtime, stopping the
       * gateway) were refused from here too. The renderer now normalises its own writes; this is the same
       * rule at the boundary, so a caller that gets either one right works.
       */
      const write = upper === 'POST' || upper === 'PUT' || upper === 'PATCH';
      const payload = write ? (body ?? '{}') : body;
      const headers = await headersFor(write ? { 'content-type': 'application/json' } : {});
      assertOwned();
      const response = await fetch(`${base()}${assertGatewayPath(path)}`, {
        method: upper,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(30_000),
      });
      return { ok: response.ok, status: response.status, text: await response.text() };
    },

    /**
     * A chat stream. Chunks arrive as text; the renderer keeps the SSE parser it already had.
     */
    async streamChat({ path = '/v1/chat/completions', body, signal } = {}) {
      const headers = await headersFor({ 'content-type': 'application/json', accept: 'text/event-stream' });
      assertOwned();
      const response = await fetch(`${base()}${assertGatewayPath(path)}`, {
        method: 'POST',
        headers,
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
      const headers = await headersFor({ accept: 'text/event-stream' });
      assertOwned();
      const response = await fetch(`${base()}/v1/logs/stream`, {
        headers,
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