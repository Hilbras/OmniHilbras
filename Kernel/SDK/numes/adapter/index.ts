import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Numes's own adapter. Its base URL and id live here, not in a dashboard card. */
export const numesProviderId = "numes";

export class NumesAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "numes",
      name: "Numes",
      baseUrl: "https://api.numes.ai/api/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
