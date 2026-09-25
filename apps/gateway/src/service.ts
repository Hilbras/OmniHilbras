import { ProviderError, type ChatChunk, type ChatRequest, type ChatResponse, type Model, type ModelImportPolicy, type ProviderAdapter, type ProviderCredential, type ProviderHealth, type ProviderRegistry, type ProviderRequestContext, type SecretStore } from '@omnihilbras/sdk';
import { ApiKeyLimitError, type ApiKeyRecord, type ApiKeyStore, type CreatedApiKey } from './api-keys.js';
import { ConnectionMetadataLimitError, ConnectionModelLimitError, type ConnectionInput, type ConnectionRecord, type ConnectionStore } from './connections.js';

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

export type GatewayApiKeyList = {
  keys: ApiKeyRecord[];
  requireApiKey: boolean;
};

const connectionMutationLock = 'connection-mutations';
const apiKeyMutationLock = 'api-key-mutations';
const missingApiKeyMessage = 'This gateway requires an API key. Create one on the API keys page and send it as "Authorization: Bearer <key>".';
const invalidApiKeyMessage = 'The API key is invalid or paused.';

export class GatewayService {
  private readonly connectionLocks = new Map<string, Promise<void>>();

  constructor(
    readonly registry: ProviderRegistry,
    private readonly secretStore: SecretStore,
    private readonly connectionStore?: ConnectionStore,
    private readonly apiKeyStore?: ApiKeyStore,
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
    return this.withProviderLock(connectionMutationLock, async () => {
      await this.validateConnectionCredentialUnlocked(input.providerId, credential, signal);
      let saveInput = input;
      if (input.modelPolicy) {
        const discoveredModelIds = await this.discoverConnectionModels(input.providerId, credential, input.modelPolicy, signal);
        const existing = (await this.connectionStore!.list()).find((connection) => (input.id ? connection.id === input.id : connection.providerId === input.providerId));
        const customModelIds = input.customModelIds ?? existing?.customModelIds ?? [];
        saveInput = { ...input, modelIds: [...discoveredModelIds, ...customModelIds], customModelIds };
      }
      if (signal?.aborted) throw new ProviderError('CANCELLED', 'The connection save was cancelled.', { providerId: input.providerId });
      try {
        return await this.connectionStore!.save(saveInput, credential);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof ConnectionModelLimitError || error instanceof ConnectionMetadataLimitError) throw new ProviderError('INVALID_REQUEST', error.message, { cause: error });
        throw new ProviderError('CONFIGURATION_ERROR', 'The local connection could not be saved.', { cause: error });
      }
    });
  }

  async listConnections() {
    return this.connectionStore?.list() ?? [];
  }

  async addConnectionModels(connectionId: string, modelIds: string[]) {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    return this.withProviderLock(connectionMutationLock, async () => {
      try {
        const connection = await this.connectionStore!.updateModels(connectionId, modelIds);
        if (!connection) throw new ProviderError('NOT_FOUND', 'The local connection was not found.');
        return connection;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof ConnectionModelLimitError || error instanceof ConnectionMetadataLimitError) throw new ProviderError('INVALID_REQUEST', error.message, { cause: error });
        throw new ProviderError('CONFIGURATION_ERROR', 'The local model catalog could not be saved.', { cause: error });
      }
    });
  }

  async removeConnection(connectionId: string) {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    return this.withProviderLock(connectionMutationLock, async () => {
      const removed = await this.connectionStore!.remove(connectionId);
      if (!removed) throw new ProviderError('NOT_FOUND', 'The local connection was not found.');
    });
  }

  async listApiKeys(): Promise<GatewayApiKeyList> {
    if (!this.apiKeyStore) return { keys: [], requireApiKey: false };
    const [keys, requireApiKey] = await Promise.all([this.apiKeyStore.list(), this.apiKeyStore.isEnforced()]);
    return { keys, requireApiKey };
  }

  async createApiKey(name: string): Promise<CreatedApiKey> {
    return this.withApiKeyMutation(() => this.apiKeyStore!.create(name));
  }

  async setApiKeyEnabled(id: string, enabled: boolean) {
    return this.withApiKeyMutation(async () => {
      const record = await this.apiKeyStore!.setEnabled(id, enabled);
      if (!record) throw new ProviderError('NOT_FOUND', 'The API key was not found.');
      return record;
    });
  }

  async removeApiKey(id: string) {
    return this.withApiKeyMutation(async () => {
      const removed = await this.apiKeyStore!.remove(id);
      if (!removed) throw new ProviderError('NOT_FOUND', 'The API key was not found.');
    });
  }

  async setRequireApiKey(value: boolean) {
    return this.withApiKeyMutation(() => this.apiKeyStore!.setEnforced(value));
  }

  /**
   * Guards the public LLM surface. Callers that are already trusted local
   * administration surfaces (the dashboard) must not call this.
   */
  async authorizePublicRequest(presentedKey: string | undefined) {
    // Embedders and unit tests construct the service without key storage.
    if (!this.apiKeyStore || !(await this.apiKeyStore.isEnforced())) return;
    if (!presentedKey) throw new ProviderError('AUTHENTICATION_FAILED', missingApiKeyMessage, { publicMessage: missingApiKeyMessage });
    if (!(await this.apiKeyStore.authenticate(presentedKey))) throw new ProviderError('AUTHENTICATION_FAILED', invalidApiKeyMessage, { publicMessage: invalidApiKeyMessage });
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

  private async discoverConnectionModels(providerId: string, credential: ProviderCredential, policy: ModelImportPolicy, signal?: AbortSignal) {
    const adapter = this.requireAdapter(providerId);
    const context: ProviderRequestContext = { credential, ...(signal ? { signal } : {}) };
    const models = adapter.discoverModels
      ? await adapter.discoverModels(context, { policy })
      : policy === 'all' && adapter.listModels && adapter.capabilities.models === true
        ? await adapter.listModels(context)
        : undefined;
    if (!models) throw notSupported(adapter, policy === 'free' ? 'free model discovery' : 'model discovery');
    return models.map((model) => model.id);
  }

  private async validateConnectionCredentialUnlocked(providerId: string, credential: ProviderCredential, signal?: AbortSignal): Promise<GatewayConnectionValidation> {
    const adapter = this.requireAdapter(providerId);
    const context: ProviderRequestContext = { credential, ...(signal ? { signal } : {}) };
    if (!adapter.validateCredential) throw notSupported(adapter, 'credential validation');
    const result = await adapter.validateCredential(credential, context);
    return { providerId, valid: true, checkedAt: result?.checkedAt ?? new Date().toISOString(), ...(result?.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }) };
  }

  private async withApiKeyMutation<T>(operation: () => Promise<T>) {
    if (!this.apiKeyStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local API key storage is not configured.');
    return this.withProviderLock(apiKeyMutationLock, async () => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof ApiKeyLimitError) throw new ProviderError('INVALID_REQUEST', error.message, { cause: error });
        throw new ProviderError('CONFIGURATION_ERROR', 'The local API key store could not be updated.', { cause: error });
      }
    });
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
