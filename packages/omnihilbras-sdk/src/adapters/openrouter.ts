import { ProviderError } from '../core/errors.js';
import { compactPricing, normalizeContextWindow, normalizeModalities, perTokenPrice } from '../core/pricing.js';
import { FetchHttpTransport, type HttpResponse, type HttpTransport } from '../core/transport.js';
import { assertSafeProviderHeaderValue, assertSafeProviderRequestUrl, normalizeProviderBaseUrl, resolveProviderUrl } from '../core/url.js';
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterConfig } from './openai-compatible.js';
import type { CredentialValidation, Model, ModelImportOptions, ProviderCredential, ProviderHealth, ProviderRequestContext } from '../core/types.js';

export type OpenRouterAdapterConfig = Omit<OpenAICompatibleAdapterConfig, 'id' | 'name' | 'auth' | 'baseUrl'> & {
  baseUrl?: string;
};

export type OpenRouterAdapterOptions = {
  transport?: HttpTransport;
  timeoutMs?: number;
};

type OpenRouterKeyResponse = {
  data?: {
    label?: unknown;
    is_management_key?: unknown;
  };
};

type OpenRouterModelsResponse = {
  data?: unknown;
  links?: unknown;
};

/**
 * OpenRouter uses the OpenAI-compatible data APIs, but its key metadata route
 * is provider-specific. Keeping that route here prevents a generic model-list
 * request from becoming a false-positive credential check.
 */
export class OpenRouterAdapter extends OpenAICompatibleAdapter {
  private readonly validationBaseUrl: string;
  private readonly validationTransport: HttpTransport;

  constructor(config: OpenRouterAdapterConfig = {}, options: OpenRouterAdapterOptions = {}) {
    const baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    super({
      ...config,
      id: 'openrouter',
      name: 'OpenRouter',
      baseUrl,
      auth: { header: 'Authorization', prefix: 'Bearer', required: true },
    }, options);
    this.validationBaseUrl = normalizeProviderBaseUrl(baseUrl, 'openrouter');
    this.validationTransport = options.transport ?? new FetchHttpTransport({ timeoutMs: options.timeoutMs });
  }

  async validateCredential(credential: ProviderCredential | undefined, context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    const startedAt = performance.now();
    if (credential?.type !== 'api-key' || !credential.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'An OpenRouter API key is required.', { providerId: this.id, publicMessage: 'An OpenRouter API key is required.' });
    }
    assertSafeProviderHeaderValue('Authorization', credential.value, this.id);
    let response: HttpResponse<OpenRouterKeyResponse>;
    try {
      response = await this.validationTransport.request<OpenRouterKeyResponse>({
        method: 'GET',
        providerId: this.id,
        url: resolveProviderUrl(this.validationBaseUrl, '/key', this.id),
        headers: {
          accept: 'application/json',
          Authorization: `Bearer ${credential.value}`,
        },
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'AUTHENTICATION_FAILED') {
        const message = 'OpenRouter rejected this API key. Use a valid inference key, not a management key, and try again.';
        throw new ProviderError('AUTHENTICATION_FAILED', message, { providerId: this.id, statusCode: error.statusCode, publicMessage: message, cause: error });
      }
      throw error;
    }
    const data = response.data?.data;
    if (!data || typeof data !== 'object' || typeof data.label !== 'string' || typeof data.is_management_key !== 'boolean') {
      throw new ProviderError('INVALID_RESPONSE', 'OpenRouter returned an invalid key response.', { providerId: this.id, publicMessage: 'OpenRouter returned an invalid key response.' });
    }
    if (data.is_management_key) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'OpenRouter management keys cannot be used for inference.', { providerId: this.id, publicMessage: 'This OpenRouter key cannot be used for provider requests.' });
    }
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - startedAt) };
  }

  async discoverModels(context: ProviderRequestContext = {}, options: ModelImportOptions = { policy: 'all' }): Promise<Model[]> {
    if (!options || (options.policy !== 'free' && options.policy !== 'all')) {
      throw new ProviderError('CONFIGURATION_ERROR', 'The model import policy is invalid.', { providerId: this.id, publicMessage: 'The model import policy is invalid.' });
    }
    if (context.credential?.type !== 'api-key' || !context.credential.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'An OpenRouter API key is required to import models.', { providerId: this.id, publicMessage: 'An OpenRouter API key is required to import models.' });
    }
    assertSafeProviderHeaderValue('Authorization', context.credential.value, this.id);
    const models: Model[] = [];
    const seen = new Set<string>();
    let nextPage: string | undefined = resolveProviderUrl(this.validationBaseUrl, '/models', this.id);
    let pageCount = 0;
    while (nextPage) {
      if (pageCount++ >= 20) {
        throw new ProviderError('INVALID_RESPONSE', 'OpenRouter returned too many model pages to import.', { providerId: this.id, publicMessage: 'OpenRouter returned too many model pages to import.' });
      }
      const response = await this.validationTransport.request<OpenRouterModelsResponse>({
        method: 'GET',
        providerId: this.id,
        url: nextPage,
        headers: {
          accept: 'application/json',
          Authorization: `Bearer ${context.credential.value}`,
        },
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (!Array.isArray(response.data?.data)) {
        throw new ProviderError('INVALID_RESPONSE', 'OpenRouter returned an invalid model list.', { providerId: this.id, publicMessage: 'OpenRouter returned an invalid model list.' });
      }
      for (const rawModel of response.data.data) {
        const model = normalizeOpenRouterModel(rawModel, this.id);
        if (!model || !supportsTextOutput(rawModel) || seen.has(model.id)) continue;
        if (options.policy === 'free' && !isFreeOpenRouterModel(rawModel)) continue;
        if (models.length >= 2_000) {
          throw new ProviderError('INVALID_RESPONSE', 'OpenRouter returned too many models to import.', { providerId: this.id, publicMessage: 'OpenRouter returned too many models to import.' });
        }
        seen.add(model.id);
        models.push(model);
      }
      nextPage = resolveNextModelsPage(this.validationBaseUrl, response.data?.links, this.id);
    }
    return models;
  }

  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const startedAt = performance.now();
    try {
      await this.validateCredential(context.credential, context);
      return { status: 'healthy' as const, verified: 'credential', latencyMs: Math.round(performance.now() - startedAt), checkedAt: new Date().toISOString() };
    } catch (error) {
      /**
       * The reason, not just the verdict.
       *
       * A bare `catch {}` reported `unavailable` with nothing attached, so the dashboard could
       * only say "unavailable" — not whether the key was rejected, the endpoint was wrong, or the
       * provider was down. Those need three different things from the user, and "unavailable" is
       * none of them. Found by the provider contract on its first run.
       */
      return {
        status: 'unavailable' as const, verified: 'credential',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The health check failed without a reason.',
      };
    }
  }
}

