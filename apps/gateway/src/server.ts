import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { canonicalLoopbackHost, isLoopbackHostname } from '@hilbras/omnihilbras';
import { assertLoopbackHost, createGatewayService, loadGatewayConfig, type GatewayConfig } from './config.js';
import { isCrossSiteRequest, isJsonRequest, isOauthCallbackNavigation, getRequestOrigin, resolveCorsOrigins, sendError, sendJson, setCors } from './http.js';
import { dashboardTokenHeader, issueDashboardToken, tokenMatches } from './dashboard-token.js';
import { isTrustedDashboard, type AuthContext } from './runtime.js';
import { handleApiKeysRoute } from './routes/api-keys.js';
import { handleConnectionsRoute } from './routes/connections.js';
import { extractApiKey, handleInferenceRoute } from './routes/inference.js';
import { handleOauthRoute } from './routes/oauth.js';
import { handleStatusRoute } from './routes/status.js';
import { handleUsageRoute } from './routes/usage.js';
import { handleSettingsRoute } from './routes/settings.js';
import type { RouteContext } from './routes/route-context.js';
import type { ApiKeyStore } from './api-keys.js';
import type { ConnectionStore } from './connections.js';
import type { GatewayService } from './service.js';

export type GatewayServerOptions = {
  /** Backwards-compatible single-origin option for tests and embedders. */
  corsOrigin?: string;
  /** Exact browser origins allowed to call the local gateway. */
  corsOrigins?: string[];
  maxBodyBytes?: number;
  /**
   * Where the gateway itself is reachable on loopback. Used to build the OAuth
   * callback the provider redirects the browser to.
   */
  publicBaseUrl?: string;
  /**
   * The per-launch dashboard token. When set, a management request is trusted as the dashboard only
   * if it presents this token. Without it, the Origin check alone decides, which is the weaker rule
   * tests and embedders still rely on.
   */
  dashboardToken?: string;
};

/**
 * The routes, in the order they are tried.
 *
 * **Order is load-bearing and this is the one place it is written down.** The chain below is the
 * same order the old 373-line `if` statement used, and it has to stay that way: the connection
 * routes match on `startsWith('/v1/connections/')`, so a `POST /v1/connections/x/check` is only
 * reached because the specific `/check` and `/models/refresh` branches were tried first.
 *
 * Grouping into modules did not make these independent. It made the *order* a five-line list
 * instead of a 373-line chain, which is the difference between a reader being able to check it
 * and having to trust it.
 */
const routes = [
  handleStatusRoute,
  handleConnectionsRoute,
  handleOauthRoute,
  handleApiKeysRoute,
  handleUsageRoute,
  handleSettingsRoute,
  // Last, because it carries the authentication gate for the LLM surface and must not shadow
  // anything above.
  handleInferenceRoute,
];

/** The handle callers use to stop a gateway they started. */
export type GatewayServer = Server;

/**
 * Refuses a request whose `Host` names something other than loopback.
 *
 * Origin checks do not stop DNS rebinding: a page on an attacker's domain, once its DNS is re-pointed at
 * 127.0.0.1, is same-origin to itself and sends a valid-looking request. The `Host` header still carries
 * the attacker's name, so requiring a loopback name here closes that path. The port is ignored because it
 * varies between runs.
 */
function isLoopbackHostHeader(host: string | undefined) {
  if (!host) return false;
  const name = host.trim().toLowerCase();
  const hostname = name.startsWith('[')
    ? name.slice(0, name.indexOf(']') + 1)
    : name.replace(/:\d+$/, '');
  return isLoopbackHostname(hostname);
}

