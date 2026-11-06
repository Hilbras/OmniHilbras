/**
 * What the dashboard may import from the Kernel.
 *
 * The rule this file exists to enforce: **the front-end talks to `Kernel/API` and to nothing else.** No
 * `Kernel/SDK` package, no provider folder, no shared library underneath. Anything else would make a
 * provider — or a copy of one — load-bearing for a page, which is the coupling this whole layout was
 * built to remove.
 *
 * So this is the whole permitted surface, and it is deliberately small:
 *
 * - **Types** describing what the API already sends over the wire (`ModelMeta`, `ConnectionRecord`, …).
 *   A type costs nothing at runtime and stops the front-end inventing a second, drifting shape for a
 *   payload it is reading anyway.
 * - **Pure presentation helpers** (`providerSlug`, `modelFacets`, `priceLabel`, …). They format values
 *   that arrived from the API. They are here rather than in `src/` because they must agree with the API:
 *   a slug decides a model id, and two copies of that table would drift until a saved client could not
 *   reach its own model.
 *
 * There is no provider logic in here — no adapter, no transport, no SSE parser, no sign-in. Everything
 * that *does* something is a request to `Kernel/API`, and a test (`tests/frontend-imports-guard.test.js`)
 * fails the build if a file under `src/` reaches around this file.
 */
export {
  providerSlug,
  qualifiedModelId,
} from '../core/provider-slugs.js';

export {
  modelFacets,
  priceLabel,
  contextLabel,
  applyModelFilters,
  filterAvailability,
  defaultModelFilters,
  contextOptions,
  type ModelFacets,
  type ModelFilterState,
} from '../core/modelFilters.js';

export type { ConnectionRecord, ConnectionInput, ModelMeta, ModelMetaMap } from '../core/connections.js';

/**
 * The cookie a ChatGPT Web session is exported under.
 *
 * A constant, not provider logic, but it belongs here for the same reason as a slug: the gateway tells a
 * user which cookie to copy, and the dashboard must name the same one.
 */
export const CHATGPT_WEB_SESSION_COOKIE = '__Secure-next-auth.session-token';
