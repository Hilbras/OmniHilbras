import { ProviderError } from './errors.js';
import type { ProviderAdapter, ProviderCapability, ProviderId } from './types.js';

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();

  register(adapter: ProviderAdapter) {
    if (!adapter.id.trim()) {
      throw new ProviderError('CONFIGURATION_ERROR', 'Provider adapters must have an id.');
    }
    if (this.adapters.has(adapter.id)) {
      throw new ProviderError('CONFIGURATION_ERROR', `Provider adapter already registered: ${adapter.id}.`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  unregister(providerId: ProviderId) {
    return this.adapters.delete(providerId);
  }

  get(providerId: ProviderId) {
    return this.adapters.get(providerId);
  }

  require(providerId: ProviderId) {
    const adapter = this.get(providerId);
    if (!adapter) {
      throw new ProviderError('CONFIGURATION_ERROR', `Provider adapter is not registered: ${providerId}.`, {
        providerId,
      });
    }
    return adapter;
  }

  has(providerId: ProviderId) {
    return this.adapters.has(providerId);
  }

  supports(providerId: ProviderId, capability: ProviderCapability) {
    return this.require(providerId).capabilities[capability] === true;
  }

  list() {
    return [...this.adapters.values()];
  }
}
