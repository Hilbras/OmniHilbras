import { ProviderError } from '../lib/errors.js';
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '../lib/openai-compatible.js';
import { FetchHttpTransport, type HttpTransport } from '../lib/transport.js';
import type {
  CredentialValidation,
  Model,
  ProviderCredential,
  ProviderHealth,
  ProviderRequestContext,
} from '../lib/types.js';

export const nousProviderId = 'nous';
export const NOUS_BASE_URL = 'https://inference-api.nousresearch.com/v1';

/**
 * The free model the credential probe asks for.
 *
 * A probe is a real inference request, so it must not spend an account's paid credits — which means a
 * free, text model. The **choice is read from the catalog at check time**, preferring a zero-price text
 * model, because a pinned id rots: the reference project pinned `poolside/laguna-xs-2.1:free`, and by
 * 2026-11 that model answers `404 Model not found` while the listing carries two other free models. A
 * stale pin turns every credential check into "the key could not be verified", which is a false report
 * about a key that is fine.
 *
 * This constant is the fallback for when the catalog cannot be read at all; it is the current free model
 * at the time of writing, and it is not trusted over a live answer.
 */
export const NOUS_FALLBACK_VALIDATION_MODEL = 'upstage/solar-mini4:free';
/** How long a chosen probe model is reused before the public catalog is read again. */
const PROBE_MODEL_TTL_MS = 5 * 60_000;

type NousRawModel = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  context_length?: unknown;
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown } | null;
  architecture?: { output_modalities?: unknown } | null;
  pricing?: { prompt?: unknown; completion?: unknown } | null;
};

type NousCatalog = { data?: unknown };

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function pricePer1M(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  // The catalog quotes USD per token. A zero is a real zero and must stay one, so a free model reads as
  // free rather than as a price nobody stated.
  return Math.round(parsed * 1_000_000 * 1e6) / 1e6;
}

/**
 * Whether a catalog entry is a chat model.
 *
 * Nous's catalog also carries embeddings and image-only entries. They are not valid chat completions
 * models, so offering them would put a row in the model list whose every request fails — the reference
 * project filters on the same field. An entry that states no modalities at all is kept: silence is not
 * evidence that it is not a chat model.
 */
function isTextCapable(model: NousRawModel): boolean {
  const modalities = model.architecture?.output_modalities;
  return !Array.isArray(modalities) || modalities.length === 0 || modalities.includes('text');
}

/**
 * Nous Research.
 *
 * ## Why this is an adapter and not one more generic endpoint
 *
 * Two facts about Nous make the generic OpenAI-compatible path wrong, and both come from the reference
 * project's own measurements:
 *
 * 1. **`/models` is public.** The generic adapter's credential check reads the catalog, so against Nous
 *    it reports *any* key — including a wrong one — as valid. Only a 1-token inference proves a Portal
 *    key, which is what `validateCredential` and `healthCheck` send here.
 * 2. **The catalog carries non-chat entries.** Embeddings and image-only models are advertised on the
 *    same `/models` response, so a generic import lists models whose requests cannot work.
 *
 * Everything else is the OpenAI wire format, so chat and streaming come from the shared base.
 */
export type NousAdapterOptions = OpenAICompatibleAdapterOptions & { baseUrl?: string };

export class NousAdapter extends OpenAICompatibleAdapter {
  // The base keeps its transport private; this is the same instance the gateway supplied, used by the
  // probe, which is a request the generic base never makes.
  private readonly probeTransport: HttpTransport;
  private readonly chatUrl: string;
  private readonly modelsUrl: string;
  /** The probe model last read from the public catalog, and when. */
  private chosenProbeModel?: { id: string; at: number };

  constructor(options: NousAdapterOptions = {}) {
    const baseUrl = (options.baseUrl ?? NOUS_BASE_URL).replace(/\/$/, '');
    super(
      {
        id: nousProviderId,
        name: 'Nous Research',
        baseUrl,
        auth: { header: 'Authorization', prefix: 'Bearer' },
      },
      options,
    );
    this.probeTransport = options.transport ?? new FetchHttpTransport();
    this.chatUrl = `${baseUrl}/chat/completions`;
    this.modelsUrl = `${baseUrl}/models`;
  }

  /**
   * The catalog, reduced to chat models and their stated facts.
   *
   * `context_length` is read from either the top level or `top_provider`, because the API has been seen
   * to use both. Prices are converted from per-token to per-1M, which is the unit the dashboard shows —
   * a zero stays zero, so a free model is recognisably free rather than an absent price.
   */
  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const { data } = await this.probeTransport.request<NousCatalog>({
      method: 'GET',
      providerId: nousProviderId,
      url: this.modelsUrl,
      headers: {
        accept: 'application/json',
        ...(context.credential && 'value' in context.credential && context.credential.value
          ? { Authorization: `Bearer ${context.credential.value}` }
          : {}),
      },
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const raw = (data as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(raw)) throw new ProviderError('INVALID_RESPONSE', 'Nous returned a model list without data.', { providerId: nousProviderId });

    const models = raw.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const model = entry as NousRawModel;
      if (!isTextCapable(model)) return [];
      const id = typeof model.id === 'string' ? model.id.trim() : '';
      if (!id) return [];
      const contextWindow = positiveInteger(model.context_length) ?? positiveInteger(model.top_provider?.context_length);
      const inputPer1M = pricePer1M(model.pricing?.prompt);
      const outputPer1M = pricePer1M(model.pricing?.completion);
      return [{
        id,
        providerId: nousProviderId,
        ...(typeof model.name === 'string' && model.name ? { displayName: model.name } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        outputModalities: ['text'],
        ...(inputPer1M !== undefined || outputPer1M !== undefined
          ? { pricing: { ...(inputPer1M !== undefined ? { inputPer1M } : {}), ...(outputPer1M !== undefined ? { outputPer1M } : {}) } }
          : {}),
      } satisfies Model];
    });

    // First-party models first, preserving the catalog's order inside each group (sort is stable).
    return models.sort((a, b) => Number(!a.id.startsWith('nousresearch/')) - Number(!b.id.startsWith('nousresearch/')));
  }

