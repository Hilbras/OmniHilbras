import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** UnoRouter's own adapter. Its base URL and id live here, not in a dashboard card. */
export const unorouterProviderId = "unorouter";

export class UnorouterAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "unorouter",
      name: "UnoRouter",
      baseUrl: "https://api.unorouter.com/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
