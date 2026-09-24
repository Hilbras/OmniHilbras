import { ProviderError, type ChatChunk, type ChatRequest, type ChatResponse, type Model, type ProviderAdapter, type ProviderCredential, type ProviderHealth, type ProviderRegistry, type ProviderRequestContext, type SecretStore } from '@omnihilbras/sdk';
import type { ConnectionInput, ConnectionRecord, ConnectionStore } from './connections.js';

export type GatewayProviderHealth = ProviderHealth & {
  providerId: string;
};

export type GatewayModelList = {
  models: Model[];
  unavailable: Array<{ providerId: string; code: string }>;
};

export type GatewayConnectionValidation = {
  providerId: string;
  valid: true;
  checkedAt: string;
  latencyMs?: number;
};

export class GatewayService {
  private readonly connectionLocks = new Map<string, Promise<void>>();

  constructor(
    readonly registry: ProviderRegistry,
    private readonly secretStore: SecretStore,
    private readonly connectionStore?: ConnectionStore,
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

  async validateConnectionCredential(providerId: string, credential: ProviderCredential, signal?: AbortSignal): Promise<GatewayConnectionValidation> {
    return this.withProviderLock(providerId, () => this.validateConnectionCredentialUnlocked(providerId, credential, signal));
  }

  async saveConnection(input: ConnectionInput, credential: ProviderCredential, signal?: AbortSignal): Promise<ConnectionRecord> {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    return this.withProviderLock(input.providerId, async () => {
      await this.validateConnectionCredentialUnlocked(input.providerId, credential, signal);
      if (signal?.aborted) throw new ProviderError('CANCELLED', 'The connection save was cancelled.', { providerId: input.providerId });
      try {
        return await this.connectionStore!.save(input, credential);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('CONFIGURATION_ERROR', 'The local connection could not be saved.', { cause: error });
      }
    });
  }

  async listConnections() {
    return this.connectionStore?.list() ?? [];
  }

  async removeConnection(connectionId: string) {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    const removed = await this.connectionStore.remove(connectionId);
    if (!removed) throw new ProviderError('NOT_FOUND', 'The local connection was not found.');
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

  private async validateConnectionCredentialUnlocked(providerId: string, credential: ProviderCredential, signal?: AbortSignal): Promise<GatewayConnectionValidation> {
    const adapter = this.requireAdapter(providerId);
    const context: ProviderRequestContext = { credential, ...(signal ? { signal } : {}) };
    if (!adapter.validateCredential) throw notSupported(adapter, 'credential validation');
    const result = await adapter.validateCredential(credential, context);
    return { providerId, valid: true, checkedAt: result?.checkedAt ?? new Date().toISOString(), ...(result?.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }) };
  }

  private async withProviderLock<T>(providerId: string, operation: () => Promise<T>) {
    const previous = this.connectionLocks.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.connectionLocks.set(providerId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.connectionLocks.get(providerId) === current) this.connectionLocks.delete(providerId);
    }
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
