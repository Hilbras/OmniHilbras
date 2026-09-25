import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ProviderError, assertSafeProviderRequestUrl, canonicalLoopbackHost, isLoopbackHostname, publicProviderMessage, type ChatChunk, type ChatMessage, type ChatRequest, type ChatResponse, type MessageContent, type Model, type ModelImportPolicy, type ProviderCredential, type ToolDefinition } from '@hilbras/omnihilbras';
import { assertLoopbackHost, createGatewayService, loadGatewayConfig, type GatewayConfig } from './config.js';
import type { ApiKeyStore } from './api-keys.js';
import type { ConnectionStore } from './connections.js';
import { clineCallbackPath } from './oauth.js';
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

const defaultCorsOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const maxConnectionBodyBytes = 16 * 1024;
const maxKeyBodyBytes = 4 * 1024;
const maxPresentedKeyLength = 512;

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
      sendError(response, error);
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

    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { service: 'omnihilbras-gateway', ...(await service.health(controller.signal)) }, origin);
      return;
    }

    if (url.pathname.startsWith('/v1/connections')) response.setHeader('cache-control', 'no-store');

    if (request.method === 'GET' && url.pathname === '/v1/connections') {
      sendJson(response, 200, { object: 'list', data: await service.listConnections() }, origin);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/connections/openrouter/check') {
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxConnectionBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['apiKey']);
      const credential = parseApiKey(body);
      sendJson(response, 200, await service.validateConnectionCredential('openrouter', credential, controller.signal), origin);
      return;
    }

    if (request.method === 'PUT' && url.pathname === '/v1/connections/openrouter') {
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxConnectionBodyBytes));
      const { credential, ...input } = parseOpenRouterConnectionRequest(body);
      const connection = await service.saveConnection(input, credential, controller.signal);
      sendJson(response, 200, { connection }, origin);
      return;
    }

    // Any other provider: the endpoint and paths are caller-supplied, so this
    // covers Anthropic, Gemini, Ollama, and arbitrary OpenAI-compatible servers.
    if (request.method === 'PUT' && url.pathname.startsWith('/v1/connections/') && !url.pathname.endsWith('/models') && !url.pathname.endsWith('/resilience')) {
      const providerId = decodeProviderId(url.pathname.slice('/v1/connections/'.length));
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxConnectionBodyBytes));
      const { credential, ...input } = parseGenericConnectionRequest(body, providerId);
      const connection = await service.saveConnection(input, credential, controller.signal);
      sendJson(response, 200, { connection }, origin);
      return;
    }

    if (request.method === 'POST' && url.pathname.endsWith('/check') && url.pathname.startsWith('/v1/connections/')) {
      const providerId = decodeProviderId(url.pathname.slice('/v1/connections/'.length, -'/check'.length));
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxConnectionBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['apiKey', 'endpoint']);
      const credential = parseApiKey(body);
      if (typeof body.endpoint === 'string' && body.endpoint.trim()) assertSafeEndpoint(body.endpoint.trim(), providerId);
      sendJson(response, 200, await service.validateConnectionCredential(providerId, credential, controller.signal), origin);
      return;
    }

    if (request.method === 'PUT' && url.pathname.endsWith('/resilience') && url.pathname.startsWith('/v1/connections/')) {
      const encodedConnectionId = url.pathname.slice('/v1/connections/'.length, -'/resilience'.length);
      const connectionId = decodeConnectionId(encodedConnectionId);
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxConnectionBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['timeoutMs', 'maxRetries', 'requestsPerMinute', 'hedgeAfterMs']);
      const connection = await service.updateConnectionResilience(connectionId, parseResilienceInput(body));
      sendJson(response, 200, { connection }, origin);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/routing') {
      sendJson(response, 200, await service.describeRouting(), origin);
      return;
    }

    if (request.method === 'POST' && url.pathname.startsWith('/v1/connections/') && url.pathname.endsWith('/models')) {
      const encodedConnectionId = url.pathname.slice('/v1/connections/'.length, -'/models'.length);
      const connectionId = decodeConnectionId(encodedConnectionId);
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxConnectionBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['modelIds']);
      const modelIds = parseModelIds(body.modelIds);
      const connection = await service.addConnectionModels(connectionId, modelIds);
      sendJson(response, 200, { connection }, origin);
      return;
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/v1/connections/')) {
      const connectionId = decodeConnectionId(url.pathname.slice('/v1/connections/'.length));
      await service.removeConnection(connectionId);
      sendJson(response, 200, { deleted: true, id: connectionId }, origin);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/oauth/cline/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? defaultClineRedirect(options.publicBaseUrl);
      sendJson(response, 200, service.beginClineAuthorization(redirectUri), origin);
      return;
    }

    // The provider sends the browser here after sign-in. It shows the code and
    // nothing else: no token is created, exchanged, or stored from this page.
    if (request.method === 'GET' && url.pathname === '/v1/oauth/cline/callback') {
      const code = url.searchParams.get('code') ?? '';
      const problem = url.searchParams.get('error');
      sendHtml(response, 200, clineCallbackPage(code, problem), origin);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/oauth/cline/exchange') {
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxKeyBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['code', 'callback', 'redirectUri', 'name', 'priority']);
      const connection = await service.connectCline({
        code: parseBoundedString(body.code ?? body.callback ?? '', 'code', 8192),
        ...(typeof body.callback === 'string' ? { callback: body.callback } : {}),
        redirectUri: typeof body.redirectUri === 'string' ? body.redirectUri : defaultClineRedirect(options.publicBaseUrl),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(body.priority === undefined ? {} : { priority: parsePriority(body.priority) }),
      }, controller.signal);
      sendJson(response, 201, { connection }, origin);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/keys') {
      sendJson(response, 200, { object: 'list', ...(await service.listApiKeys()) }, origin);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/keys') {
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxKeyBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['name']);
      const created = await service.createApiKey(parseBoundedString(body.name, 'name', 80));
      sendJson(response, 201, { apiKey: created.record, key: created.key }, origin);
      return;
    }

    if (request.method === 'PUT' && url.pathname === '/v1/settings/require-api-key') {
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxKeyBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['requireApiKey']);
      if (typeof body.requireApiKey !== 'boolean') throw invalidRequest('requireApiKey must be a boolean.');
      sendJson(response, 200, { requireApiKey: await service.setRequireApiKey(body.requireApiKey) }, origin);
      return;
    }

    if (request.method === 'PATCH' && url.pathname.startsWith('/v1/keys/')) {
      const apiKeyId = decodeApiKeyId(url.pathname.slice('/v1/keys/'.length));
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxKeyBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['enabled']);
      if (typeof body.enabled !== 'boolean') throw invalidRequest('enabled must be a boolean.');
      sendJson(response, 200, { apiKey: await service.setApiKeyEnabled(apiKeyId, body.enabled) }, origin);
      return;
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/v1/keys/')) {
      const apiKeyId = decodeApiKeyId(url.pathname.slice('/v1/keys/'.length));
      await service.removeApiKey(apiKeyId);
      sendJson(response, 200, { deleted: true, id: apiKeyId }, origin);
      return;
    }

    // The LLM surface is the only authenticated part of the gateway. Requests
    // from the allowlisted dashboard origin are local administration traffic
    // and stay reachable so the dashboard can keep testing models.
    if (isPublicLlmRoute(request.method, url.pathname) && !trustedDashboardRequest) {
      await service.authorizePublicRequest(extractApiKey(request));
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      const result = await service.listAllModels(controller.signal);
      sendJson(response, 200, {
        object: 'list',
        data: result.models.map(toOpenAIModel),
        unavailable: result.unavailable,
      }, origin);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await handleChat(request, response, service, options, origin, controller.signal);
      return;
    }

    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } }, origin);
  } finally {
    request.off('aborted', abort);
    response.off('close', onResponseClose);
  }
}