  /**
   * Proves the key with one authenticated inference request, not by reading the public catalog.
   *
   * The rules are the reference project's, and each covers a different answer from Nous:
   * a 2xx is the only proof; 401/403 names the key as refused; anything else means the request could not
   * settle the question — which is stated as such rather than reported as a bad key.
   */
  async validateCredential(
    credential: ProviderCredential | undefined,
    context: ProviderRequestContext = {},
  ): Promise<CredentialValidation> {
    const value = credential && 'value' in credential ? credential.value : undefined;
    if (typeof value !== 'string' || !value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Enter a Nous Research API key.', {
        providerId: nousProviderId,
        publicMessage: 'Enter a Nous Research API key. Create one at portal.nousresearch.com/api-keys.',
      });
    }
    const startedAt = performance.now();
    const model = await this.probeModel(context.signal);
    try {
      await this.probeTransport.request({
        method: 'POST',
        providerId: nousProviderId,
        url: this.chatUrl,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: `Bearer ${value}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      // The status is read off the refusal the transport raised — it is the whole question this probe
      // asks. A 401/403 is the key being refused; any other status means Nous could not answer, which is
      // a different fact and says so.
      //
      // Read **structurally**, not with `instanceof ProviderError`. The transport is supplied by the
      // hosting gateway, which has its own copy of this SDK's `lib/`, and an error thrown by that copy is
      // not an instance of this file's class — `instanceof` returned false and the 401 was reported as
      // "could not verify (no status)", which is a false statement about a refused key. Measured by
      // saving a bogus key through the dashboard against a live gateway.
      const status = error && typeof error === 'object' && typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : undefined;
      if (status === 404) {
        // The probe named a model Nous no longer lists. That is a fact about the catalog, not about the
        // key, and saying "bad key" here would send the user to rotate a working credential.
        this.chosenProbeModel = undefined;
        throw new ProviderError('PROVIDER_UNAVAILABLE', `The Nous Research probe model ${model} is no longer listed.`, {
          providerId: nousProviderId,
          publicMessage: `The key could not be verified: the free probe model ${model} is no longer in Nous's catalog. Nothing is wrong with the key as far as this check can tell.`,
        });
      }
      if (status === 401 || status === 403) {
        throw new ProviderError('AUTHENTICATION_FAILED', 'Invalid or inactive Nous Research API key.', {
          providerId: nousProviderId,
          publicMessage: 'Nous Research refused this key. Create a new one at portal.nousresearch.com/api-keys.',
        });
      }
      throw new ProviderError('PROVIDER_UNAVAILABLE', `Unable to verify the Nous Research key (Nous returned ${status ?? 'no status'}).`, {
        providerId: nousProviderId,
        publicMessage: `The key could not be verified${status ? `: Nous answered ${status}` : ''}. The key was not saved.`,
      });
    }
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - startedAt) };
  }

  /**
   * The model to probe with: a free text model from the **public** catalog, cached briefly.
   *
   * Only a zero-price model is eligible — the probe is a real request — and the catalog read is public,
   * so this adds no credential and no cost. If the catalog cannot be read, the fallback constant is used
   * and a 404 from it is reported as a catalog problem rather than an auth verdict.
   */
  private async probeModel(signal?: AbortSignal): Promise<string> {
    const cached = this.chosenProbeModel;
    if (cached && Date.now() - cached.at < PROBE_MODEL_TTL_MS) return cached.id;
    try {
      const models = await this.listModels(signal ? { signal } : {});
      // A `:free` id is Nous's own statement of a free-tier model; a zero price is the same fact stated
      // in the pricing block. Prefer the explicit suffix, then the price. Measured live on 2026-11-07:
      // 357 chat models, 5 at zero price, 2 of them carrying `:free` — the suffix is the narrower set.
      const free = models.find((entry) => entry.id.endsWith(':free') && entry.pricing?.inputPer1M === 0 && entry.pricing?.outputPer1M === 0)
        ?? models.find((entry) => entry.pricing?.inputPer1M === 0 && entry.pricing?.outputPer1M === 0)
        ?? models.find((entry) => entry.id.endsWith(':free'));
      if (free) {
        this.chosenProbeModel = { id: free.id, at: Date.now() };
        return free.id;
      }
    } catch {
      // A catalog that will not read does not answer the credential question; the fallback does.
    }
    return NOUS_FALLBACK_VALIDATION_MODEL;
  }

  /**
   * A health poll that states the stronger scope, because it really ran one inference request.
   *
   * The generic base reports `verified: 'credential'` from a catalog read, which against Nous is not even
   * a credential check — the catalog is public. This sends the same 1-token probe, so `inference` is the
   * fact it established. A refusal is still an inference attempt, so the scope does not shrink on failure.
   */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const startedAt = performance.now();
    const credential = context.credential;
    const value = credential && 'value' in credential ? credential.value : undefined;
    if (typeof value !== 'string' || !value) {
      return {
        status: 'unavailable',
        verified: 'inference',
        checkedAt: new Date().toISOString(),
        message: 'No Nous Research key is saved for this connection.',
      };
    }
    try {
      await this.validateCredential(credential, context);
      return {
        status: 'healthy',
        verified: 'inference',
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'inference',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The health check failed without a reason.',
      };
    }
  }
}

export * from '../lib/openai-compatible.js';