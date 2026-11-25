/**
 * One HTTP call, one error shape.
 *
 * Every verb goes through `request`, so the answers to "how does this authenticate", "what happens on a
 * refusal" and "what does a failure look like" are answered once instead of per verb — the old project's
 * client had a bespoke branch per endpoint, which is where its drifting token derivation came from.
 */

import { DASHBOARD_ORIGIN, isLoopbackHost, resolveAuth, resolveGatewayUrl } from './config.mjs';

/** Thrown for anything that should stop the verb, carrying the exit code the CLI should use. */
export class CliError extends Error {
  constructor(message, { code = 1, hint } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = code;
    // What the person should do next. Separate from the message because a message states the fact and a
    // hint states the action, and mixing them produces the sentence nobody reads to the end.
    this.hint = hint;
  }
}

/**
 * The one place a gateway address becomes a request base.
 *
 * A bare host is not enough: the value is concatenated with a path, sent as a credential's destination, and
 * quoted back in errors. So it is parsed rather than trimmed.
 *
 * - **No userinfo.** `https://user:pass@host` would put a credential in every error message and log line,
 *   and would silently override the `Authorization` header the CLI assembles. Keys go in `--api-key`.
 * - **No query and no fragment.** `/v1/models?x=1` + `/v1/logs/stream` is not a URL anyone meant, and a
 *   fragment never reaches a server at all.
 * - **HTTPS off loopback.** A plain-HTTP gateway on another host carries the bearer token in clear text.
 *   `127/8`, `localhost`, `*.localhost` and `::1` are this machine and may stay `http://`; everything else
 *   must say `https://`.
 *
 * A path prefix is kept, because a gateway behind a reverse proxy may live under one.
 */
export function normalizeGatewayUrl(raw) {
  const input = String(raw ?? '').trim();
  if (!input) {
    throw new CliError('No gateway address was given.', { code: 2, hint: 'Pass --gateway <url> or set OMNIHILBRAS_GATEWAY_URL.' });
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new CliError(`\`${input}\` is not a URL.`, { code: 2, hint: 'Use an address such as http://127.0.0.1:20138.' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError(`The gateway address must be http or https, not \`${url.protocol}\`.`, { code: 2 });
  }
  if (url.username || url.password) {
    throw new CliError('The gateway address must not carry a username or password.', {
      code: 2,
      hint: 'Supply a key with --api-key or OMNIHILBRAS_API_KEY instead.',
    });
  }
  if (url.search || url.hash) {
    throw new CliError('The gateway address must not contain a query or a fragment.', { code: 2, hint: `Got \`${input}\`.` });
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new CliError(`Refusing plain HTTP to ${url.host}.`, {
      code: 2,
      hint: 'A gateway that is not on this machine is reached over https://; a key would travel in clear text otherwise.',
    });
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

export function createClient(flags, env = process.env) {
  const baseUrl = normalizeGatewayUrl(resolveGatewayUrl(flags, env));
  // The dashboard token is presented only when the gateway is loopback; `resolveAuth` refuses to hand a
  // local secret to a remote host even if the token file is readable.
  const auth = resolveAuth(flags, env, { gatewayUrl: baseUrl });

  async function request(path, { method = 'GET', body, signal, raw = false } = {}) {
    const headers = { accept: raw ? 'text/event-stream' : 'application/json' };
    /**
     * A write is always declared JSON, body or not.
     *
     * The gateway refuses a `POST`/`PUT`/`PATCH` that does not say so (`415 UNSUPPORTED_MEDIA_TYPE`), and
     * several management routes are verbs with no payload at all — `.../probe` is one. Sending the header
     * unconditionally is what the dashboard's client does; leaving it off is how `omnihilbras test` asked
     * the gateway a question it refused to parse.
     */
    if (method !== 'GET' && method !== 'HEAD') headers['content-type'] = 'application/json';
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth.kind === 'api-key') headers.authorization = `Bearer ${auth.apiKey}`;
    else if (auth.kind === 'dashboard') {
      headers.origin = DASHBOARD_ORIGIN;
      headers['x-omnihilbras-dashboard-token'] = auth.dashboardToken;
    }

    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      /**
       * A refused connection is the common case, and it deserves the sentence that fixes it rather than
       * `fetch failed` — the gateway is a separate process from the CLI and is routinely not running.
       */
      const reason = error instanceof Error ? error.cause?.code ?? error.message : String(error);
      throw new CliError(`Cannot reach the gateway at ${baseUrl} (${reason}).`, {
        hint: 'Start it with `omnihilbras` (which runs the gateway and the dashboard together), or point at another one with --gateway.',
      });
    }

    if (raw) return response;

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      throw new CliError(`The gateway answered ${response.status} with something that is not JSON.`, {
        hint: `Received: ${text.slice(0, 120)}`,
      });
    }

    if (!response.ok) {
      const envelope = parsed?.error;
      const message = envelope?.message ?? `The gateway answered ${response.status}.`;
      const code = envelope?.code ? ` (${envelope.code})` : '';
      throw new CliError(`${message}${code}`, {
        hint: response.status === 401
          ? 'Management routes need either a public API key (set OMNIHILBRAS_API_KEY) or the local dashboard token, which the gateway writes when it starts.'
          : envelope?.requestId ?? response.headers.get('x-request-id')
            ? `Gateway request id: ${envelope?.requestId ?? response.headers.get('x-request-id')}`
            : undefined,
      });
    }

    return parsed;
  }

  return { baseUrl, auth, request };
}
