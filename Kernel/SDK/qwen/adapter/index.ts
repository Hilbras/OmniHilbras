import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Qwen's own adapter. Its base URL and id live here, not in a dashboard card. */
export const qwenProviderId = "qwen";

export class QwenAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "qwen",
      name: "Qwen",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
