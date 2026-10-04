import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { canonicalLoopbackHost } from '@hilbras/omnihilbras';
import { assertLoopbackHost, createGatewayService, loadGatewayConfig, type GatewayConfig } from './config.js';
import { isCrossSiteRequest, isJsonRequest, isOauthCallbackNavigation, getRequestOrigin, resolveCorsOrigins, sendError, sendJson, setCors } from './http.js';
import { isTrustedDashboard, type AuthContext } from './runtime.js';
import { handleApiKeysRoute } from './routes/api-keys.js';
import { handleConnectionsRoute } from './routes/connections.js';
import { extractApiKey, handleInferenceRoute } from './routes/inference.js';
import { handleOauthRoute } from './routes/oauth.js';
import { handleStatusRoute } from './routes/status.js';
import { handleUsageRoute } from './routes/usage.js';
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
  // Last, because it carries the authentication gate for the LLM surface and must not shadow
  // anything above.
  handleInferenceRoute,
];

/** The handle callers use to stop a gateway they started. */
export type GatewayServer = Server;

export function createGatewayServer(service: GatewayService, options: GatewayServerOptions = {}) {
  const corsOrigins = resolveCorsOrigins(options);
  return createServer((request, response) => {
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
    const auth: AuthContext = {
      kind: requestOrigin && corsOrigins.includes(requestOrigin) ? 'dashboard' : 'system',
      tenant: service.deployment().tenant,
    };
    const responseOrigin = requestOrigin && corsOrigins.includes(requestOrigin) ? requestOrigin : undefined;
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
  const server = createGatewayServer(service, {
    ...(options.corsOrigin ? { corsOrigin: options.corsOrigin } : {}),
    ...(options.corsOrigins ? { corsOrigins: options.corsOrigins } : options.corsOrigin ? {} : { corsOrigins: config.corsOrigins }),
    publicBaseUrl: `http://${config.host}:${config.port}`,
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
    if (isManagementPath(ctx.url.pathname) && !isTrustedDashboard(auth)) {
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
