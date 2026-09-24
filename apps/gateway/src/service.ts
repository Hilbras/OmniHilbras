import { ProviderError, type ChatChunk, type ChatRequest, type ChatResponse, type Model, type ProviderAdapter, type ProviderHealth, type ProviderRegistry, type ProviderRequestContext, type SecretStore } from '@omnihilbras/sdk';

export type GatewayProviderHealth = ProviderHealth & {
  providerId: string;
};

export type GatewayModelList = {
  models: Model[];
  unavailable: Array<{ providerId: string; code: string }>;
};

export class GatewayService {
  constructor(
    readonly registry: ProviderRegistry,
    private readonly secretStore: SecretStore,
  ) {}

  async health(signal?: AbortSignal): Promise<{ status: 'ok' | 'degraded'; checkedAt: string; providers: GatewayProviderHealth[] }> {
    const providers = await Promise.all(this.registry.list().map(async (adapter) => {
      if (!adapter.healthCheck) return { providerId: adapter.id, status: 'unavailable' as const, checkedAt: new Date().toISOString(), message: 'Health checks are not supported.' };
      try {
        const health = await adapter.healthCheck(await this.context(adapter.id, signal));
        return { providerId: adapter.id, ...health };
      } catch {
        return { providerId: adapter.id, status: 'unavailable' as const, checkedAt: new Date().toISOString() };
      }
    }));
    return {
      status: providers.some((provider) => provider.status !== 'healthy') ? 'degraded' : 'ok',
      checkedAt: new Date().toISOString(),
      providers,
    };
  }

  async listAllModels(signal?: AbortSignal): Promise<GatewayModelList> {
    const results = await Promise.all(this.registry.list().map(async (adapter) => {
      if (!adapter.listModels || adapter.capabilities.models !== true) return { providerId: adapter.id, models: [], unavailable: { providerId: adapter.id, code: 'NOT_SUPPORTED' } };
      try {
        return { providerId: adapter.id, models: await adapter.listModels(await this.context(adapter.id, signal)), unavailable: undefined };
      } catch (error) {
        return { providerId: adapter.id, models: [], unavailable: { providerId: adapter.id, code: error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED' } };
      }
    }));
    return {
      models: results.flatMap((result) => result.models),
      unavailable: results.flatMap((result) => result.unavailable ? [result.unavailable] : []),
    };
  }

  async listModels(providerId: string, signal?: AbortSignal) {
    const adapter = this.requireAdapter(providerId);
    if (!adapter.listModels || adapter.capabilities.models !== true) throw notSupported(adapter, 'models');
    return adapter.listModels(await this.context(adapter.id, signal));
  }

  async chat(providerId: string, request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const adapter = this.requireAdapter(providerId);
    if (!adapter.chat || adapter.capabilities.chat !== true) throw notSupported(adapter, 'chat');
    return adapter.chat(request, await this.context(adapter.id, signal));
  }

  async *streamChat(providerId: string, request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const adapter = this.requireAdapter(providerId);
    if (!adapter.streamChat || adapter.capabilities.streaming !== true) throw notSupported(adapter, 'streaming');
    yield* adapter.streamChat(request, await this.context(adapter.id, signal));
  }

  private requireAdapter(providerId: string): ProviderAdapter {
    return this.registry.require(providerId);
  }

  private async context(providerId: string, signal?: AbortSignal): Promise<ProviderRequestContext> {
    return {
      credential: await this.secretStore.get(providerId),
      ...(signal ? { signal } : {}),
    };
  }
}

function notSupported(adapter: ProviderAdapter, capability: string) {
  const message = `${adapter.name} does not support ${capability}.`;
  return new ProviderError('NOT_SUPPORTED', message, { providerId: adapter.id, publicMessage: message });
}