type OpenRouterConnectionRequest = {
  id: 'openrouter';
  providerId: 'openrouter';
  name: string;
  endpoint: typeof openRouterEndpoint;
  priority: number;
  proxyPool: string;
  enabled?: boolean;
  modelPolicy: ModelImportPolicy;
  credential: ProviderCredential;
};

const openRouterEndpoint = 'https://openrouter.ai/api/v1' as const;

function parseApiKey(body: unknown) {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
  if (typeof body.apiKey !== 'string') throw invalidRequest('apiKey is required.');
  const apiKey = body.apiKey;
  if (!apiKey || apiKey !== apiKey.trim() || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw invalidRequest('apiKey must be a non-empty safe string.');
  return { type: 'api-key' as const, value: apiKey };
}

function parseOpenRouterConnectionRequest(body: unknown): OpenRouterConnectionRequest {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
  assertOnlyFields(body, ['apiKey', 'name', 'priority', 'proxyPool', 'enabled', 'modelPolicy']);
  const name = parseBoundedString(body.name, 'name', 120);
  const priority = body.priority === undefined ? 1 : parsePriority(body.priority);
  const proxyPool = body.proxyPool === undefined ? 'none' : parseBoundedString(body.proxyPool, 'proxyPool', 128, true);
  const modelPolicy = parseModelPolicy(body.modelPolicy);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw invalidRequest('enabled must be a boolean.');
  return {
    id: 'openrouter',
    providerId: 'openrouter',
    name,
    endpoint: openRouterEndpoint,
    priority,
    proxyPool,
    modelPolicy,
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    credential: parseApiKey(body),
  };
}

function assertOnlyFields(body: Record<string, unknown>, allowed: string[]) {
  const allowedFields = new Set(allowed);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) throw invalidRequest('Request contains unsupported fields.');
}

