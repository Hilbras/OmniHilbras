import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';
import type { CredentialValidation, ProviderCredential, ProviderRequestContext } from '../lib/types.js';

/** Ollama's own adapter. Its base URL and id live here, not in a dashboard card. */
export const ollamaProviderId = 'ollama';

export class OllamaAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions & { endpoint?: string } = {}) {
    const { endpoint, ...transportOptions } = options;
    super({
      id: 'ollama',
      name: 'Ollama',
      baseUrl: endpoint ?? 'http://localhost:11434/v1',
      // A keyless local runtime must not be forced to present a credential. A proxied Ollama that
      // does have a key still sends it, because `required: false` only removes the failure.
      auth: { header: 'Authorization', prefix: 'Bearer', required: false },
    }, transportOptions);
  }

  /**
   * A local runtime has no credential to validate. The generic adapter has no `validateCredential`, so a keyless
   * save would be refused with 501 — the regression this own adapter exists to avoid.
   */
  async validateCredential(_credential: ProviderCredential | undefined, _context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: 0 };
  }
}
