import type { RouteContext } from './route-context.js';
import { invalidRequest, isRecord, readJsonBody, sendJson } from '../core/http.js';
import { ProviderError } from '../core/provider-error.js';

const proxyPoolsPrefix = '/v1/proxy-pools';

function store(ctx: RouteContext) {
  const ps = ctx.service.proxyPools;
  if (!ps) throw new ProviderError('NOT_SUPPORTED', 'Proxy pools are not available in this gateway build.', { publicMessage: 'Proxy pools are not available.' });
  return ps;
}

function decodeId(pathname: string) {
  return decodeURIComponent(pathname.slice(`${proxyPoolsPrefix}/`.length));
}

export async function handleProxyPoolsRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin } = ctx;

  if (request.method === 'GET' && url.pathname === proxyPoolsPrefix) {
    sendJson(response, 200, { object: 'list', data: await store(ctx).list() }, origin);
    return true;
  }
  if (request.method === 'GET' && url.pathname.startsWith(`${proxyPoolsPrefix}/`)) {
    const id = decodeId(url.pathname);
    const p = await store(ctx).get(id);
    if (!p) throw new ProviderError('NOT_FOUND', `Proxy pool "${id}" does not exist.`, { publicMessage: 'That proxy pool does not exist.' });
    sendJson(response, 200, { proxyPool: p }, origin);
    return true;
  }
  if (request.method === 'POST' && url.pathname === proxyPoolsPrefix) {
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
    if (typeof body.id !== 'string' || !body.id.trim()) throw invalidRequest('id must be a non-empty string.');
    const input: any = {
      id: body.id.trim(),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(Array.isArray(body.proxies) ? { proxies: body.proxies } : {}),
      ...(typeof body.strategy === 'string' ? { strategy: body.strategy } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    };
    const p = await store(ctx).save(input);
    sendJson(response, 201, { proxyPool: p }, origin);
    return true;
  }
  if ((request.method === 'PUT' || request.method === 'PATCH') && url.pathname.startsWith(`${proxyPoolsPrefix}/`)) {
    const id = decodeId(url.pathname);
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
    const input: any = {
      id,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(Array.isArray(body.proxies) ? { proxies: body.proxies } : {}),
      ...(typeof body.strategy === 'string' ? { strategy: body.strategy } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    };
    const p = await store(ctx).save(input);
    sendJson(response, 200, { proxyPool: p }, origin);
    return true;
  }
  if (request.method === 'DELETE' && url.pathname.startsWith(`${proxyPoolsPrefix}/`)) {
    const id = decodeId(url.pathname);
    const deleted = await store(ctx).remove(id);
    if (!deleted) throw new ProviderError('NOT_FOUND', `Proxy pool "${id}" does not exist.`, { publicMessage: 'That proxy pool does not exist.' });
    sendJson(response, 200, { deleted: true, id }, origin);
    return true;
  }
  return false;
}
