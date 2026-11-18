import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** AnyRouter's own adapter. Its base URL and id live here, not in a dashboard card. */
export const anyrouterProviderId = "anyrouter";

export class AnyrouterAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "anyrouter",
      name: "AnyRouter",
      baseUrl: "https://anyrouter.dev/api/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
