import type { RouteContext } from './route-context.js';
import { invalidRequest, isRecord, readJsonBody, sendJson } from '../core/http.js';
import { isWebhookEvent, type Webhook } from '../core/webhooks.js';

const webhooksPath = '/v1/webhooks';
const testPath = '/v1/webhooks/test';

/** The signing secret is returned once, at creation, and never listed again. */
function project(hook: Webhook, includeSecret = false) {
  return {
    id: hook.id,
    url: hook.url,
    events: hook.events,
    enabled: hook.enabled,
    createdAt: hook.createdAt,
    ...(includeSecret ? { secret: hook.secret } : {}),
  };
}

export async function handleWebhooksRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, service, origin } = ctx;
  if (url.pathname !== webhooksPath && !url.pathname.startsWith(`${webhooksPath}/`)) return false;
  const store = service.webhooks;
  if (!store) {
    sendJson(response, 200, { available: false, reason: 'This gateway was started without a webhook store.' }, origin);
    return true;
  }

  if (request.method === 'GET' && url.pathname === webhooksPath) {
    sendJson(response, 200, { available: true, webhooks: (await store.list()).map((hook) => project(hook)), deliveries: service.webhookDeliveries?.() ?? [] }, origin);
    return true;
  }

  if (request.method === 'POST' && url.pathname === webhooksPath) {
    const body = await readJsonBody(request, Math.min(ctx.options.maxBodyBytes ?? 1_000_000, 64 * 1024));
    if (!isRecord(body) || typeof body.url !== 'string') throw invalidRequest('A webhook needs a url.');
    const events = body.events === undefined ? undefined : body.events;
    if (events !== undefined && (!Array.isArray(events) || !events.every(isWebhookEvent))) throw invalidRequest('events must be known webhook event names.');
    try {
      const hook = await store.save({ url: body.url, ...(events === undefined ? {} : { events }), ...(body.allowLocal === true ? { allowLocal: true } : {}) });
      sendJson(response, 201, { webhook: project(hook, true) }, origin);
    } catch (error) {
      throw invalidRequest(error instanceof Error ? error.message : 'The webhook could not be saved.');
    }
    return true;
  }

  if (request.method === 'DELETE' && url.pathname.startsWith(`${webhooksPath}/`)) {
    const id = decodeURIComponent(url.pathname.slice(`${webhooksPath}/`.length));
    const removed = await store.remove(id);
    if (!removed) throw invalidRequest('That webhook does not exist.');
    sendJson(response, 200, { deleted: true, id }, origin);
    return true;
  }

  if (request.method === 'POST' && url.pathname === testPath) {
    const body = await readJsonBody(request, 16 * 1024).catch(() => undefined);
    const id = isRecord(body) && typeof body.id === 'string' ? body.id : undefined;
    if (!id) throw invalidRequest('Send the webhook id to test.');
    const hook = (await store.list()).find((candidate) => candidate.id === id);
    if (!hook) throw invalidRequest('That webhook does not exist.');
    const results = await service.deliverWebhook?.('test', { message: 'omnihilbras webhook test' });
    sendJson(response, 200, { delivered: results?.filter((delivery) => delivery.webhookId === id) ?? [] }, origin);
    return true;
  }

  sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Unsupported webhook method.' } }, origin);
  return true;
}
