import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** APInex's own adapter. Its base URL and id live here, not in a dashboard card. */
export const apinexProviderId = "apinex";

export class ApinexAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "apinex",
      name: "APInex",
      baseUrl: "https://api.apinex.bond/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
