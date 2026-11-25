import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';
import { ProviderError } from '@omnihilbras/sdk-shared/errors';
import type {
  ChatRequest,
  CredentialValidation,
  ProviderCredential,
  ProviderHealth,
  ProviderRequestContext,
} from '../lib/types.js';

/** NVIDIA's own adapter. Its base URL and id live here, not in a dashboard card. */
export const nvidiaProviderId = "nvidia";

/**
 * NVIDIA's model pages describe `reasoning_effort` as a UI-level choice that snippets translate into
 * `chat_template_kwargs`; that object is the field the hosted endpoint reads. The same page asks for
 * `force_nonempty_content` when a turn combines reasoning with tool calls. `low` is not an NVIDIA level:
 * treat it as the documented `medium` shape rather than sending an unsupported value.
 */
function reasoningKwargs(effort: string | undefined, withTools: boolean): Record<string, boolean> | undefined {
  if (!effort) return undefined;
  if (effort === 'none' || effort === 'off') return { enable_thinking: false };
  const kwargs: Record<string, boolean> = { enable_thinking: true };
  if (effort === 'low' || effort === 'medium') kwargs.medium_effort = true;
  if (withTools) kwargs.force_nonempty_content = true;
  return kwargs;
}

export class NvidiaAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "nvidia",
      name: "NVIDIA",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }

  /**
   * Keep the shared body builder, then rewrite the one field NVIDIA interprets differently and allow
   * the narrow `chat_template_kwargs` passthrough. Every other provider option stays refused.
   */
  protected toRequestBody(request: ChatRequest, stream: boolean) {
    const options = request.providerOptions;
    const passthrough = options?.chat_template_kwargs;
    const forwarded = { ...request };
    if (options) {
      const rest = { ...options };
      delete rest.chat_template_kwargs;
      if (Object.keys(rest).length > 0) {
        throw new ProviderError('INVALID_REQUEST', `Provider options are not supported by ${this.id} yet.`, { providerId: this.id });
      }
      forwarded.providerOptions = undefined;
    }
    const body = super.toRequestBody(forwarded, stream);
    const effort = body.reasoning_effort;
    delete body.reasoning_effort;
    if (typeof effort === 'string') {
      const kwargs = reasoningKwargs(effort, Array.isArray(body.tools) && body.tools.length > 0);
      if (kwargs) body.chat_template_kwargs = { ...kwargs, ...(passthrough && typeof passthrough === 'object' ? passthrough : {}) };
    } else if (passthrough && typeof passthrough === 'object') {
      body.chat_template_kwargs = passthrough;
    }
    return body;
  }

  /**
   * NVIDIA's `/v1/models` is public — verified: HTTP 200 with no key and with a bogus key. Reading it
   * proves endpoint reachability, not credential validity. A key check therefore has to send one real
   * (free-tier) inference request. Deliberately provider-specific: a generic catalog fallback would
   * make a bogus key look valid here.
   */
  async validateCredential(credential: ProviderCredential | undefined, context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    const startedAt = performance.now();
    const value = credential && 'value' in credential ? credential.value : undefined;
    if (typeof value !== 'string' || !value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Enter a NVIDIA API key.', {
        providerId: nvidiaProviderId,
        publicMessage: 'Enter a NVIDIA API key. Create one at build.nvidia.com/settings/api-keys.',
      });
    }
    const models = await this.listModels({ ...context, credential });
    const model = models.find((entry) => entry.id)?.id;
    if (!model) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'NVIDIA listed no model to probe.', {
        providerId: nvidiaProviderId,
        publicMessage: 'The catalog is reachable but empty, so the key could not be checked with a real request.',
      });
    }
    try {
      await this.transport.request({
        method: 'POST',
        providerId: nvidiaProviderId,
        url: this.url('/chat/completions'),
        headers: this.requestHeaders(credential, 'application/json'),
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      const status = error && typeof error === 'object' && typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode : undefined;
      if (status === 401 || status === 403) {
        throw new ProviderError('AUTHENTICATION_FAILED', 'NVIDIA refused this API key.', {
          providerId: nvidiaProviderId,
          publicMessage: 'NVIDIA refused this key. Create one at build.nvidia.com/settings/api-keys.',
        });
      }
      throw new ProviderError('PROVIDER_UNAVAILABLE', `NVIDIA could not verify the key (HTTP ${status ?? 'no status'}).`, {
        providerId: nvidiaProviderId,
        publicMessage: `The key could not be verified${status ? `: NVIDIA answered ${status}` : ''}.`,
      });
    }
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - startedAt) };
  }

  /** A public catalog cannot verify a key, so say exactly what this poll did prove. */
  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const startedAt = performance.now();
    try {
      await this.listModels(context);
      return {
        status: 'degraded',
        verified: 'credential',
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt: new Date().toISOString(),
        message: 'The NVIDIA catalog is public: this poll proves reachability, not key validity. Use Check to send a real probe.',
      };
    } catch (error) {
      return {
        status: 'unavailable',
        verified: 'credential',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The health check failed without a reason.',
      };
    }
  }
}
