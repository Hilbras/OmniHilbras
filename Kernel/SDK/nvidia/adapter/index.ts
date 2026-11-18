import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** NVIDIA's own adapter. Its base URL and id live here, not in a dashboard card. */
export const nvidiaProviderId = "nvidia";

export class NvidiaAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "nvidia",
      name: "NVIDIA",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
