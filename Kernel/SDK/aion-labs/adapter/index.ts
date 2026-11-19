import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from '@omnihilbras/sdk-openai';
import type { CredentialValidation, ProviderCredential, ProviderRequestContext } from '../lib/types.js';

/** Aion Labs's own adapter. Its base URL and id live here, not in a dashboard card. */
export const aion_labsProviderId = "aion-labs";

/**
 * Aion's `/models` catalog is public: it answers 200 to any caller, including one with no key or a
 * wrong one. A save that only read the catalog therefore accepted any string and the card reported a
 * credential check it never performed. The cheapest authenticated read this adapter can make is a
 * one-token completion; it costs a request, and the card says so.
 */
const PROBE_MODEL = 'aion-labs/aion-2.0';

export class AionLabsAdapter extends OpenAICompatibleAdapter {
  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    super({
      id: "aion-labs",
      name: "Aion Labs",
      baseUrl: "https://api.aionlabs.ai/v1",
      auth: { header: 'Authorization', prefix: 'Bearer' },
    }, options);
  }

  async validateCredential(credential: ProviderCredential | undefined, context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    if (!credential || credential.type === 'none' || !credential.value) {
      throw new Error('An Aion Labs API key is required.');
    }
    const startedAt = Date.now();
    const models = await this.listModels({ ...context, credential });
    const model = models[0]?.id ?? PROBE_MODEL;
    // A real request, deliberately one token. A public catalog cannot prove a key; the first
    // authenticated call can.
    await this.chat({ model, messages: [{ role: 'user', content: 'ping' }], maxOutputTokens: 1 }, { ...context, credential });
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt };
  }
}
