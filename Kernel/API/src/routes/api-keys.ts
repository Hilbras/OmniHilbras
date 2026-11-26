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
} from '../core/http.js';

export async function handleApiKeysRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin, options, auth } = ctx;
  const scope = auth?.apiKey?.workspaceId;
  const findScopedKey = async (id: string) => {
    if (!scope) return undefined;
    const listed = await service.listApiKeys();
    return listed.keys.find((key) => key.id === id && key.workspaceId !== scope);
  };

    if (request.method === 'GET' && url.pathname === '/v1/keys') {
      const listed = await service.listApiKeys();
      sendJson(response, 200, { object: 'list', ...listed, keys: scope ? listed.keys.filter((key) => key.workspaceId === scope) : listed.keys }, origin);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/v1/keys') {
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxKeyBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['name', 'workspaceId', 'role']);
      const name = parseBoundedString(body.name, 'name', 80);
      // A workspace scope is optional; validate its shape here so a malformed value never reaches the store.
      const requestedWorkspace = body.workspaceId === undefined ? undefined : parseBoundedString(body.workspaceId, 'workspaceId', 64);
      if (requestedWorkspace !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(requestedWorkspace)) throw invalidRequest('workspaceId must be an identifier.');
      if (scope && requestedWorkspace !== undefined && requestedWorkspace !== scope) throw invalidRequest('This key cannot mint a key in another workspace.');
      const workspaceId = scope ?? requestedWorkspace;
      const role = body.role === undefined ? 'owner' : body.role;
      if (role !== 'owner' && role !== 'viewer') throw invalidRequest('role must be owner or viewer.');
      const created = await service.createApiKey(name, workspaceId, role);
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
      if (await findScopedKey(apiKeyId)) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'API key not found.' } }, origin);
        return true;
      }
      const body = await readJsonBody(request, Math.min(options.maxBodyBytes ?? maxConnectionBodyBytes, maxKeyBodyBytes));
      if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object.');
      assertOnlyFields(body, ['enabled', 'name', 'rpm', 'expiresAt']);
      // One intent per request. Four fields, four meanings, and a body carrying two makes "which one happened" a
      // question about field order — the answer to which nobody should have to read this file to find.
      const present = ['enabled', 'name', 'rpm', 'expiresAt'].filter((field) => body[field] !== undefined);
      if (present.length !== 1) {
        throw invalidRequest('Send exactly one of enabled, name, rpm or expiresAt.');
      }
      if (body.rpm !== undefined || body.expiresAt !== undefined) {
        const rpm = body.rpm === undefined ? undefined : body.rpm;
        if (rpm !== undefined && rpm !== null && (!Number.isInteger(rpm) || (rpm as number) <= 0 || (rpm as number) > 100_000)) {
          throw invalidRequest('rpm must be a positive whole number of at most 100000, or null to remove the limit.');
        }
        if (body.expiresAt !== undefined && body.expiresAt !== null) {
          if (typeof body.expiresAt !== 'string' || Number.isNaN(Date.parse(body.expiresAt))) {
            throw invalidRequest('expiresAt must be an ISO date, or null to remove the expiry.');
          }
        }
        const limits = {
          ...(body.rpm === undefined ? {} : { rpm: body.rpm as number | null }),
          ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt as string | null }),
        };
        sendJson(response, 200, { apiKey: await service.setApiKeyLimits(apiKeyId, limits) }, origin);
        return true;
      }
      if (body.name !== undefined) {
        sendJson(response, 200, { apiKey: await service.renameApiKey(apiKeyId, parseBoundedString(body.name, 'name', 80)) }, origin);
        return true;
      }
      if (typeof body.enabled !== 'boolean') throw invalidRequest('enabled must be a boolean.');
      sendJson(response, 200, { apiKey: await service.setApiKeyEnabled(apiKeyId, body.enabled) }, origin);
      return true;
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/v1/keys/')) {
      const apiKeyId = decodeApiKeyId(url.pathname.slice('/v1/keys/'.length));
      if (await findScopedKey(apiKeyId)) {
        sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'API key not found.' } }, origin);
        return true;
      }
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

