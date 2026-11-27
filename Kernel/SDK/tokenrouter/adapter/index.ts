import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/**
 * TokenRouter's own adapter.
 *
 * An OpenAI-compatible gateway over OpenAI, Anthropic, Google, DeepSeek, Qwen, Kimi, GLM and xAI
 * models. **Model ids keep their vendor namespace** (`anthropic/claude-sonnet-4.6`), which is why the
 * provider prefix is `tkr/` and not the model's own vendor: `tokenrouter/anthropic/...` resolves to
 * this connection and the bare `anthropic/...` is what TokenRouter receives.
 *
 * `/v1/models` refuses an unauthenticated read (measured: `401 Unauthorized` with a
 * `x-tokenrouter-request-id` header), so an authenticated catalog read is a real key check rather
 * than a page any string can fetch. Embeddings and image generation are enabled because the
 * reference registry lists both service kinds for this gateway; reasoning effort is the shared
 * OpenAI `reasoning_effort` field, whose low/medium/high values the gateway's contract exposes.
 */
export const tokenrouterProviderId = 'tokenrouter';

export class TokenrouterAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: tokenrouterProviderId,
      name: 'TokenRouter',
      baseUrl: 'https://api.tokenrouter.com/v1',
      auth: { header: 'Authorization', prefix: 'Bearer' },
      capabilities: { embeddings: true, images: true },
    }, options);
  }
}
