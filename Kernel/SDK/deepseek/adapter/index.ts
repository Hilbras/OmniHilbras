import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** DeepSeek's own adapter. Its base URL and id live here, not in a dashboard card. */
export const deepseekProviderId = "deepseek";

export class DeepseekAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
