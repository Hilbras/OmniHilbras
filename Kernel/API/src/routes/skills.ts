import type { RouteContext } from './route-context.js';
import { invalidRequest, isRecord, readJsonBody, sendJson } from '../core/http.js';
import { ProviderError } from '../core/provider-error.js';

const skillsPrefix = '/v1/skills';

function store(ctx: RouteContext) {
  const skills = ctx.service.skills;
  if (!skills) {
    throw new ProviderError('NOT_SUPPORTED', 'This gateway was not configured with a skill store.', {
      publicMessage: 'Skills are not available in this gateway build.',
    });
  }
  return skills;
}

function decodeId(pathname: string) {
  return decodeURIComponent(pathname.slice(`${skillsPrefix}/`.length));
}

export async function handleSkillsRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin } = ctx;

  if (request.method === 'GET' && url.pathname === skillsPrefix) {
    sendJson(response, 200, { object: 'list', data: await store(ctx).list() }, origin);
    return true;
  }

  if (request.method === 'GET' && url.pathname.startsWith(`${skillsPrefix}/`)) {
    const id = decodeId(url.pathname);
    const skill = await store(ctx).get(id);
    if (!skill) throw new ProviderError('NOT_FOUND', `Skill "${id}" does not exist.`, { publicMessage: 'That skill does not exist.' });
    sendJson(response, 200, { skill }, origin);
    return true;
  }

  if (request.method === 'POST' && url.pathname === skillsPrefix) {
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
    if (typeof body.id !== 'string' || !body.id.trim()) throw invalidRequest('id must be a non-empty string.');
    const input = {
      id: body.id.trim(),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.content === 'string' ? { content: body.content } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    };
    const skill = await store(ctx).save(input);
    sendJson(response, 201, { skill }, origin);
    return true;
  }

  if ((request.method === 'PUT' || request.method === 'PATCH') && url.pathname.startsWith(`${skillsPrefix}/`)) {
    const id = decodeId(url.pathname);
    const body = await readJsonBody(request, ctx.options.maxBodyBytes ?? 1_000_000);
    if (!isRecord(body)) throw invalidRequest('The request body must be a JSON object.');
    const input = {
      id,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.content === 'string' ? { content: body.content } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    };
    const skill = await store(ctx).save(input);
    sendJson(response, 200, { skill }, origin);
    return true;
  }

  if (request.method === 'DELETE' && url.pathname.startsWith(`${skillsPrefix}/`)) {
    const id = decodeId(url.pathname);
    const deleted = await store(ctx).remove(id);
    if (!deleted) throw new ProviderError('NOT_FOUND', `Skill "${id}" does not exist.`, { publicMessage: 'That skill does not exist.' });
    sendJson(response, 200, { deleted: true, id }, origin);
    return true;
  }

  return false;
}
