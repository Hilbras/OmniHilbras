import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Zro's own adapter. Its base URL and id live here, not in a dashboard card. */
export const zroProviderId = "zro";

export class ZroAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "zro",
      name: "Zro",
      baseUrl: "https://zro.moonmath.ai/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