export function createGatewayServer(service: GatewayService, options: GatewayServerOptions = {}) {
  const corsOrigins = resolveCorsOrigins(options);
  return createServer((request, response) => {
    if (!isLoopbackHostHeader(request.headers.host)) {
      sendJson(response, 421, { error: { code: 'MISDIRECTED_REQUEST', message: 'This gateway only answers on a loopback host name.' } });
      return;
    }
    const requestOrigin = getRequestOrigin(request);
    if (requestOrigin && !corsOrigins.includes(requestOrigin)) {
      sendJson(response, 403, { error: { code: 'CORS_ORIGIN_DENIED', message: 'This browser origin is not allowed.' } });
      return;
    }
    // Chromium may classify loopback host aliases (localhost -> 127.0.0.1)
    // as cross-site. The exact Origin allowlist is the authorization check;
    // an allowlisted dashboard origin is safe to accept here.
    // The OAuth callback is the one exception: it is a top-level navigation
    // from the provider, so it carries `sec-fetch-site: cross-site` and no
    // Origin at all. It only displays the code the browser already holds.
    if (!isOauthCallbackNavigation(request) && isCrossSiteRequest(request) && (!requestOrigin || !corsOrigins.includes(requestOrigin))) {
      sendJson(response, 403, { error: { code: 'CROSS_SITE_REQUEST_DENIED', message: 'Cross-site requests are not allowed.' } });
      return;
    }

    // Who is asking, decided once here because this is the only place that understands the
    // request. `dashboard` is an allowlisted browser origin on this machine; anything else is
    // unauthenticated until a key says otherwise, which the LLM surface's gate checks for itself.
    const allowedOrigin = requestOrigin && corsOrigins.includes(requestOrigin);
    const presentedToken = request.headers[dashboardTokenHeader];
    const tokenOk = options.dashboardToken === undefined
      || tokenMatches(typeof presentedToken === 'string' ? presentedToken : undefined, options.dashboardToken);
    const auth: AuthContext = {
      kind: allowedOrigin && tokenOk ? 'dashboard' : 'system',
      tenant: service.deployment().tenant,
    };
    const responseOrigin = allowedOrigin ? requestOrigin : undefined;
    setCors(response, responseOrigin);
    if (request.url?.startsWith('/v1/connections') || request.url?.startsWith('/v1/keys') || request.url?.startsWith('/v1/settings') || request.url?.startsWith('/v1/usage')) response.setHeader('cache-control', 'no-store');
    if ((request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') && !isJsonRequest(request)) {
      sendJson(response, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'JSON requests must use application/json.' } }, responseOrigin);
      return;
    }
    void handleRequest(request, response, service, options, responseOrigin, auth).catch((error) => {
      sendError(response, error, isTrustedDashboard(auth));
    });
  });
}

export async function startGatewayServer(options: {
  config?: GatewayConfig;
  env?: Readonly<Record<string, string | undefined>>;
  corsOrigin?: string;
  corsOrigins?: string[];
  connectionStore?: ConnectionStore;
  apiKeyStore?: ApiKeyStore;
  healthIntervalMs?: number;
} = {}) {
  const config = options.config ?? loadGatewayConfig(options.env);
  assertLoopbackHost(config.host);
  const bindHost = canonicalLoopbackHost(config.host);
  const service = createGatewayService(config, options.env, options.connectionStore, options.apiKeyStore);
  service.setHealthInterval(options.healthIntervalMs ?? config.healthIntervalMs);
  const dashboardToken = await issueDashboardToken(options.env);
  const server = createGatewayServer(service, {
    ...(options.corsOrigin ? { corsOrigin: options.corsOrigin } : {}),
    ...(options.corsOrigins ? { corsOrigins: options.corsOrigins } : options.corsOrigin ? {} : { corsOrigins: config.corsOrigins }),
    publicBaseUrl: `http://${config.host}:${config.port}`,
    dashboardToken,
  });

  service.startHealthMonitor();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, bindHost);
  });

  return { config, server, service };
}

/**
 * The management surface: everything that is not an LLM inference call.
 *
 * ## Why this exists (1.46.0)
 *
 * `handleInferenceRoute` was the **only** consumer of `ctx.auth` in the whole route layer. It gated
 * `/v1/models` and `/v1/chat/completions` on `authorizePublicRequest`, and nothing else checked anything.
 * So the routes that mint credentials and turn the gate off sat entirely outside it. Measured against a
 * running gateway with no `Origin` and no `Authorization` — a plain local process, nothing more:
 *
 * ```
 * 200  GET  /v1/connections          → every configured connection and its endpoint
 * 201  POST /v1/keys                 → {"key":"ohk_..."}   the full secret, minted
 * 200  PUT  /v1/settings/require-api-key {"requireApiKey":false}   → the gate, switched off
 * ```
 *
 * The key it mints is accepted by the one gate that does exist, so step one alone is a full bypass of
 * the LLM surface. And step two is worse: it is permanent, and it needs no credential at all.
 *
 * `docs/SPEC-SDK.md` says "no authentication in local mode", which is a fair statement about
 * `/v1/chat/completions`. What is not fair is a gateway that has since grown an API-key system whose
 * *toggle* and *mint route* are unprotected. The key is the control; the switch that disables it was not
 * behind it.
 *
 * ## The rule
 *
 * When key enforcement is on, the management surface requires the same key the LLM surface requires. When
 * it is off — the documented local-mode default — nothing changes, because there is no key to present.
 *
 * `isTrustedDashboard` is what keeps the dashboard working: it is an allowlisted browser origin, and
 * `authorize()` returns early when enforcement is off anyway. The honest limitation is recorded rather than
 * papered over: `kind: 'dashboard'` is derived from the `Origin` **header**, which a non-browser client sets
 * freely, so a local process can claim to be the dashboard. Closing that needs a per-launch secret the
 * browser presents, which is a design change and not a patch. Until then this gate raises the bar from
 * "any local process" to "a local process that also knows the key", which is the difference between an
 * accidental postinstall script and a deliberate attacker.
 */
