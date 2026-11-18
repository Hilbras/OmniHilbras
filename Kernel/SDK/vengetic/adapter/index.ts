import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Vengetic's own adapter. Its base URL and id live here, not in a dashboard card. */
export const vengeticProviderId = "vengetic";

export class VengeticAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "vengetic",
      name: "Vengetic",
      baseUrl: "https://api.vengetic.biz.id/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
