import type { RouteContext } from './route-context.js';
import { invalidRequest, isRecord, readJsonBody, sendJson } from '../core/http.js';
import { ProviderError } from '../core/provider-error.js';

const workspacesPrefix = '/v1/workspaces';

function store(ctx: RouteContext) {
  const ws = ctx.service.workspaces;
  if (!ws) throw new ProviderError('NOT_SUPPORTED', 'Workspaces are not available in this gateway build.', { publicMessage: 'Workspaces are not available.' });
  return ws;
}

function decodeId(pathname: string) {
  return decodeURIComponent(pathname.slice(`${workspacesPrefix}/`.length));
}

export async function handleWorkspacesRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin } = ctx;

  if (request.method === 'GET' && url.pathname === workspacesPrefix) {
    sendJson(response, 200, { object: 'list', data: await store(ctx).list() }, origin);
    return true;
  }
  if (request.method === 'GET' && url.pathname.startsWith(`${workspacesPrefix}/`)) {
    const id = decodeId(url.pathname);
    const ws = await store(ctx).get(id);
    if (!ws) throw new ProviderError('NOT_FOUND', `Workspace "${id}" does not exist.`, { publicMessage: 'That workspace does not exist.' });
    sendJson(response, 200, { workspace: ws }, origin);
    return true;
  }
  if (request.method === 'POST' && url.pathname === workspacesPrefix) {
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
    if (typeof body.id !== 'string' || !body.id.trim()) throw invalidRequest('id must be a non-empty string.');
    const input = {
      id: body.id.trim(),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    };
    const ws = await store(ctx).save(input);
    sendJson(response, 201, { workspace: ws }, origin);
    return true;
  }
  if ((request.method === 'PUT' || request.method === 'PATCH') && url.pathname.startsWith(`${workspacesPrefix}/`)) {
    const id = decodeId(url.pathname);
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
    const input = {
      id,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    };
    const ws = await store(ctx).save(input);
    sendJson(response, 200, { workspace: ws }, origin);
    return true;
  }
  if (request.method === 'DELETE' && url.pathname.startsWith(`${workspacesPrefix}/`)) {
    const id = decodeId(url.pathname);
    const deleted = await store(ctx).remove(id);
    if (!deleted) throw new ProviderError('NOT_FOUND', `Workspace "${id}" does not exist.`, { publicMessage: 'That workspace does not exist.' });
    sendJson(response, 200, { deleted: true, id }, origin);
    return true;
  }
  return false;
}
