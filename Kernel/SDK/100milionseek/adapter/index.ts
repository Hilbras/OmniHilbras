import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** 100milionseek's own adapter. Its base URL and id live here, not only in a dashboard card. */
export const oneHundredMillionSeekProviderId = '100milionseek';

export class OneHundredMillionSeekAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: '100milionseek',
      name: '100milionseek',
      baseUrl: 'https://100milionseek.top/v1',
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
