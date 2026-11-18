import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** TokenHarbor's own adapter. Its base URL and id live here, not in a dashboard card. */
export const tokenharborProviderId = "tokenharbor";

export class TokenharborAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "tokenharbor",
      name: "TokenHarbor",
      baseUrl: "https://tokenharbor.ai/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
