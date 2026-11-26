import type { RouteContext } from './route-context.js';
import { invalidRequest, isRecord, readJsonBody, sendJson } from '../core/http.js';
import { renderPrompt } from '../core/prompts.js';

const promptsPath = '/v1/prompts';

/**
 * `/v1/prompts` — versioned prompt content.
 *
 * A prompt edit appends a version; activating an older one is a single call, so a bad edit is
 * reversible. Rendering refuses a missing variable rather than sending `{{name}}` to a model.
 */
export async function handlePromptsRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin } = ctx;
  if (url.pathname === promptsPath) {
    // fall through; the literal equality is what the route-contract guard reads
  } else if (!url.pathname.startsWith(`${promptsPath}/`)) {
    return false;
  }
  const store = service.prompts;
  if (!store) {
    sendJson(response, 200, { available: false, reason: 'This gateway was started without a prompt store.' }, origin);
    return true;
  }
  const rest = url.pathname.slice(promptsPath.length + 1);
  const [id, action] = rest.split('/');

  if (request.method === 'GET' && url.pathname === promptsPath) {
    sendJson(response, 200, { available: true, prompts: await store.list() }, origin);
    return true;
  }
  if (request.method === 'POST' && url.pathname === promptsPath) {
    const body = await readJsonBody(request, Math.min(ctx.options.maxBodyBytes ?? 1_000_000, 256 * 1024));
    if (!isRecord(body) || typeof body.id !== 'string' || typeof body.content !== 'string') throw invalidRequest('id and content are required.');
    try {
      const prompt = await store.save({ id: body.id, content: body.content, ...(typeof body.name === 'string' ? { name: body.name } : {}), ...(typeof body.description === 'string' ? { description: body.description } : {}) });
      sendJson(response, 201, { prompt }, origin);
    } catch (error) { throw invalidRequest(error instanceof Error ? error.message : 'The prompt could not be saved.'); }
    return true;
  }
  if (!id) return false;
  const decoded = decodeURIComponent(id);
  if (request.method === 'GET' && action === undefined) {
    const prompt = await store.get(decoded);
    if (!prompt) throw invalidRequest('That prompt does not exist.');
    sendJson(response, 200, { prompt }, origin);
    return true;
  }
  if (request.method === 'POST' && action === 'versions') {
    const body = await readJsonBody(request, 256 * 1024);
    if (!isRecord(body) || typeof body.content !== 'string') throw invalidRequest('content is required.');
    try {
      const prompt = await store.save({ id: decoded, content: body.content, ...(body.activate === false ? { activate: false } : {}) });
      sendJson(response, 201, { prompt }, origin);
    } catch (error) { throw invalidRequest(error instanceof Error ? error.message : 'The version could not be saved.'); }
    return true;
  }
  if (request.method === 'POST' && action === 'activate') {
    const body = await readJsonBody(request, 16 * 1024);
    if (!isRecord(body) || typeof body.version !== 'number') throw invalidRequest('version is required.');
    const prompt = await store.activate(decoded, body.version);
    if (!prompt) throw invalidRequest('That prompt does not exist.');
    sendJson(response, 200, { prompt }, origin);
    return true;
  }
  if (request.method === 'POST' && action === 'render') {
    const body = await readJsonBody(request, 256 * 1024);
    const values = isRecord(body) && isRecord(body.values) ? body.values as Record<string, string | number | boolean> : {};
    const prompt = await store.get(decoded);
    if (!prompt) throw invalidRequest('That prompt does not exist.');
    const version = prompt.versions.find((candidate) => candidate.version === prompt.activeVersion);
    if (!version) throw invalidRequest('That prompt has no active version.');
    try {
      sendJson(response, 200, { id: prompt.id, version: version.version, content: renderPrompt(version.content, values) }, origin);
    } catch (error) { throw invalidRequest(error instanceof Error ? error.message : 'The prompt could not be rendered.'); }
    return true;
  }
  if (request.method === 'DELETE' && action === undefined) {
    const removed = await store.remove(decoded);
    if (!removed) throw invalidRequest('That prompt does not exist.');
    sendJson(response, 200, { deleted: true, id: decoded }, origin);
    return true;
  }
  sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Unsupported prompt method.' } }, origin);
  return true;
}
