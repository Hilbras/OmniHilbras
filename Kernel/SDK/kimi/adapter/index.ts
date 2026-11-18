import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Kimi's own adapter. Its base URL and id live here, not in a dashboard card. */
export const kimiProviderId = "kimi";

export class KimiAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "kimi",
      name: "Kimi",
      baseUrl: "https://api.moonshot.ai/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
