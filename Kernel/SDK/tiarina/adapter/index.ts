import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Tiarina's own adapter. Its base URL and id live here, not in a dashboard card. */
export const tiarinaProviderId = "tiarina";

export class TiarinaAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "tiarina",
      name: "Tiarina",
      baseUrl: "https://ai.tiarina.cloud/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
