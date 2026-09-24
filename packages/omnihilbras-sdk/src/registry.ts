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
    if (adapter.capabilities.streaming === true && typeof adapter.streamChat !== 'function') {
      throw new ProviderError('CONFIGURATION_ERROR', `Provider adapter enables streaming without streamChat: ${adapter.id}.`, { providerId: adapter.id });
    }
    if (adapter.capabilities.models === true && typeof adapter.listModels !== 'function') {
      throw new ProviderError('CONFIGURATION_ERROR', `Provider adapter enables models without listModels: ${adapter.id}.`, { providerId: adapter.id });
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
      throw new ProviderError('NOT_FOUND', `Provider adapter is not registered: ${providerId}.`, {
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
