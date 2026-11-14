import type { RouteContext } from './route-context.js';
import { invalidRequest, isRecord, readJsonBody, sendJson } from '../core/http.js';
import { publicTunnel } from '../core/tunnels.js';
import { ProviderError } from '../core/provider-error.js';

const tunnelsPrefix = '/v1/tunnels';

function store(ctx: RouteContext) {
  const ts = ctx.service.tunnels;
  if (!ts) throw new ProviderError('NOT_SUPPORTED', 'Tunnels are not available in this gateway build.', { publicMessage: 'Tunnels are not available.' });
  return ts;
}

function decodeId(pathname: string) {
  return decodeURIComponent(pathname.slice(`${tunnelsPrefix}/`.length));
}

export async function handleTunnelsRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin } = ctx;

  if (request.method === 'GET' && url.pathname === tunnelsPrefix) {
    sendJson(response, 200, { object: 'list', data: (await store(ctx).list()).map(publicTunnel) }, origin);
    return true;
  }
  if (request.method === 'GET' && url.pathname.startsWith(`${tunnelsPrefix}/`)) {
    const id = decodeId(url.pathname);
    const t = await store(ctx).get(id);
    if (!t) throw new ProviderError('NOT_FOUND', `Tunnel "${id}" does not exist.`, { publicMessage: 'That tunnel does not exist.' });
    sendJson(response, 200, { tunnel: publicTunnel(t) }, origin);
    return true;
  }
  if (request.method === 'POST' && url.pathname === tunnelsPrefix) {
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
    if (typeof body.id !== 'string' || !body.id.trim()) throw invalidRequest('id must be a non-empty string.');
    const input: any = {
      id: body.id.trim(),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.provider === 'string' ? { provider: body.provider } : {}),
      ...(typeof body.token === 'string' ? { token: body.token } : {}),
      ...(typeof body.publicUrl === 'string' ? { publicUrl: body.publicUrl } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    };
    const t = await store(ctx).save(input);
    sendJson(response, 201, { tunnel: publicTunnel(t) }, origin);
    return true;
  }
  if ((request.method === 'PUT' || request.method === 'PATCH') && url.pathname.startsWith(`${tunnelsPrefix}/`)) {
    const id = decodeId(url.pathname);
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
    const input: any = {
      id,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.provider === 'string' ? { provider: body.provider } : {}),
      ...(typeof body.token === 'string' ? { token: body.token } : {}),
      ...(typeof body.publicUrl === 'string' ? { publicUrl: body.publicUrl } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    };
    const t = await store(ctx).save(input);
    sendJson(response, 200, { tunnel: publicTunnel(t) }, origin);
    return true;
  }
  if (request.method === 'DELETE' && url.pathname.startsWith(`${tunnelsPrefix}/`)) {
    const id = decodeId(url.pathname);
    const deleted = await store(ctx).remove(id);
    if (!deleted) throw new ProviderError('NOT_FOUND', `Tunnel "${id}" does not exist.`, { publicMessage: 'That tunnel does not exist.' });
    sendJson(response, 200, { deleted: true, id }, origin);
    return true;
  }
  return false;
}
