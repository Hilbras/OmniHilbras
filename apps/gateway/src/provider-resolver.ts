import { OpenAICompatibleAdapter, type ProviderAdapter, type ProviderRegistry } from '@hilbras/omnihilbras';

/**
 * Resolving a provider id to something that can serve traffic.
 *
 * Extracted because the resolution path was the last place in the Core that branched on a
 * provider's *name*:
 *
 * ```ts
 * if (providerId === 'cline') return this.clineAdapter();
 * if (providerId === 'opencode') return this.zenAdapter();
 * if (providerId === opencodeConsoleProviderId) return this.opencodeConsoleAdapter(providerId);
 * if (providerId === kiroProviderId) return this.kiroAdapter(providerId);
 * if (providerId === chatGptWebProviderId) return this.chatGptWebAdapter();
 * if (providerId === deepseekWebProviderId) return this.deepSeekAdapter();
 * ```
 *
 * Six lines, and the whole provider-coupled execution surface. They exist for one reason: those
 * adapters must be **built on demand**, because each needs a connection id, a lazily-created
 * driver, or a shared access-token cache. That is a factory, and a factory is a registration.
 *
 * ## What this does and does not achieve
 *
 * **Does:** the resolution algorithm in this file contains no provider id at all, and there is a
 * test that says so and fails if one is added. Adding a provider is a `.onDemand()` call rather
 * than a new branch, so the algorithm is the same shape whatever is registered.
 *
 * **Does not:** the service still names each on-demand provider once, when it registers it. The
 * remaining step towards "a provider adds itself" is for adapter modules to carry their own
 * registration, and that is worth doing — but pretending this file has already solved it would be
 * the kind of claim that reads as progress and is not.
 *
 * ## The fallbacks are load-bearing
 *
 * A provider that is neither registered nor on-demand is served as OpenAI-compatible against its
 * saved endpoint. That is what lets a dashboard-added custom endpoint serve traffic with no code
 * change at all, and it is why the registry lookup is tried *before* this fallback rather than
 * after: an explicitly registered adapter must never be shadowed by a generic one.
 */
export type PendingEndpoint = { endpoint: string; name: string };

/** Builds an adapter that cannot be constructed up front, because it needs per-connection state. */
export type AdapterFactory = (providerId: string) => ProviderAdapter;

export class ProviderResolver {
  private readonly onDemandFactories = new Map<string, AdapterFactory>();
  private readonly dynamic = new Map<string, { endpoint: string; adapter: ProviderAdapter }>();

  constructor(private readonly registry: ProviderRegistry) {}

  /**
   * Registers an adapter that has to be built when it is first needed.
   *
   * A factory rather than a value, because an instance would be shared across connections that
   * need different credentials. The factory receives the provider id so a multi-connection
   * provider can build a per-connection adapter.
   */
  onDemand(providerId: string, factory: AdapterFactory) {
    this.onDemandFactories.set(providerId, factory);
    return this;
  }

  /** The ids this resolver builds on demand, in registration order. */
  onDemandIds(): string[] {
    return [...this.onDemandFactories.keys()];
  }

  /**
   * The adapter for a provider, building it if it has to be built.
   *
   * Order matters and is not arbitrary: on-demand first, because those adapters are *specific* to
   * their provider and a generic OpenAI-compatible one would be wrong; then the registry; then the
   * saved-endpoint fallback, which is the only path that invents an adapter.
   */
  async resolve(providerId: string, pendingEndpoint?: PendingEndpoint, listConnections?: () => Promise<Array<{ providerId: string; endpoint: string; name: string }>>): Promise<ProviderAdapter> {
    const factory = this.onDemandFactories.get(providerId);
    if (factory) return factory(providerId);

    const registered = this.registry.get(providerId);
    if (registered) return registered;

    // A connection being saved is not in the store yet, so the caller can pass the endpoint it is
    // about to use.
    const connection = listConnections
      ? (await listConnections()).find((item) => item.providerId === providerId)
      : undefined;
    const endpoint = pendingEndpoint ?? (connection ? { endpoint: connection.endpoint, name: connection.name } : undefined);
    if (!endpoint) return this.registry.require(providerId);

    // Cached per endpoint, so a stable connection reuses one adapter — and a *changed* endpoint
    // gets a new one, because reusing the old adapter would keep sending to the old host.
    const cached = this.dynamic.get(providerId);
    if (cached && cached.endpoint === endpoint.endpoint) return cached.adapter;
    const adapter = new OpenAICompatibleAdapter({ id: providerId, name: endpoint.name, baseUrl: endpoint.endpoint });
    this.dynamic.set(providerId, { endpoint: endpoint.endpoint, adapter });
    return adapter;
  }

  /** The registered adapter for a provider, or a named failure. For callers that will not accept a synthesised one. */
  require(providerId: string): ProviderAdapter {
    return this.registry.require(providerId);
  }
}
