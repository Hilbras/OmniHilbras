import { TRANSLATION_PAIRS } from '../core/format-translation.js';
import { sendJson } from '../core/http.js';
import type { RouteContext } from './route-context.js';

/**
 * `GET /v1/translators` — which source→target format pairs this gateway actually registers.
 *
 * The registry lives in `core/format-translation.ts`, where `translatorFor` uses it to pick the
 * direct Anthropic Messages → OpenAI Chat translation for `/v1/messages`. That was a decision with
 * no surface: an operator could not ask what the gateway translates, so the honest answer had to be
 * read out of source. This route publishes exactly that one fact and nothing more.
 *
 * Only `{source, target}` crosses the wire. The registry rows also carry a `translate` function and
 * the format handlers carry request bodies; neither is serialised, and there is no translate, send,
 * load or save endpoint here. A caller cannot use this route to transform a message, write a config
 * or paste a credential — it describes a capability, it does not exercise one.
 *
 * It is a management path (`/v1/translators` is in `MANAGEMENT_PREFIXES`), so with key enforcement on
 * an unauthenticated caller is refused before this handler runs.
 */
const translatorsPrefix = '/v1/translators';

export async function handleTranslatorsRoute(ctx: RouteContext): Promise<boolean> {
  const { request, response, url, origin } = ctx;
  if (request.method === 'GET' && url.pathname === translatorsPrefix) {
    sendJson(response, 200, {
      object: 'list',
      data: TRANSLATION_PAIRS.map(({ source, target }) => ({ source, target })),
    }, origin);
    return true;
  }
  return false;
}