function parseIdentifier(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.trim())) throw invalidRequest(`${field} contains unsupported characters.`);
  return value.trim();
}

function parseBoundedString(value: unknown, field: string, maxLength: number, allowEmpty = false) {
  if (typeof value !== 'string') throw invalidRequest(`${field} must be a string.`);
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) throw invalidRequest(`${field} is invalid.`);
  return normalized;
}

function parsePriority(value: unknown) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) throw invalidRequest('priority must be an integer from 1 to 1000.');
  return value;
}

function parseModelPolicy(value: unknown): ModelImportPolicy {
  if (value === undefined) return 'free';
  if (value !== 'free' && value !== 'all') throw invalidRequest('modelPolicy must be free or all.');
  return value;
}

function decodeProviderId(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidRequest('provider id is invalid.');
  }
  return parseIdentifier(decoded, 'provider id');
}

function assertSafeEndpoint(endpoint: string, providerId: string) {
  assertSafeProviderRequestUrl(endpoint, providerId);
}

/**
 * Connection input for any provider other than OpenRouter. The endpoint is
 * required so the adapter can be pointed at a real server, and the model
 * policy is optional so a caller can save before importing a catalog.
 */
function parseGenericConnectionRequest(body: unknown, providerId: string): { providerId: string; name: string; endpoint: string; priority: number; proxyPool: string; enabled?: boolean; modelPolicy?: ModelImportPolicy; credential: ProviderCredential } {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
  assertOnlyFields(body, ['apiKey', 'name', 'endpoint', 'priority', 'proxyPool', 'enabled', 'modelPolicy', 'resilience']);
  const endpoint = body.endpoint === undefined ? '' : parseBoundedString(body.endpoint, 'endpoint', 2048);
  if (!endpoint) throw invalidRequest('endpoint is required.');
  assertSafeEndpoint(endpoint, providerId);
  const name = body.name === undefined ? providerId : parseBoundedString(body.name, 'name', 120);
  const priority = body.priority === undefined ? 1 : parsePriority(body.priority);
  const proxyPool = body.proxyPool === undefined ? 'none' : parseBoundedString(body.proxyPool, 'proxyPool', 128, true);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw invalidRequest('enabled must be a boolean.');
  return {
    providerId,
    name,
    endpoint,
    priority,
    proxyPool,
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    ...(body.modelPolicy === undefined ? {} : { modelPolicy: parseModelPolicy(body.modelPolicy) }),
    credential: parseApiKey(body),
  };
}

