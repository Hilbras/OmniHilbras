import { CLINE_OAUTH, ClineAdapter, clineHeaders, type ClineAdapterOptions } from '../lib/cline.js';
import type { ChatRequest, ChatResponse, ChatChunk, Model, ProviderRequestContext } from '../lib/types.js';

/**
 * ClinePass is Cline's paid model tier, and it is **the same account as Cline** — not a second
 * credential, not a pasted key.
 *
 * ## What the vendor source says
 *
 * Cline's own client registers two providers, `cline` and `cline-pass`, and its auth registry
 * registers the second as an **alias** of the first:
 *
 * - `sdk/packages/core/src/auth/provider-auth-registry.ts` — `createClineAuthHandler({
 *   providerId: "cline-pass", storageProviderId: "cline" })`. Both handlers `login` through
 *   `loginClineOAuth(...)` and refresh through `getValidClineCredentials(...)`, and both persist to
 *   the **one** `cline` settings entry. So `isOAuthProvider("cline-pass")` is true.
 * - `apps/cli/src/tui/views/onboarding/model.ts` — `resolveProviderSetupRoute()` returns `"oauth"`
 *   for anything that predicate accepts, *"keyed off how the provider authenticates, so every caller
 *   routes the same way"*. Cline's own CLI therefore opens a **sign-in** for ClinePass.
 * - `sdk/packages/llms/src/providers/vendors/cline.ts` — *"Both Cline gateway providers (`cline` and
 *   `cline-pass`) share this AI SDK provider and the same Cline API."* Same host, same
 *   `Authorization: Bearer`, same client headers.
 *
 * So this adapter **subclasses** `ClineAdapter` rather than reimplementing it. Everything about the
 * wire format is Cline's — including the OAuth token renewal a shared connection needs — and the only
 * things that differ are:
 *
 * 1. the **id and name** it reports, so a failure is attributed to the right card; and
 * 2. the **model filter**, because Cline answers a ClinePass request with the *whole* catalog.
 *
 * ## Why there is no cookie path and no sign-in of its own
 *
 * Nothing in Cline's SDK reads a cookie; `app.cline.bot` is only ever opened in a real browser. And a
 * separate ClinePass sign-in would mint a *second* token for one account — WorkOS rotates refresh
 * tokens, so the two would invalidate each other. ClinePass is signed into by signing into Cline; the
 * gateway stores that one credential and this adapter reads it through the gateway's alias.
 *
 * ## What health can and cannot prove
 *
 * Cline decides entitlement server-side, per request, from the subscription — there is no endpoint that
 * answers "is this subscription current". A health check therefore proves the Cline token is live and
 * **nothing about whether the ClinePass tier is unlocked**. The `cline-pass/` filter below is what keeps
 * the *model list* honest; the health status does not.
 */

/** The model prefix that is ClinePass. Everything else on this host is the free tier. */
export const CLINE_PASS_MODEL_PREFIX = 'cline-pass/';

/**
 * The id as Cline's catalog names it: `cline-pass/<model>`. Accepted verbatim from a client that
 * saved the older, doubly-prefixed form, so an id already on a client keeps working.
 */
function withClinePassPrefix(modelId: string): string {
  return modelId.startsWith(CLINE_PASS_MODEL_PREFIX) ? modelId : `${CLINE_PASS_MODEL_PREFIX}${modelId}`;
}

/**
 * The id as clients address it: the gateway's slug already names the tier, so the vendor's own prefix
 * would say it twice — `clp/cline-pass/…` — and a model id a user copies should read once.
 */
function withoutClinePassPrefix(modelId: string): string {
  return modelId.startsWith(CLINE_PASS_MODEL_PREFIX) ? modelId.slice(CLINE_PASS_MODEL_PREFIX.length) : modelId;
}

export class ClinePassAdapter extends ClineAdapter {
  constructor(options: ClineAdapterOptions = {}) {
    super({ ...options, id: 'clinepass', name: 'ClinePass' });
  }

  /**
   * Lists the ClinePass tier from Cline's recommended feed, which is the list Cline's own client shows.
   *
   * The general `/models` catalog answers a ClinePass request with the whole Cline catalog and, for an
   * account without the subscription, no `cline-pass/` ids at all — so filtering it leaves nothing to
   * show. The recommended feed carries the tier explicitly, so it is read directly. A model can still be
   * refused at request time if the subscription does not cover it; the list is what Cline offers, not a
   * promise that the account can run each entry.
   *
   * Cline names the tier inside every id; that is upstream spelling, and it is stripped here so a
   * client sees one prefix (the gateway's `clp/`), not two.
   */
  override async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const credential = context.credential;
    const response = await this.transport.request<{ clinePass?: Array<{ id?: unknown }> }>({
      method: 'GET',
      providerId: this.id,
      url: CLINE_OAUTH.recommendedModelsUrl,
      headers: clineHeaders(credential?.type === 'none' || !credential?.value ? '' : credential.value, { accept: 'application/json' }, this.userAgent),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    // The tiers are at the top level of the body, with no `data` envelope — read live, not assumed.
    const tier = response.data?.clinePass ?? [];
    const ids = tier.flatMap((entry) => (typeof entry?.id === 'string' && entry.id.startsWith(CLINE_PASS_MODEL_PREFIX) ? [entry.id] : []));
    return [...new Set(ids)].map((id) => ({ id: withoutClinePassPrefix(id), providerId: this.id }));
  }

  /** Cline's catalog names the tier on every id, so the prefix goes back on before a request leaves. */
  private upstream(request: ChatRequest): ChatRequest {
    return { ...request, model: withClinePassPrefix(request.model) };
  }

  override async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    return super.chat(this.upstream(request), context);
  }

  override async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    yield* super.streamChat(this.upstream(request), context);
  }
}

/**
 * Where a ClinePass request is actually sent, re-exported so the two adapters cannot drift.
 *
 * It is Cline's host and path — there is no separate ClinePass endpoint — and naming it here is what
 * lets a reader check that claim without opening `cline.ts`.
 */
export const CLINE_PASS_API_BASE_PATH = CLINE_OAUTH.apiBasePath;