function resolveNextModelsPage(baseUrl: string, links: unknown, providerId: string) {
  if (links === undefined || links === null) return undefined;
  if (!isRecord(links)) throw invalidModelPage(providerId);
  const next = links.next;
  if (next === undefined || next === null) return undefined;
  if (typeof next !== 'string' || !next.trim()) throw invalidModelPage(providerId);
  try {
    const base = new URL(`${baseUrl}/`);
    const candidate = new URL(next, base);
    const basePath = base.pathname.replace(/\/$/, '');
    if (candidate.origin !== base.origin || candidate.username || candidate.password || candidate.hash || (basePath && candidate.pathname !== basePath && !candidate.pathname.startsWith(`${basePath}/`))) throw new Error('The next model page escaped the OpenRouter API.');
    return assertSafeProviderRequestUrl(candidate.toString(), providerId);
  } catch {
    throw invalidModelPage(providerId);
  }
}

function invalidModelPage(providerId: string) {
  return new ProviderError('INVALID_RESPONSE', 'OpenRouter returned an invalid model pagination link.', { providerId, publicMessage: 'OpenRouter returned an invalid model pagination link.' });
}

function normalizeOpenRouterModel(value: unknown, providerId: string): Model | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined;
  const id = value.id.trim();
  if (!id || id.length > 256 || !/^[a-z0-9~][a-z0-9._:/~-]*$/i.test(id)) return undefined;
  const displayName = typeof value.name === 'string' && value.name.length <= 200 ? value.name : undefined;
  const contextWindow = normalizeContextWindow(value.context_length);
  // OpenRouter states all three, and this adapter already read them for its own free and
  // text-output checks and then discarded them. They are the reason a price or a vision
  // filter can be honest on this provider.
  const architecture = isRecord(value.architecture) ? value.architecture : undefined;
  const inputModalities = normalizeModalities(architecture?.input_modalities);
  const outputModalities = normalizeModalities(architecture?.output_modalities);
  const rawPricing = isRecord(value.pricing) ? value.pricing : undefined;
  const pricing = compactPricing({
    // OpenRouter quotes per token, as strings.
    ...(perTokenPrice(rawPricing?.prompt) === undefined ? {} : { inputPer1M: perTokenPrice(rawPricing?.prompt) }),
    ...(perTokenPrice(rawPricing?.completion) === undefined ? {} : { outputPer1M: perTokenPrice(rawPricing?.completion) }),
    ...(perTokenPrice(rawPricing?.input_cache_read) === undefined ? {} : { cacheReadPer1M: perTokenPrice(rawPricing?.input_cache_read) }),
    ...(perTokenPrice(rawPricing?.input_cache_write) === undefined ? {} : { cacheWritePer1M: perTokenPrice(rawPricing?.input_cache_write) }),
  });
  return {
    id,
    providerId,
    ...(displayName ? { displayName } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(outputModalities ? { outputModalities } : {}),
    ...(pricing ? { pricing } : {}),
  };
}

function supportsTextOutput(value: unknown) {
  if (!isRecord(value) || !isRecord(value.architecture) || !Array.isArray(value.architecture.output_modalities)) return false;
  return value.architecture.output_modalities.includes('text');
}

function isFreeOpenRouterModel(value: unknown) {
  if (!isRecord(value) || !isRecord(value.pricing)) return false;
  return isZeroPrice(value.pricing.prompt) && isZeroPrice(value.pricing.completion);
}

function isZeroPrice(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) && value === 0;
  if (typeof value !== 'string') return false;
  return /^(?:0+(?:\.0*)?|\.0+)$/.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
