/**
 * Virtual models: one public `oh/` id mapped to several saved account/upstream-model targets.
 *
 * These are management routes. The structural contract is the store's; the connection and model claims
 * are checked here, because only the route knows the current connection catalog.
 */

import type { RouteContext } from './route-context.js';
import {
  invalidRequest,
  isRecord,
  readJsonBody,
  sendJson,
} from '../core/http.js';
import {
  normalizeVirtualModelInput,
  type VirtualModelInput,
} from '../core/virtual-models.js';
import { ProviderError } from '../core/provider-error.js';

const prefix = '/v1/virtual-models';

function store(ctx: RouteContext) {
  const virtualModels = ctx.service.virtualModels;
  if (!virtualModels) {
    throw new ProviderError('NOT_SUPPORTED', 'This gateway was not configured with a virtual-model store.', {
      publicMessage: 'Virtual models are not available in this gateway build.',
    });
  }
  return virtualModels;
}

function decodeId(pathname: string) {
  return decodeURIComponent(pathname.slice(`${prefix}/`.length));
}

function parseBody(raw: unknown, forcedId?: string): VirtualModelInput {
  if (!isRecord(raw)) throw invalidRequest('The request body must be a JSON object.');
  const id = forcedId ?? raw.id;
  if (typeof id !== 'string') throw invalidRequest('id must be an "oh/" model id.');
  if (raw.targets !== undefined && !Array.isArray(raw.targets)) throw invalidRequest('targets must be an array.');
  if (raw.strategy !== undefined && typeof raw.strategy !== 'string') throw invalidRequest('strategy must be a string.');
  if (raw.name !== undefined && typeof raw.name !== 'string') throw invalidRequest('name must be a string.');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw invalidRequest('enabled must be a boolean.');
  const targets = (raw.targets ?? []).map((target) => {
    if (!isRecord(target)) throw invalidRequest('Every target must be an object.');
    if (typeof target.connectionId !== 'string') throw invalidRequest('Every target needs a connectionId.');
    if (typeof target.upstreamModelId !== 'string') throw invalidRequest('Every target needs an upstreamModelId.');
    return {
      connectionId: target.connectionId,
      upstreamModelId: target.upstreamModelId,
      ...(typeof target.priority === 'number' ? { priority: target.priority } : {}),
      ...(typeof target.enabled === 'boolean' ? { enabled: target.enabled } : {}),
    };
  });
  try {
    return normalizeVirtualModelInput({
      id,
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
      ...(typeof raw.strategy === 'string' ? { strategy: raw.strategy as VirtualModelInput['strategy'] } : {}),
      targets,
    });
  } catch (error) {
    throw invalidRequest(error instanceof Error ? error.message : 'The virtual model is invalid.');
  }
}

async function validateTargets(ctx: RouteContext, input: VirtualModelInput) {
  const connections = await ctx.service.listConnections();
  for (const target of input.targets) {
    const connection = connections.find((entry) => entry.id === target.connectionId);
    if (!connection) throw invalidRequest(`Connection "${target.connectionId}" does not exist.`);
    if (!connection.modelIds.includes(target.upstreamModelId)) {
      throw invalidRequest(`Connection "${target.connectionId}" does not list model "${target.upstreamModelId}".`);
    }
  }
}

export async function handleVirtualModelsRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin } = ctx;

  if (request.method === 'GET' && url.pathname === prefix) {
    sendJson(response, 200, { object: 'list', data: await store(ctx).list() }, origin);
    return true;
  }

  if (request.method === 'POST' && url.pathname === prefix) {
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    const input = parseBody(body);
    await validateTargets(ctx, input);
    const model = await store(ctx).save(input);
    sendJson(response, 201, { model }, origin);
    return true;
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && url.pathname.startsWith(`${prefix}/`)) {
    const id = decodeId(url.pathname);
    if (!id || id.includes('/') && !id.startsWith('oh/')) throw invalidRequest('The path is not a virtual model id.');
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (isRecord(body) && body.id !== undefined && body.id !== id) throw invalidRequest('The body id must match the path id.');
    const input = parseBody(body, id);
    await validateTargets(ctx, input);
    const model = await store(ctx).save(input);
    sendJson(response, 200, { model }, origin);
    return true;
  }

  if (request.method === 'DELETE' && url.pathname.startsWith(`${prefix}/`)) {
    const id = decodeId(url.pathname);
    const deleted = await store(ctx).remove(id);
    if (!deleted) throw new ProviderError('NOT_FOUND', `Virtual model "${id}" does not exist.`, { publicMessage: 'That virtual model does not exist.' });
    sendJson(response, 200, { deleted: true, id }, origin);
    return true;
  }

  return false;
}
