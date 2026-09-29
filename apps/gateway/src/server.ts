import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { canonicalLoopbackHost } from '@hilbras/omnihilbras';
import { assertLoopbackHost, createGatewayService, loadGatewayConfig, type GatewayConfig } from './config.js';
import { isCrossSiteRequest, isJsonRequest, isOauthCallbackNavigation, getRequestOrigin, resolveCorsOrigins, sendError, sendJson, setCors } from './http.js';
import { handleApiKeysRoute } from './routes/api-keys.js';
import { handleConnectionsRoute } from './routes/connections.js';
import { handleInferenceRoute } from './routes/inference.js';
import { handleOauthRoute } from './routes/oauth.js';
import { handleStatusRoute } from './routes/status.js';
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

    const trustedDashboardRequest = Boolean(requestOrigin) && corsOrigins.includes(requestOrigin as string);
    const responseOrigin = requestOrigin && corsOrigins.includes(requestOrigin) ? requestOrigin : undefined;
    setCors(response, responseOrigin);
    if (request.url?.startsWith('/v1/connections') || request.url?.startsWith('/v1/keys') || request.url?.startsWith('/v1/settings')) response.setHeader('cache-control', 'no-store');
    if ((request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') && !isJsonRequest(request)) {
      sendJson(response, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'JSON requests must use application/json.' } }, responseOrigin);
      return;
    }
    void handleRequest(request, response, service, options, responseOrigin, trustedDashboardRequest).catch((error) => {
      sendError(response, error, trustedDashboardRequest);
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

async function handleRequest(request: IncomingMessage, response: ServerResponse, service: GatewayService, options: GatewayServerOptions, origin: string | undefined, trustedDashboardRequest: boolean) {
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
      trusted: trustedDashboardRequest,
    };
    for (const route of routes) {
      if (await route(ctx)) return;
    }

    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } }, origin);
  } finally {
    request.off('aborted', abort);
    response.off('close', onResponseClose);
  }
}
