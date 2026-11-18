import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Coarena's own adapter. Its base URL and id live here, not in a dashboard card. */
export const coarenaProviderId = "coarena";

export class CoarenaAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "coarena",
      name: "Coarena",
      baseUrl: "https://coarena.ai/api/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
