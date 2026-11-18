import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Grok's own adapter. Its base URL and id live here, not in a dashboard card. */
export const grokProviderId = "grok";

export class GrokAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "grok",
      name: "Grok",
      baseUrl: "https://api.x.ai/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
