/**
 * Creating, checking, deleting and listing provider connections, and the parsers that validate those bodies.
 */

import { assertSafeProviderRequestUrl, type ModelImportPolicy, type ProviderCredential } from '@hilbras/omnihilbras';
import type { RouteContext } from './route-context.js';

/** The body the dashboard sends when it saves an OpenRouter connection. */
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
import {
  assertOnlyFields,
  invalidRequest,
  isRecord,
  maxConnectionBodyBytes,
  parseApiKey,
  parseBoundedInteger,
  parseBoundedString,
  parseConnectionId,
  parseIdentifier,
  parseModelPolicy,
  parsePriority,
  readJsonBody,
  sendJson,
} from '../http.js';

export async function handleConnectionsRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, options, signal } = ctx;

    if (request.method === 'GET' && url.pathname === '/v1/connections') {
      sendJson(response, 200, { object: 'list', data: await service.listConnections() }, origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/connections/openrouter/check') {
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxConnectionBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['apiKey']);
      const credential = parseApiKey(body);
      sendJson(response, 200, await service.validateConnectionCredential('openrouter', credential, signal), origin);
      return true;
    }

    if (request.method === 'PUT' && url.pathname === '/v1/connections/openrouter') {
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxConnectionBodyBytes));
      const { credential, ...input } = parseOpenRouterConnectionRequest(body);
      const connection = await service.saveConnection(input, credential, signal);
      sendJson(response, 200, { connection }, origin);
      return true;
    }

    // Any other provider: the endpoint and paths are caller-supplied, so this
    // covers Anthropic, Gemini, Ollama, and arbitrary OpenAI-compatible servers.
    if (request.method === 'PUT' && url.pathname.startsWith('/v1/connections/') && !url.pathname.endsWith('/models') && !url.pathname.endsWith('/resilience')) {
      const providerId = decodeProviderId(url.pathname.slice('/v1/connections/'.length));
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxConnectionBodyBytes));
      const { credential, ...input } = parseGenericConnectionRequest(body, providerId);
      const connection = await service.saveConnection(input, credential, signal);
      sendJson(response, 200, { connection }, origin);
      return true;
    }

    // Re-reads a saved connection's catalog. A connection can be saved with no models
    // when a sign-in could not read one, and this is the way back without signing in
    // again — which for a device flow would mean another browser approval.
    if (request.method === 'POST' && url.pathname.endsWith('/models/refresh') && url.pathname.startsWith('/v1/connections/')) {
      const connectionId = decodeConnectionId(url.pathname.slice('/v1/connections/'.length, -'/models/refresh'.length));
      const connection = await service.refreshConnectionModels(connectionId, signal);
      sendJson(response, 200, { connection }, origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname.endsWith('/check') && url.pathname.startsWith('/v1/connections/')) {
      const providerId = decodeProviderId(url.pathname.slice('/v1/connections/'.length, -'/check'.length));
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxConnectionBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['apiKey', 'endpoint']);
      const credential = parseApiKey(body);
      if (typeof body.endpoint === 'string' && body.endpoint.trim()) assertSafeEndpoint(body.endpoint.trim(), providerId);
      sendJson(response, 200, await service.validateConnectionCredential(providerId, credential, signal), origin);
      return true;
    }

    if (request.method === 'PUT' && url.pathname.endsWith('/resilience') && url.pathname.startsWith('/v1/connections/')) {
      const encodedConnectionId = url.pathname.slice('/v1/connections/'.length, -'/resilience'.length);
      const connectionId = decodeConnectionId(encodedConnectionId);
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxConnectionBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['timeoutMs', 'maxRetries', 'requestsPerMinute', 'hedgeAfterMs']);
      const connection = await service.updateConnectionResilience(connectionId, parseResilienceInput(body));
      sendJson(response, 200, { connection }, origin);
      return true;
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
      return true;
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/v1/connections/')) {
      const connectionId = decodeConnectionId(url.pathname.slice('/v1/connections/'.length));
      await service.removeConnection(connectionId);
      sendJson(response, 200, { deleted: true, id: connectionId }, origin);
      return true;
    }


  return false;
}

export const openRouterEndpoint = 'https://openrouter.ai/api/v1' as const;


export function parseOpenRouterConnectionRequest(body: unknown): OpenRouterConnectionRequest {
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


export function decodeProviderId(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidRequest('provider id is invalid.');
  }
  return parseIdentifier(decoded, 'provider id');
}


export function parseGenericConnectionRequest(body: unknown, providerId: string): { id?: string; providerId: string; name: string; endpoint: string; priority: number; proxyPool: string; enabled?: boolean; modelPolicy?: ModelImportPolicy; credential: ProviderCredential } {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
  // `id` is accepted so a caller can add a second connection for a provider that
  // already has one. Omitting it reuses that provider's existing connection.
  assertOnlyFields(body, ['apiKey', 'name', 'endpoint', 'id', 'priority', 'proxyPool', 'enabled', 'modelPolicy', 'resilience']);
  const endpoint = body.endpoint === undefined ? '' : parseBoundedString(body.endpoint, 'endpoint', 2048);
  if (!endpoint) throw invalidRequest('endpoint is required.');
  assertSafeEndpoint(endpoint, providerId);
  const name = body.name === undefined ? providerId : parseBoundedString(body.name, 'name', 120);
  const id = body.id === undefined ? undefined : parseConnectionId(body.id);
  const priority = body.priority === undefined ? 1 : parsePriority(body.priority);
  const proxyPool = body.proxyPool === undefined ? 'none' : parseBoundedString(body.proxyPool, 'proxyPool', 128, true);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw invalidRequest('enabled must be a boolean.');
  return {
    ...(id === undefined ? {} : { id }),
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


export function parseResilienceInput(body: Record<string, unknown>) {
  const resilience: { timeoutMs?: number; maxRetries?: number; requestsPerMinute?: number; hedgeAfterMs?: number } = {};
  if (body.timeoutMs !== undefined) resilience.timeoutMs = parseBoundedInteger(body.timeoutMs, 'timeoutMs', 0, 600_000);
  if (body.maxRetries !== undefined) resilience.maxRetries = parseBoundedInteger(body.maxRetries, 'maxRetries', 0, 5);
  if (body.requestsPerMinute !== undefined) resilience.requestsPerMinute = parseBoundedInteger(body.requestsPerMinute, 'requestsPerMinute', 0, 100_000);
  if (body.hedgeAfterMs !== undefined) resilience.hedgeAfterMs = parseBoundedInteger(body.hedgeAfterMs, 'hedgeAfterMs', 0, 30_000);
  if (Object.keys(resilience).length === 0) throw invalidRequest('At least one resilience field is required.');
  return resilience;
}


export function parseModelIds(value: unknown) {
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


export function decodeConnectionId(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidRequest('connection id is invalid.');
  }
  return parseIdentifier(decoded, 'connection id');
}


export function assertSafeEndpoint(endpoint: string, providerId: string) {
  assertSafeProviderRequestUrl(endpoint, providerId);
}

/**
 * Connection input for any provider other than OpenRouter. The endpoint is
 * required so the adapter can be pointed at a real server, and the model
 * policy is optional so a caller can save before importing a catalog.
 */


/** Returns the provider the caller asked for, or undefined to let the catalog decide. */
