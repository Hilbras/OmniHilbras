import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** KiraAI's own adapter. Its base URL and id live here, not in a dashboard card. */
export const kiraaiProviderId = "kiraai";

export class KiraaiAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "kiraai",
      name: "KiraAI",
      baseUrl: "https://kiraai.vn/api/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
