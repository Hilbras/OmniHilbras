/**
 * The API keys the LLM surface authenticates with, and the setting that decides whether they are required.
 */

import type { RouteContext } from './route-context.js';
import {
  assertOnlyFields,
  invalidRequest,
  isRecord,
  maxConnectionBodyBytes,
  maxKeyBodyBytes,
  parseBoundedString,
  readJsonBody,
  sendJson,
} from '../http.js';

export async function handleApiKeysRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, options } = ctx;

    if (request.method === 'GET' && url.pathname === '/v1/keys') {
      sendJson(response, 200, { object: 'list', ...(await service.listApiKeys()) }, origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/keys') {
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxKeyBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['name']);
      const created = await service.createApiKey(parseBoundedString(body.name, 'name', 80));
      sendJson(response, 201, { apiKey: created.record, key: created.key }, origin);
      return true;
    }

    if (request.method === 'PUT' && url.pathname === '/v1/settings/require-api-key') {
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxKeyBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['requireApiKey']);
      if (typeof body.requireApiKey !== 'boolean') throw invalidRequest('requireApiKey must be a boolean.');
      sendJson(response, 200, { requireApiKey: await service.setRequireApiKey(body.requireApiKey) }, origin);
      return true;
    }

    if (request.method === 'PATCH' && url.pathname.startsWith('/v1/keys/')) {
      const apiKeyId = decodeApiKeyId(url.pathname.slice('/v1/keys/'.length));
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxKeyBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['enabled']);
      if (typeof body.enabled !== 'boolean') throw invalidRequest('enabled must be a boolean.');
      sendJson(response, 200, { apiKey: await service.setApiKeyEnabled(apiKeyId, body.enabled) }, origin);
      return true;
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/v1/keys/')) {
      const apiKeyId = decodeApiKeyId(url.pathname.slice('/v1/keys/'.length));
      await service.removeApiKey(apiKeyId);
      sendJson(response, 200, { deleted: true, id: apiKeyId }, origin);
      return true;
    }


  return false;
}

export function decodeApiKeyId(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalidRequest('API key id is invalid.');
  }
  if (!/^key_[A-Za-z0-9_-]{1,32}$/.test(decoded)) throw invalidRequest('API key id is invalid.');
  return decoded;
}