/**
 * Routes that require the admin key when enforcement is on.
 *
 * `/v1/web-cookie` was missing from this list at first, and the test that checks the list against the
 * router is what said so — it found a route serving a whole-account session cookie that an
 * unauthenticated local process could write. `/v1/routing` is included because it enumerates every
 * configured connection, its endpoint, and its health.
 *
 * `/v1/usage` is on the same footing as `/v1/routing` and for the same reason: a usage record names
 * providers, connections, models and latencies, which describes what this machine talks to. It holds no
 * credential and no prompt, so it is not as sensitive as `/v1/keys`.
 *
 * ## The one carve-out, and why it is safe (1.75.2)
 *
 * `/v1/oauth` is on this list, and the provider's callback lives under it — which meant the Cline
 * callback answered a browser that could not present a key with the gate's own message and no page at
 * all:
 *
 * ```
 * 401  GET /v1/oauth/cline/callback/<id>?code=…
 *      {"error":{"code":"AUTHENTICATION_FAILED","message":"This gateway requires an API key…"}}
 * ```
 *
 * The callback is the one request in the whole product that **cannot** carry an `Authorization` header:
 * it is a top-level navigation the provider sends the browser to, so the key was never on the table and
 * enforcement made the feature unreachable rather than secure. It is exempted here with the *same*
 * predicate that already exempts it from the cross-site guard, so the two exemptions cannot drift apart
 * and leave a path open to one and not the other.
 *
 * What the exemption costs, stated rather than assumed: those two GET paths are reachable by an
 * unauthenticated local process. They render an HTML status page whose only content is a short message,
 * and the callback can only act on a session this gateway minted — 256 random bits in the path for Cline,
 * 122 for Claude Code — and on a code the provider issued. The token never appears in the response and never
 * leaves the vault; the route that carries the resulting connection, `/v1/oauth/cline/session/*`, is still
 * gated, as are `/v1/oauth/cline/start` and `/v1/oauth/cline/exchange`. The predicate is GET-only and
 * path-exact, so a POST to the callback path is refused like any other management route.
 *
 * This is parity, not a new opening: with enforcement off — the documented local-mode default — these paths
 * were already reachable, because `authorize()` returns before it can refuse anything. What changed is that
 * a gateway *with* keys enforced now answers the navigation the same way a gateway without them does.
 */
const MANAGEMENT_PREFIXES = ['/v1/connections', '/v1/keys', '/v1/oauth', '/v1/settings', '/v1/web-cookie', '/v1/routing', '/v1/usage'] as const;

function isManagementPath(pathname: string) {
  return MANAGEMENT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, service: GatewayService, options: GatewayServerOptions, origin: string | undefined, auth: AuthContext) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const onResponseClose = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once('aborted', abort);
  response.once('close', onResponseClose);

  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    const ctx: RouteContext = {
      request,
      response,
      url: new URL(request.url ?? '/', 'http://localhost'),
      service,
      options,
      origin,
      signal: controller.signal,
      auth,
    };
    // The management surface is gated here rather than in each handler, so a route added later cannot
    // forget it. `authorize()` returns immediately when enforcement is off, which is what keeps local
    // mode and every test that builds a gateway without a key store working unchanged.
    if (isManagementPath(ctx.url.pathname) && !isTrustedDashboard(auth) && !isOauthCallbackNavigation(request)) {
      try {
        await service.authorizePublicRequest(extractApiKey(request));
      } catch (error) {
        sendError(response, error, false);
        return;
      }
    }

    for (const route of routes) {
      if (await route(ctx)) return;
    }

    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } }, origin);
  } finally {
    request.off('aborted', abort);
    response.off('close', onResponseClose);
  }
}