function parseResilienceInput(body: Record<string, unknown>) {
  const resilience: { timeoutMs?: number; maxRetries?: number; requestsPerMinute?: number; hedgeAfterMs?: number } = {};
  if (body.timeoutMs !== undefined) resilience.timeoutMs = parseBoundedInteger(body.timeoutMs, 'timeoutMs', 0, 600_000);
  if (body.maxRetries !== undefined) resilience.maxRetries = parseBoundedInteger(body.maxRetries, 'maxRetries', 0, 5);
  if (body.requestsPerMinute !== undefined) resilience.requestsPerMinute = parseBoundedInteger(body.requestsPerMinute, 'requestsPerMinute', 0, 100_000);
  if (body.hedgeAfterMs !== undefined) resilience.hedgeAfterMs = parseBoundedInteger(body.hedgeAfterMs, 'hedgeAfterMs', 0, 30_000);
  if (Object.keys(resilience).length === 0) throw invalidRequest('At least one resilience field is required.');
  return resilience;
}

function parseBoundedInteger(value: unknown, field: string, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidRequest(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function parseModelIds(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw invalidRequest('modelIds must be a non-empty array.');
  const modelIds: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item !== item.trim() || !/^[a-z0-9~][a-z0-9._:/~-]{0,255}$/i.test(item)) throw invalidRequest('modelIds contains an invalid model ID.');
    if (seen.has(item)) continue;
    seen.add(item);
    modelIds.push(item);
    if (modelIds.length > 2_000) throw invalidRequest('modelIds must contain at most 2,000 unique entries.');
  }
  if (modelIds.length === 0) throw invalidRequest('modelIds must contain at least one unique model ID.');
  return modelIds;
}

function decodeConnectionId(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidRequest('connection id is invalid.');
  }
  return parseIdentifier(decoded, 'connection id');
}

function decodeApiKeyId(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidRequest('API key id is invalid.');
  }
  if (!/^key_[A-Za-z0-9_-]{1,32}$/.test(decoded)) throw invalidRequest('API key id is invalid.');
  return decoded;
}

function isPublicLlmRoute(method: string | undefined, pathname: string) {
  return (method === 'GET' && pathname === '/v1/models') || (method === 'POST' && pathname === '/v1/chat/completions');
}

/** Accepts the same headers OpenAI, Anthropic, and Gemini clients already send. */
function extractApiKey(request: IncomingMessage) {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string') {
    const bearer = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
    const value = bearer?.[1]?.trim();
    return value && value.length <= maxPresentedKeyLength ? value : undefined;
  }
  for (const header of ['x-api-key', 'x-goog-api-key']) {
    const value = request.headers[header];
    if (typeof value === 'string' && value.trim() && value.trim().length <= maxPresentedKeyLength) return value.trim();
  }
  return undefined;
}

async function handleChat(request: IncomingMessage, response: ServerResponse, service: GatewayService, options: GatewayServerOptions, origin: string | undefined, signal: AbortSignal) {
  const body = await readJsonBody(request, options.maxBodyBytes ?? 1_000_000);
  const chatRequest = parseChatRequest(body);
  const explicitProviderId = getExplicitProviderId(request, body);

  if (!chatRequest.stream) {
    const { response: completion, attempts } = await service.chatWithFailover(chatRequest, explicitProviderId, signal);
    sendJson(response, 200, { ...toOpenAICompletion(completion), ...(attempts.length > 1 ? { gateway: { attempts: attempts.map(toPublicAttempt) } } : {}) }, origin);
    return;
  }

  // The failover decision is made before any byte is written, so a stream that
  // cannot start returns a normal JSON error instead of a truncated SSE body.
  const outcome = await service.streamChatWithFailover(chatRequest, explicitProviderId, signal);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
  });
  response.flushHeaders();

  try {
    for await (const chunk of outcome.chunks) {
      await writeStreamData(response, `data: ${JSON.stringify(toOpenAIChunk(chunk))}\n\n`, signal);
    }
    await writeStreamData(response, 'data: [DONE]\n\n', signal);
    response.end();
  } catch (error) {
    if (!response.destroyed && !signal.aborted) {
      await writeStreamData(response, `event: error\ndata: ${JSON.stringify(toErrorEnvelope(error))}\n\n`, signal).catch(() => undefined);
      response.end();
    }
  }
}

