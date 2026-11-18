import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Aion Labs's own adapter. Its base URL and id live here, not in a dashboard card. */
export const aion_labsProviderId = "aion-labs";

export class AionLabsAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "aion-labs",
      name: "Aion Labs",
      baseUrl: "https://api.aionlabs.ai/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
