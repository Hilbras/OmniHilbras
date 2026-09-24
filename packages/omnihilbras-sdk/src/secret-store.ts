import type { ProviderCredential, ProviderId } from './types.js';

export interface SecretStore {
  get(providerId: ProviderId): Promise<ProviderCredential | undefined>;
}

export class InMemorySecretStore implements SecretStore {
  private readonly credentials = new Map<ProviderId, ProviderCredential>();

  constructor(initial: Readonly<Record<ProviderId, ProviderCredential>> = {}) {
    for (const [providerId, credential] of Object.entries(initial)) {
      this.credentials.set(providerId, credential);
    }
  }

  async get(providerId: ProviderId) {
    return this.credentials.get(providerId);
  }

  set(providerId: ProviderId, credential: ProviderCredential) {
    this.credentials.set(providerId, credential);
  }

  delete(providerId: ProviderId) {
    this.credentials.delete(providerId);
  }
}
