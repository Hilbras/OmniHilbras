import { ProviderError } from '../errors.js';
import { FetchHttpTransport, type HttpTransport } from '../transport.js';
import { assertSafeProviderHeaderValue, normalizeProviderBaseUrl, resolveProviderUrl } from '../url.js';
import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterConfig } from './openai-compatible.js';
import type { CredentialValidation, ProviderCredential, ProviderRequestContext } from '../types.js';

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
    const response = await this.validationTransport.request<OpenRouterKeyResponse>({
      method: 'GET',
      providerId: this.id,
      url: resolveProviderUrl(this.validationBaseUrl, '/key', this.id),
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${credential.value}`,
      },
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const data = response.data?.data;
    if (!data || typeof data !== 'object' || typeof data.label !== 'string' || typeof data.is_management_key !== 'boolean') {
      throw new ProviderError('INVALID_RESPONSE', 'OpenRouter returned an invalid key response.', { providerId: this.id, publicMessage: 'OpenRouter returned an invalid key response.' });
    }
    if (data.is_management_key) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'OpenRouter management keys cannot be used for inference.', { providerId: this.id, publicMessage: 'This OpenRouter key cannot be used for provider requests.' });
    }
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - startedAt) };
  }

  async healthCheck(context: ProviderRequestContext = {}) {
    const startedAt = performance.now();
    try {
      await this.validateCredential(context.credential, context);
      return { status: 'healthy' as const, latencyMs: Math.round(performance.now() - startedAt), checkedAt: new Date().toISOString() };
    } catch {
      return { status: 'unavailable' as const, checkedAt: new Date().toISOString() };
    }
  }
}
