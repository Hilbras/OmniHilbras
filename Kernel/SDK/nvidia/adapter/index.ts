import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';
import { ProviderError } from '@omnihilbras/sdk-shared/errors';
import type {
  ChatRequest,
  CredentialValidation,
  Model,
  ProviderCredential,
  ProviderHealth,
  ProviderRequestContext,
} from '@omnihilbras/sdk-shared/types';

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
   *
   * ## The first catalog entry is not a chat model
   *
   * Measured against the live catalog on 2026-11-27: the first entry was `bigcode/starcoder2-15b`, and
   * POSTing it to `/chat/completions` answered `404 page not found`. The Check button reported
   * "NVIDIA answered 404" for a key that a real turn through `nvidia/nemotron-3.5-super-vl-120b-a12b`
   * had just used successfully (HTTP 200, 541 ms). A catalog is a list of what the account can see, not
   * a promise that every entry is a chat model, so the probe now tries a bounded set: models whose
   * metadata says they are chat-shaped first, then the rest, and a model-level refusal (400/404/422)
   * moves to the next entry. 401/403 still means the key was refused.
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
    const models = (await this.listModels({ ...context, credential })).filter((entry) => entry.id);
    if (models.length === 0) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'NVIDIA listed no model to probe.', {
        providerId: nvidiaProviderId,
        publicMessage: 'The catalog is reachable but empty, so the key could not be checked with a real request.',
      });
    }
    const candidates = [...models]
      .sort((left, right) => Number(chatShaped(right)) - Number(chatShaped(left)))
      .slice(0, 5);
    let lastReason = 'no attempt';
    for (const model of candidates) {
      const scoped = scopedSignal(context.signal, 10_000);
      try {
        await this.transport.request({
          method: 'POST',
          providerId: nvidiaProviderId,
          url: this.url('/chat/completions'),
          headers: this.requestHeaders(credential, 'application/json'),
          body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
          signal: scoped.signal,
        });
        return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - startedAt) };
      } catch (error) {
        const status = error && typeof error === 'object' && typeof (error as { statusCode?: unknown }).statusCode === 'number'
          ? (error as { statusCode: number }).statusCode : undefined;
        if (status === 401 || status === 403) {
          throw new ProviderError('AUTHENTICATION_FAILED', 'NVIDIA refused this API key.', {
            providerId: nvidiaProviderId,
            publicMessage: 'NVIDIA refused this key. Create one at build.nvidia.com/settings/api-keys.',
          });
        }
        lastReason = status === undefined ? 'the probe timed out or could not connect' : `HTTP ${status}`;
        // A model-level refusal is information about that model, not about the key. Try the next one.
      } finally {
        scoped.cleanup();
      }
    }
    throw new ProviderError('PROVIDER_UNAVAILABLE', `NVIDIA listed ${models.length} models and none accepted a probe (${lastReason}).`, {
      providerId: nvidiaProviderId,
      publicMessage: `The key could not be verified: NVIDIA listed ${models.length} models and none accepted a probe (${lastReason}).`,
    });
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

/**
 * Whether a catalog entry looks like something `/chat/completions` will accept.
 *
 * NVIDIA publishes `model_type` and `supports_tools`/`supports_thinking` on some entries and nothing on
 * others, so this is a preference order rather than a filter: a chat-shaped model is tried first, and the
 * remainder are still attempted because a missing field is not a fact.
 */
function chatShaped(model: Model): boolean {
  if (model.capabilities?.tools === true || model.capabilities?.reasoning === true) return true;
  if (/chat|instruct|vlm|reason/i.test(model.modelType ?? '')) return true;
  return /chat|instruct/i.test(model.id);
}

/**
 * The caller's abort signal plus a per-model budget, without depending on `AbortSignal.any`.
 *
 * The gateway's own request deadline is longer than a single key probe should take; a model that hangs
 * must not spend the whole budget before the next candidate gets a chance. The external signal is
 * forwarded so a client that goes away still cancels the attempt.
 */
function scopedSignal(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('probe timeout')), timeoutMs);
  timer.unref?.();
  const forward = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) forward();
    else external.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', forward);
    },
  };
}
