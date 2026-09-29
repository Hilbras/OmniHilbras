import { ProviderError, type Model, type ModelImportPolicy, type ProviderAdapter, type ProviderCredential, type ProviderRequestContext } from '@hilbras/omnihilbras';
import { notSupported } from './capability.js';
import type { ConnectionManager } from './connection-manager.js';
import type { CredentialManager } from './credential-manager.js';

/**
 * What this gateway serves, and which provider serves what.
 *
 * Four provider-neutral jobs that were scattered through the composition root: the list a client
 * sees, the list one provider offers, which provider a model id belongs to, and what a provider will
 * actually serve when asked. None of them names a provider, and together they are the whole of
 * "what models can I use" — which is a question about the catalog, not about the gateway.
 *
 * ## The catalogue a client sees is the saved one, not the provider's
 *
 * With connections, `/v1/models` advertises what has been imported rather than asking each provider
 * what it *could* serve. A provider's full inventory includes paid tiers the connection has no
 * entitlement to, and advertising them turns every one into a request that fails at the provider
 * instead of a model the client never asks for.
 *
 * With no connections there is nothing saved, so the adapters are asked directly. That is not a
 * fallback for convenience — it is the only way an embedded service, which has a registry and no
 * connection store, can answer the question at all.
 */
export type ModelCatalogDeps = {
  connections: ConnectionManager;
  credentials: CredentialManager;
  /** Resolves a provider, building its adapter when it has to be built. */
  resolveAdapter: (providerId: string, pendingEndpoint?: { endpoint: string; name: string }) => Promise<ProviderAdapter>;
  /** Every adapter worth asking, registered and credentialed-on-demand alike. */
  activeAdapters: () => Promise<ProviderAdapter[]>;
  /** The provider to fall back to when a model id identifies nothing. */
  defaultProviderId: string;
};

export type GatewayModelList = {
  models: Model[];
  unavailable: Array<{ providerId: string; code: string }>;
};

export class ModelCatalog {
  constructor(private readonly deps: ModelCatalogDeps) {}

  /**
   * What a client should see.
   *
   * A provider that cannot list its models is reported in `unavailable` rather than omitted, so the
   * dashboard can say *this provider offers nothing right now* instead of leaving a card blank and
   * letting the operator wonder whether the toggle worked.
   */
  async listAll(signal?: AbortSignal): Promise<GatewayModelList> {
    const connections = (await this.deps.connections.list()).filter((connection) => connection.enabled && connection.hasCredential);
    if (connections.length > 0) {
      return {
        models: connections.flatMap((connection) => connection.modelIds.map((id) => ({ id, providerId: connection.providerId }) satisfies Model)),
        unavailable: [],
      };
    }

    const results = await Promise.all((await this.deps.activeAdapters()).map(async (adapter) => {
      if (!adapter.listModels || adapter.capabilities.models !== true) {
        return { providerId: adapter.id, models: [], unavailable: { providerId: adapter.id, code: 'NOT_SUPPORTED' } };
      }
      try {
        return { providerId: adapter.id, models: await adapter.listModels(await this.deps.credentials.contextForProvider(adapter.id, signal)), unavailable: undefined };
      } catch (error) {
        // The code, not the message: the dashboard classifies by it, and a provider that refused
        // must not take the whole list down with it.
        return { providerId: adapter.id, models: [], unavailable: { providerId: adapter.id, code: error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED' } };
      }
    }));
    return {
      models: results.flatMap((result) => result.models),
      unavailable: results.flatMap((result) => result.unavailable ? [result.unavailable] : []),
    };
  }

  /** What one provider offers, or a named refusal when it cannot say. */
  async listForProvider(providerId: string, adapter: ProviderAdapter, signal?: AbortSignal): Promise<readonly Model[]> {
    if (!adapter.listModels || adapter.capabilities.models !== true) throw notSupported(adapter, 'models');
    return adapter.listModels(await this.deps.credentials.contextForProvider(providerId, signal));
  }

  /**
   * Which provider should serve a model id.
   *
   * The order is the substance, and each step is a different kind of certainty:
   *
   * 1. **The caller named one.** It is not this method's job to overrule that.
   * 2. **Exactly one saved connection owns the model.** Unambiguous, and the common case.
   * 3. **Several own it.** Then a chat-capable one is preferred, because owning a model in a catalog
   *    is not the same as being able to answer it, and a model that routes to an embeddings-only
   *    connection fails for a reason nobody can see from the catalog.
   * 4. **One connection exists at all.** Use it. A single-connection gateway should not refuse to
   *    answer because its provider's catalog is stale — that is the manually added model case.
   * 5. **Nothing identifies it.** The default, and no attempt to guess better than that.
   */
  async resolveProviderId(model: string, explicitProviderId?: string): Promise<string> {
    if (explicitProviderId) return explicitProviderId;
    const modelId = model.trim();
    if (!modelId) return this.deps.defaultProviderId;
    const connections = (await this.deps.connections.list()).filter((connection) => connection.enabled && connection.hasCredential);
    const owners = [...new Set(connections.filter((connection) => connection.modelIds.includes(modelId)).map((connection) => connection.providerId))];
    if (owners.length === 1) return owners[0]!;
    if (owners.length > 1) {
      const chatCapable = (await this.deps.activeAdapters()).find((adapter) => owners.includes(adapter.id) && adapter.capabilities.chat === true);
      return chatCapable?.id ?? owners[0]!;
    }
    if (connections.length === 1) return connections[0]!.providerId;
    return this.deps.defaultProviderId;
  }

  /**
   * Asks a provider what it serves, under a connection's import policy.
   *
   * The policy travels twice — on the context and as an argument — because a provider may read it
   * either way, and a `free` import that is correct on connect and comes back in full on the next
   * refresh is a toggle that stops working once you stop looking at it.
   *
   * Both discovery paths are open for either policy, and that is deliberate. An adapter that narrows
   * by the policy does so; one that ignores it returns its full list, which is the documented
   * meaning of a `free` policy on a provider that cannot narrow. Gating the branch on
   * `policy === 'all'` looked stricter and was worse: it made a free-only connection
   * **unrefreshable**, so the toggle could create a connection that broke the next time anybody
   * asked the provider what it serves.
   */
  async discover(input: {
    providerId: string;
    credential: ProviderCredential;
    policy: ModelImportPolicy;
    signal?: AbortSignal;
    pendingEndpoint?: { endpoint: string; name: string };
  }): Promise<readonly Model[]> {
    const adapter = await this.deps.resolveAdapter(input.providerId, input.pendingEndpoint);
    const context: ProviderRequestContext = { credential: input.credential, importPolicy: input.policy, ...(input.signal ? { signal: input.signal } : {}) };
    const models = adapter.discoverModels
      ? await adapter.discoverModels(context, { policy: input.policy })
      : adapter.listModels && adapter.capabilities.models === true
        ? await adapter.listModels(context)
        : undefined;
    if (!models) throw notSupported(adapter, input.policy === 'free' ? 'free model discovery' : 'model discovery');
    return models;
  }
}
