import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from './openai-compatible.js';

export type OpenAIAdapterOptions = OpenAICompatibleAdapterOptions & {
  baseUrl?: string;
  organization?: string;
  project?: string;
};

export class OpenAIAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAIAdapterOptions = {}) {
    super({
      id: 'openai',
      name: 'OpenAI',
      baseUrl: options.baseUrl ?? 'https://api.openai.com/v1',
      auth: { header: 'Authorization', prefix: 'Bearer' },
      maxTokensField: 'max_completion_tokens',
      headers: {
        ...(options.organization ? { 'OpenAI-Organization': options.organization } : {}),
        ...(options.project ? { 'OpenAI-Project': options.project } : {}),
      },
    }, options);
  }
}
