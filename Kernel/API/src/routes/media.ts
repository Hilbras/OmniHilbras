import type { RouteContext } from './route-context.js';
import { sendJson } from '../core/http.js';
import { ProviderError } from '../core/provider-error.js';

const notImplemented = (name: string) => new ProviderError('NOT_SUPPORTED', `${name} is not implemented yet.`, { publicMessage: `${name} is not implemented yet.` });

export async function handleMediaRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin } = ctx;
  if (request.method === 'POST' && url.pathname === '/v1/audio/speech') {
    throw notImplemented('Audio speech');
  }
  if (request.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
    throw notImplemented('Audio transcriptions');
  }
  if (request.method === 'POST' && url.pathname === '/v1/search') {
    throw notImplemented('Search');
  }
  return false;
}
