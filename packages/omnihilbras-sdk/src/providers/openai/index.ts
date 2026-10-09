import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '../openai-compatible/index.js';

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
      /**
       * The one adapter in this package that declares `embeddings` on its own account.
       *
       * Worth being precise about why this one is different from the general case. OpenAI documents
       * `/v1/embeddings` and names the models that serve it, so the endpoint's existence is a fact
       * about the provider rather than an inference from a URL shape. That is the same standard the
       * openai-compatible adapter deliberately does not meet — an OpenAI-shaped base URL says nothing
       * about whether that particular server implemented embeddings.
       *
       * It does not claim that every model works: `text-embedding-3-small` and `-large` do, and
       * `gpt-4o` does not. A model that cannot embed returns the provider's own 404 from
       * `/embeddings`, which is accurate and names the model — better than a gateway that refused
       * every model on the provider's behalf.
       */
      capabilities: { embeddings: true },
      headers: {
        ...(options.organization ? { 'OpenAI-Organization': options.organization } : {}),
        ...(options.project ? { 'OpenAI-Project': options.project } : {}),
      },
    }, options);
  }
}
