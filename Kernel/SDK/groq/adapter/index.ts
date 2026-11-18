import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';

/** Groq's own adapter. Its base URL and id live here, not in a dashboard card. */
export const groqProviderId = "groq";

export class GroqAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "groq",
      name: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }
}
