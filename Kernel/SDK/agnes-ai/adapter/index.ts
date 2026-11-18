import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Agnes AI's own adapter. Its base URL and id live here, not in a dashboard card. */
export const agnes_aiProviderId = "agnes-ai";

export class AgnesAiAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "agnes-ai",
      name: "Agnes AI",
      baseUrl: "https://apihub.agnes-ai.com/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
