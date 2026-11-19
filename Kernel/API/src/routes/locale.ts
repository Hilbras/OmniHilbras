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
      /**
       * Three layouts, because the same module runs from three places:
       *
       * - source: `src/routes` → `<package>/locales`;
       * - compiled: `dist/src/routes` → `<package>/locales`;
       * - bundled CLI: `server/gateway.mjs` with `locales` beside it.
       *
       * The compiled path was one `..` short, so a packaged gateway answered every locale with 404.
       * Trying the candidates makes the location a fact the file can check rather than one it assumes.
       */
      const candidates = [
        join(here, '..', '..', 'locales', `${lang}.json`),
        join(here, '..', '..', '..', 'locales', `${lang}.json`),
        join(here, 'locales', `${lang}.json`),
      ];
      let raw;
      for (const candidate of candidates) {
        try { raw = await readFile(candidate, 'utf8'); break; } catch { /* try the next layout */ }
      }
      if (raw === undefined) throw new Error('not found');
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
