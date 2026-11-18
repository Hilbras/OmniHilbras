import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** NaraRouter's own adapter. Its base URL and id live here, not in a dashboard card. */
export const nara_routerProviderId = "nara-router";

export class NaraRouterAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "nara-router",
      name: "NaraRouter",
      baseUrl: "https://router.bynara.id/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