function toPublicAttempt(attempt: { providerId: string; attempt: number; ok: boolean; latencyMs: number; errorCode?: string }) {
  return { provider: attempt.providerId, attempt: attempt.attempt, ok: attempt.ok, latencyMs: attempt.latencyMs, ...(attempt.errorCode ? { error: attempt.errorCode } : {}) };
}

function parseChatRequest(body: unknown): ChatRequest {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
  if (typeof body.model !== 'string' || !body.model.trim()) throw invalidRequest('model is required.');
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalidRequest('messages must be a non-empty array.');

  const messages = body.messages.map((message) => parseMessage(message));
  const stream = parseOptionalBoolean(body.stream, 'stream');
  const temperature = parseOptionalNumber(body.temperature, 'temperature', 0, 2);
  const topP = parseOptionalNumber(body.top_p, 'top_p', 0, 1);
  const maxOutputTokens = parseMaxTokens(body);
  const stop = parseStop(body);
  const tools = parseTools(body.tools);
  const providerOptions = body.provider_options === undefined ? undefined : parseProviderOptions(body.provider_options);

  return {
    model: body.model.trim(),
    messages,
    ...(stream !== undefined ? { stream } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(stop !== undefined ? { stop } : {}),
    ...(tools ? { tools } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  };
}

function parseMessage(value: unknown): ChatMessage {
  if (!isRecord(value) || (value.role !== 'system' && value.role !== 'user' && value.role !== 'assistant' && value.role !== 'tool')) {
    throw invalidRequest('Each message must have a valid role.');
  }

  const toolCalls = value.tool_calls === undefined ? undefined : parseToolCalls(value.tool_calls);
  if (toolCalls && value.role !== 'assistant') throw invalidRequest('Only assistant messages may contain tool calls.');
  if (value.name !== undefined && typeof value.name !== 'string') throw invalidRequest('Message name must be a string.');
  if (value.tool_call_id !== undefined && typeof value.tool_call_id !== 'string') throw invalidRequest('tool_call_id must be a string.');
  if (value.role === 'tool' && (typeof value.tool_call_id !== 'string' || !value.tool_call_id.trim())) {
    throw invalidRequest('Tool messages must include tool_call_id.');
  }
  const content = value.content === undefined && value.role === 'assistant' && toolCalls?.length
    ? null
    : parseContent(value.content);

  return {
    role: value.role,
    content,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.tool_call_id === 'string' ? { toolCallId: value.tool_call_id } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function parseContent(value: unknown): MessageContent {
  if (value === null || typeof value === 'string') return value;
  if (!Array.isArray(value)) throw invalidRequest('Message content must be a string, null, or content-part array.');
  return value.map((part) => {
    if (!isRecord(part)) throw invalidRequest('Message content parts must be objects.');
    if (part.type === 'text' && typeof part.text === 'string') return { type: 'text' as const, text: part.text };
    if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
      const url = parseImageUrl(part.image_url.url);
      const detail = part.image_url.detail;
      if (detail !== undefined && detail !== 'auto' && detail !== 'low' && detail !== 'high') {
        throw invalidRequest('Image detail must be auto, low, or high.');
      }
      return { type: 'image_url' as const, imageUrl: { url, ...(detail ? { detail } : {}) } };
    }
    throw invalidRequest('Message content contains an unsupported part.');
  });
}

function parseToolCalls(value: unknown): NonNullable<ChatMessage['toolCalls']> {
  if (!Array.isArray(value) || value.length === 0) throw invalidRequest('tool_calls must be a non-empty array.');
  return value.map((call) => {
    if (!isRecord(call) || call.type !== 'function' || typeof call.id !== 'string' || !call.id.trim() || !isRecord(call.function) || typeof call.function.name !== 'string' || !call.function.name.trim() || typeof call.function.arguments !== 'string') {
      throw invalidRequest('Each tool call must include an id, function name, and arguments.');
    }
    try {
      JSON.parse(call.function.arguments);
    } catch {
      throw invalidRequest('Tool call arguments must contain valid JSON.');
    }
    return {
      id: call.id,
      type: 'function' as const,
      function: { name: call.function.name, arguments: call.function.arguments },
    };
  });
}

function parseTool(value: unknown): ToolDefinition {
  if (!isRecord(value) || value.type !== 'function' || !isRecord(value.function) || typeof value.function.name !== 'string' || !value.function.name.trim() || !isRecord(value.function.parameters)) {
    throw invalidRequest('Each tool must contain a function name and parameters.');
  }
  if (value.function.description !== undefined && typeof value.function.description !== 'string') {
    throw invalidRequest('Tool descriptions must be strings.');
  }
  return {
    name: value.function.name,
    ...(typeof value.function.description === 'string' ? { description: value.function.description } : {}),
    parameters: value.function.parameters,
  };
}

function parseTools(value: unknown): ToolDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw invalidRequest('tools must be a non-empty array.');
  return value.map(parseTool);
}

function parseProviderOptions(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidRequest('provider_options must be an object.');
  return value;
}

function parseMaxTokens(body: Record<string, unknown>) {
  const hasCompletionTokens = body.max_completion_tokens !== undefined;
  const hasLegacyTokens = body.max_tokens !== undefined;
  if (hasCompletionTokens && hasLegacyTokens) throw invalidRequest('Use only one of max_tokens or max_completion_tokens.');
  const value = hasCompletionTokens ? body.max_completion_tokens : body.max_tokens;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw invalidRequest('max_tokens must be a positive integer.');
  return value;
}

function parseStop(body: Record<string, unknown>) {
  if (body.stop === undefined) return undefined;
  if (typeof body.stop === 'string') {
    if (!body.stop) throw invalidRequest('stop must not be empty.');
    return [body.stop];
  }
  if (!Array.isArray(body.stop) || body.stop.length === 0 || !body.stop.every((value) => typeof value === 'string' && value.length > 0)) {
    throw invalidRequest('stop must be a string or a non-empty array of strings.');
  }
  return body.stop;
}

function parseOptionalBoolean(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalidRequest(`${name} must be a boolean.`);
  return value;
}

function parseOptionalNumber(value: unknown, name: string, minimum: number, maximum: number) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidRequest(`${name} must be a finite number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseImageUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:') {
      if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(value)) throw new Error('Only base64 image data URLs are supported.');
      return value;
    }
    if (url.protocol !== 'https:' || url.username || url.password || isLoopbackHostname(url.hostname) || isPrivateHostname(url.hostname)) {
      throw new Error('Unsafe image URL.');
    }
    return value;
  } catch {
    throw invalidRequest('Image URLs must be HTTPS image URLs or base64 image data URLs.');
  }
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (normalized.endsWith('.local') || normalized.endsWith('.internal')) return true;
  const parts = normalized.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
  const numbers = parts.map(Number);
  const first = numbers[0] ?? -1;
  const second = numbers[1] ?? -1;
  return first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254) || first === 0;
}

/** Returns the provider the caller asked for, or undefined to let the catalog decide. */
function getExplicitProviderId(request: IncomingMessage, body: unknown) {
  const header = request.headers['x-omnihilbras-provider'];
  if (Array.isArray(header)) throw invalidRequest('x-omnihilbras-provider must be a single value.');
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (isRecord(body) && body.provider !== undefined) {
    if (typeof body.provider !== 'string' || !body.provider.trim()) throw invalidRequest('provider must be a non-empty string.');
    return body.provider.trim();
  }
  return undefined;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number) {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw invalidRequest('Request body is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw invalidRequest('Request body is too large.');
    chunks.push(buffer);
  }
  if (size === 0) throw invalidRequest('Request body is required.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw invalidRequest('Request body must contain valid JSON.');
  }
}

function toOpenAICompletion(response: ChatResponse) {
  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.parse(response.createdAt) / 1000),
    model: response.model,
    provider: response.providerId,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: response.message.content,
        ...(response.message.toolCalls?.length ? { tool_calls: response.message.toolCalls.map((toolCall) => ({ id: toolCall.id, type: 'function', function: toolCall.function })) } : {}),
      },
      finish_reason: response.finishReason,
    }],
    ...(response.usage ? { usage: { prompt_tokens: response.usage.inputTokens, completion_tokens: response.usage.outputTokens, total_tokens: response.usage.totalTokens } } : {}),
  };
}

function toOpenAIChunk(chunk: ChatChunk) {
  return {
    id: chunk.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: chunk.model,
    provider: chunk.providerId,
    choices: [{
      index: 0,
      delta: {
        ...(chunk.delta.role ? { role: chunk.delta.role } : {}),
        ...(chunk.delta.content !== undefined ? { content: chunk.delta.content } : {}),
        ...(chunk.delta.toolCalls?.length ? { tool_calls: chunk.delta.toolCalls.map((toolCall) => ({ index: toolCall.index, ...(toolCall.id ? { id: toolCall.id } : {}), type: 'function', function: { ...(toolCall.function?.name ? { name: toolCall.function.name } : {}), arguments: toolCall.function?.arguments ?? '' } })) } : {}),
      },
      finish_reason: chunk.finishReason ?? null,
    }],
    ...(chunk.usage ? { usage: { prompt_tokens: chunk.usage.inputTokens, completion_tokens: chunk.usage.outputTokens, total_tokens: chunk.usage.totalTokens } } : {}),
  };
}

function toOpenAIModel(model: Model) {
  return { id: model.id, object: 'model', owned_by: model.providerId, ...(model.displayName ? { display_name: model.displayName } : {}), ...(model.contextWindow ? { context_window: model.contextWindow } : {}) };
}

async function writeStreamData(response: ServerResponse, data: string, signal: AbortSignal) {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    throw new ProviderError('CANCELLED', 'The client closed the response stream.', { cause: signal.reason });
  }
  if (response.write(data)) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ProviderError('CANCELLED', 'The client closed the response stream.'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(new ProviderError('CANCELLED', 'The response stream was cancelled.', { cause: signal.reason }));
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function resolveCorsOrigins(options: GatewayServerOptions) {
  const configured = options.corsOrigins ?? (options.corsOrigin ? [options.corsOrigin] : defaultCorsOrigins);
  const origins = [...new Set(configured.map((origin) => origin.trim()).filter(Boolean))];
  if (origins.includes('*')) throw new Error('Wildcard CORS is not allowed for the local gateway.');
  return origins;
}

function getRequestOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  return typeof origin === 'string' ? origin : undefined;
}

/**
 * Cline redirects the browser to a loopback address, so the callback is a page
 * the gateway serves itself. It only shows the code for the user to copy back
 * into the dashboard; it never stores a token on its own.
 */
function defaultClineRedirect(publicBaseUrl: string | undefined) {
  return `${publicBaseUrl ?? 'http://127.0.0.1:8787'}/v1/oauth/cline/callback`;
}

function isCrossSiteRequest(request: IncomingMessage) {
  return request.headers['sec-fetch-site'] === 'cross-site';
}

/** The single GET navigation the OAuth provider is allowed to redirect to. */
function isOauthCallbackNavigation(request: IncomingMessage) {
  if (request.method !== 'GET') return false;
  const path = (request.url ?? '').split('?', 1)[0];
  return path === clineCallbackPath;
}

function isJsonRequest(request: IncomingMessage) {
  const contentType = request.headers['content-type'];
  return typeof contentType === 'string' && (contentType.split(';', 1)[0] ?? '').trim().toLowerCase() === 'application/json';
}

function setCors(response: ServerResponse, origin: string | undefined) {
  if (origin) response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-headers', 'content-type, x-omnihilbras-provider, authorization, x-api-key, x-goog-api-key');
  response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('vary', 'Origin');
}

function sendJson(response: ServerResponse, status: number, body: unknown, origin?: string) {
  const payload = JSON.stringify(body);
  if (origin) response.setHeader('access-control-allow-origin', origin);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendHtml(response: ServerResponse, status: number, html: string, origin?: string) {
  if (origin) response.setHeader('access-control-allow-origin', origin);
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    // This page lives on the origin that also holds credentials, so it gets no
    // script, no framing, and no caching of the code it displays.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'",
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(html);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] as string);
}

/**
 * The page Cline lands on after sign-in. It shows the authorization code so the
 * user can paste it back into the dashboard, and does nothing else: no token
 * is exchanged and nothing is stored from here.
 *
 * The code is only reflected when it matches the shape an authorization code
 * can have. That charset contains no markup characters, so the page cannot be
 * used to inject content into an origin that holds the local API keys.
 */
function clineCallbackPage(code: string, providerError: string | null) {
  const reflectable = /^[A-Za-z0-9._~+/=%-]{1,4096}$/;
  const showCode = code.length > 0 && reflectable.test(code);
  const body = providerError
    ? `<p class="bad">Cline reported <code>${escapeHtml(providerError.slice(0, 120))}</code>. Close this tab and start again.</p>`
    : showCode
      ? `<p class="lead">Copy this code and paste it into the OmniHilbras Cline dialog.</p>
         <input class="box" type="text" value="${escapeHtml(code)}" readonly spellcheck="false" aria-label="Authorization code" />
         <p class="note">Click the field, press <kbd>Ctrl</kbd>+<kbd>A</kbd> (or <kbd>Cmd</kbd>+<kbd>A</kbd>), then copy. Nothing has been saved yet — the code is exchanged only when you paste it.</p>`
      : `<p class="bad">This callback has no authorization code. Close this tab and start the sign-in again.</p>`;

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Cline sign-in complete</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d10; color: #e6e8eb;
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: min(560px, calc(100% - 2rem)); }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  .lead { margin: 0 0 1rem; color: #aeb4bb; }
  .box { width: 100%; padding: .7rem .8rem; border-radius: 8px; border: 1px solid #2a2f36; background: #14181d;
         color: #e6e8eb; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .note { margin: 1rem 0 0; color: #8b9299; font-size: 12px; }
  .bad { color: #f08a8a; }
  kbd { border: 1px solid #2a2f36; border-radius: 4px; padding: 0 .25rem; font: inherit; font-size: 11px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
<main>
  <h1>Cline sign-in complete</h1>
  ${body}
</main>
</html>`;
}

function sendError(response: ServerResponse, error: unknown) {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.end();
    return;
  }
  const status = statusForError(error);
  if (status === 401 && !response.hasHeader('www-authenticate')) {
    response.setHeader('www-authenticate', 'Bearer realm="omnihilbras"');
  }
  sendJson(response, status, toErrorEnvelope(error));
}

function toErrorEnvelope(error: unknown) {
  if (error instanceof ProviderError) {
    return {
      error: {
        code: error.code,
        message: error.publicMessage ?? publicProviderMessage(error.code),
        ...(error.providerId ? { provider: error.providerId } : {}),
        ...(error.statusCode ? { status: error.statusCode } : {}),
        ...(error.retryable ? { retryable: true } : {}),
      },
    };
  }
  return { error: { code: 'INTERNAL_ERROR', message: 'The gateway encountered an unexpected error.' } };
}

function statusForError(error: unknown) {
  if (!(error instanceof ProviderError)) return 500;
  if (error.code === 'INVALID_REQUEST') return 400;
  if (error.code === 'AUTHENTICATION_FAILED') return 401;
  if (error.code === 'NOT_SUPPORTED') return 501;
  if (error.code === 'NOT_FOUND') return 404;
  if (error.code === 'RATE_LIMITED') return 429;
  if (error.code === 'PROVIDER_TIMEOUT') return 504;
  if (error.code === 'CANCELLED') return 499;
  if (error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'PROVIDER_REQUEST_FAILED' || error.code === 'INVALID_RESPONSE') return 502;
  return 500;
}

function invalidRequest(message: string) {
  return new ProviderError('INVALID_REQUEST', message, { publicMessage: message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type GatewayServer = Server;
