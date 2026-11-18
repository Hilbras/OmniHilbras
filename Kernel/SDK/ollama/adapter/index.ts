import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';
import type { CredentialValidation, ProviderCredential, ProviderRequestContext } from '../lib/types.js';

/** Ollama's own adapter. Its base URL and id live here, not in a dashboard card. */
export const ollamaProviderId = 'ollama';

export class OllamaAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: 'ollama',
      name: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }

  /**
   * A local runtime has no credential to validate. The generic adapter has no `validateCredential`, so a keyless
   * save would be refused with 501 — the regression this own adapter exists to avoid.
   */
  async validateCredential(_credential: ProviderCredential | undefined, _context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: 0 };
  }
}
