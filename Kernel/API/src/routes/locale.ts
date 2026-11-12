import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { RouteContext } from './route-context.js';
import { sendJson } from '../core/http.js';
import { ProviderError } from '../core/provider-error.js';

const localePrefix = '/v1/locale';

export async function handleLocaleRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin } = ctx;
  if (request.method === 'GET' && url.pathname.startsWith(`${localePrefix}/`)) {
    const lang = decodeURIComponent(url.pathname.slice(`${localePrefix}/`.length));
    if (!/^[A-Za-z0-9_-]+$/.test(lang)) throw new ProviderError('INVALID_REQUEST', 'Invalid locale.', { publicMessage: 'Invalid locale.' });
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const raw = await readFile(join(here, '..', '..', 'locales', `${lang}.json`), 'utf8');
      sendJson(response, 200, JSON.parse(raw), origin);
    } catch {
      throw new ProviderError('NOT_FOUND', `Locale "${lang}" not found.`, { publicMessage: 'Locale not found.' });
    }
    return true;
  }
  if (request.method === 'GET' && url.pathname === localePrefix) {
    sendJson(response, 200, { locales: ['en', 'zh'] }, origin);
    return true;
  }
  return false;
}
