import type { RouteContext } from './route-context.js';
import { invalidRequest, isRecord, readJsonBody, sendJson } from '../core/http.js';
import { ProviderError } from '../core/provider-error.js';

const providerNodesPrefix = '/v1/provider-nodes';

function store(ctx: RouteContext) {
  const ps = ctx.service.providerNodes;
  if (!ps) throw new ProviderError('NOT_SUPPORTED', 'Provider nodes are not available in this gateway build.', { publicMessage: 'Provider nodes are not available.' });
  return ps;
}

function decodeId(pathname: string) {
  return decodeURIComponent(pathname.slice(`${providerNodesPrefix}/`.length));
}

export async function handleProviderNodesRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin } = ctx;

  if (request.method === 'GET' && url.pathname === providerNodesPrefix) {
    sendJson(response, 200, { object: 'list', data: await store(ctx).list() }, origin);
    return true;
  }
  if (request.method === 'GET' && url.pathname.startsWith(`${providerNodesPrefix}/`)) {
    const id = decodeId(url.pathname);
    const n = await store(ctx).get(id);
    if (!n) throw new ProviderError('NOT_FOUND', `Provider node "${id}" does not exist.`, { publicMessage: 'That provider node does not exist.' });
    sendJson(response, 200, { providerNode: n }, origin);
    return true;
  }
  if (request.method === 'POST' && url.pathname === providerNodesPrefix) {
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
    if (typeof body.id !== 'string' || !body.id.trim()) throw invalidRequest('id must be a non-empty string.');
    const input: any = {
      id: body.id.trim(),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.providerId === 'string' ? { providerId: body.providerId } : {}),
      ...(typeof body.connectionId === 'string' ? { connectionId: body.connectionId } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    };
    const n = await store(ctx).save(input);
    sendJson(response, 201, { providerNode: n }, origin);
    return true;
  }
  if ((request.method === 'PUT' || request.method === 'PATCH') && url.pathname.startsWith(`${providerNodesPrefix}/`)) {
    const id = decodeId(url.pathname);
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
    const input: any = {
      id,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.providerId === 'string' ? { providerId: body.providerId } : {}),
      ...(typeof body.connectionId === 'string' ? { connectionId: body.connectionId } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    };
    const n = await store(ctx).save(input);
    sendJson(response, 200, { providerNode: n }, origin);
    return true;
  }
  if (request.method === 'DELETE' && url.pathname.startsWith(`${providerNodesPrefix}/`)) {
    const id = decodeId(url.pathname);
    const deleted = await store(ctx).remove(id);
    if (!deleted) throw new ProviderError('NOT_FOUND', `Provider node "${id}" does not exist.`, { publicMessage: 'That provider node does not exist.' });
    sendJson(response, 200, { deleted: true, id }, origin);
    return true;
  }
  return false;
}
