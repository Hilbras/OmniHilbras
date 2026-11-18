import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** xKiro's own adapter. Its base URL and id live here, not in a dashboard card. */
export const xkiroProviderId = "xkiro";

export class XkiroAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "xkiro",
      name: "xKiro",
      baseUrl: "https://api.xkiro.com/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
