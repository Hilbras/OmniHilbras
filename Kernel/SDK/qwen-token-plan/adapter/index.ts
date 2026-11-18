import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Qwen (Token Plan)'s own adapter. Its base URL and id live here, not in a dashboard card. */
export const qwen_token_planProviderId = "qwen-token-plan";

export class QwenTokenPlanAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "qwen-token-plan",
      name: "Qwen (Token Plan)",
      baseUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
