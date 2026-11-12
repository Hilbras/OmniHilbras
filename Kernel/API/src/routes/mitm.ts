import type { RouteContext } from './route-context.js';
import { invalidRequest, isRecord, readJsonBody, sendJson } from '../core/http.js';
import { ProviderError } from '../core/provider-error.js';

const mitmPrefix = '/v1/mitm';

function store(ctx: RouteContext) {
  const ms = ctx.service.mitm;
  if (!ms) throw new ProviderError('NOT_SUPPORTED', 'MITM is not available in this gateway build.', { publicMessage: 'MITM is not available.' });
  return ms;
}

function decodeId(pathname: string) {
  return decodeURIComponent(pathname.slice(`${mitmPrefix}/`.length));
}

export async function handleMitmRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin } = ctx;

  if (request.method === 'GET' && url.pathname === mitmPrefix) {
    sendJson(response, 200, { object: 'list', data: await store(ctx).list() }, origin);
    return true;
  }
  if (request.method === 'GET' && url.pathname.startsWith(`${mitmPrefix}/`)) {
    const id = decodeId(url.pathname);
    const m = await store(ctx).get(id);
    if (!m) throw new ProviderError('NOT_FOUND', `MITM "${id}" does not exist.`, { publicMessage: 'That MITM config does not exist.' });
    sendJson(response, 200, { mitm: m }, origin);
    return true;
  }
  if (request.method === 'POST' && url.pathname === mitmPrefix) {
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
    if (typeof body.id !== 'string' || !body.id.trim()) throw invalidRequest('id must be a non-empty string.');
    const input: any = {
      id: body.id.trim(),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.port === 'number' ? { port: body.port } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.certPath === 'string' ? { certPath: body.certPath } : {}),
    };
    const m = await store(ctx).save(input);
    sendJson(response, 201, { mitm: m }, origin);
    return true;
  }
  if ((request.method === 'PUT' || request.method === 'PATCH') && url.pathname.startsWith(`${mitmPrefix}/`)) {
    const id = decodeId(url.pathname);
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
    const input: any = {
      id,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.port === 'number' ? { port: body.port } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.certPath === 'string' ? { certPath: body.certPath } : {}),
    };
    const m = await store(ctx).save(input);
    sendJson(response, 200, { mitm: m }, origin);
    return true;
  }
  if (request.method === 'DELETE' && url.pathname.startsWith(`${mitmPrefix}/`)) {
    const id = decodeId(url.pathname);
    const deleted = await store(ctx).remove(id);
    if (!deleted) throw new ProviderError('NOT_FOUND', `MITM "${id}" does not exist.`, { publicMessage: 'That MITM config does not exist.' });
    sendJson(response, 200, { deleted: true, id }, origin);
    return true;
  }
  return false;
}
