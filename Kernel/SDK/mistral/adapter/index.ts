import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Mistral's own adapter. Its base URL and id live here, not in a dashboard card. */
export const mistralProviderId = "mistral";

export class MistralAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "mistral",
      name: "Mistral",
      baseUrl: "https://api.mistral.ai/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
