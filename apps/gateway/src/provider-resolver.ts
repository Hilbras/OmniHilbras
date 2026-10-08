import { OpenAICompatibleAdapter, type ProviderAdapter, type ProviderRegistry } from '@hilbras/omnihilbras';
import { providerAlias } from './provider-alias.js';

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
 *
 * **Measured for an id nothing registers** (1.44.0), because the claim above had only ever been tested
 * with ids that predate the fallback. Four providers added as catalog cards with no adapter —
 * `kimi`, `qwen`, `groq`, `nvidia` — were saved as connections against a loopback port with nothing
 * listening, and a request routed through each:
 *
 * ```
 * save 200   route 502 PROVIDER_UNAVAILABLE     ← reached the endpoint
 * refused as an UNKNOWN provider? no — the fallback engaged
 * ```
 *
 * The `502` is the whole point. A request refused for an unknown provider and a request that reached a
 * dead endpoint look identical to the client and mean opposite things to whoever is debugging; only the
 * second one proves the fallback built an adapter. `tests/new-provider-cards.test.js` covers the half CI
 * can run — that a new card's id collides with no registered adapter and is not mistaken for a
 * web-session provider.
 */
export type PendingEndpoint = { endpoint: string; name: string };

/** What this resolver needs to know about a saved connection. */
type SavedConnection = { id: string; providerId: string; endpoint: string; name: string };

/** The connection an on-demand adapter should be built for, when one exists. */
export type AdapterContext = {
  providerId: string;
  /**
   * The saved connection for this provider, if it has one.
   *
   * Supplied rather than looked up by the factory, because two callers used to look it up
   * *differently* — the resolution path passed the provider id where the health path passed the
   * connection id — and the adapters built from it write refreshed credentials back to the store
   * under that value. Whichever caller built first won, which made the key depend on whether a
   * health probe or a request happened to arrive first.
   */
  connection?: { id: string };
};

/** Builds an adapter that cannot be constructed up front, because it needs per-connection state. */
export type AdapterFactory = (context: AdapterContext) => ProviderAdapter;

/**
 * What an on-demand provider needs from the save path.
 *
 * `validateOnSave` exists because a capability cannot be inferred from the factory. Several
 * on-demand adapters *do* have a `validateCredential`, and for most of them running it at save time
 * is wrong: proving a ChatGPT Web credential means opening a browser, so a save would launch one
 * and could fail on a network the connection does not otherwise need. The original code handled
 * this by naming Cline in a literal branch; this is the same decision, stated where it is visible.
 */
export type OnDemandOptions = {
  /**
   * Prove the credential before storing it, for a provider that is absent from the registry and
   * therefore invisible to the registry's own capability check.
   *
   * Defaults to false. Guessing `true` because an adapter happens to have a validator is how a save
   * button starts opening browsers.
   */
  validateOnSave?: boolean;
};

export class ProviderResolver {
  private readonly onDemandFactories = new Map<string, AdapterFactory>();
  private readonly onDemandOptions = new Map<string, OnDemandOptions>();
  private readonly dynamic = new Map<string, { endpoint: string; adapter: ProviderAdapter }>();

  constructor(private readonly registry: ProviderRegistry) {}

  /**
   * Registers an adapter that has to be built when it is first needed.
   *
   * A factory rather than a value, because an instance would be shared across connections that
   * need different credentials. The factory receives the provider id so a multi-connection
   * provider can build a per-connection adapter.
   */
  onDemand(providerId: string, factory: AdapterFactory, options: OnDemandOptions = {}) {
    this.onDemandFactories.set(providerId, factory);
    this.onDemandOptions.set(providerId, options);
    return this;
  }

  /**
   * Whether a credential for this provider should be proven before the connection is stored.
   *
   * A registered adapter is asked what it can do. An on-demand one is asked what it *declared*,
   * because a factory cannot be inspected without building the adapter — and building it to answer
   * a question is how a save button ends up opening a browser.
   */
  canValidateCredential(providerId: string): boolean {
    const registered = this.registry.get(providerId);
    if (registered) return Boolean(registered.validateCredential);
    return this.onDemandOptions.get(providerId)?.validateOnSave === true;
  }

  /** The ids this resolver builds on demand, in registration order. */
  onDemandIds(): string[] {
    return [...this.onDemandFactories.keys()];
  }

  /**
   * The on-demand adapters whose provider actually has a credential.
   *
   * This replaces six hand-written branches, one per provider, that each looked for a connection
   * with a credential and built an adapter. Two of them needed the connection id and four did not,
   * so the six shapes were not the same shape — and the two that took an id were called with the
   * provider id from one path and the connection id from the other.
   *
   * A provider with no static configuration is only polled once a credential exists, because
   * probing it without one costs a request that cannot succeed. That rule is the whole of this
   * method.
   */
  async active(connections: ReadonlyArray<{ id: string; providerId: string; hasCredential: boolean }>): Promise<ProviderAdapter[]> {
    const adapters: ProviderAdapter[] = [];
    for (const [providerId, factory] of this.onDemandFactories) {
      // A provider that shares another's credential is polled when **that** connection has one — the
      // ClinePass card is served by the Cline connection. The connection *id* is still the owner's, but
      // the factory is built for the provider that registered it, so the adapter and its failure text
      // name the right card. This is the one place the alias touches the resolver.
      const canonical = providerAlias(providerId) ?? providerId;
      const connection = connections.find((item) => item.providerId === canonical && item.hasCredential);
      if (!connection) continue;
      adapters.push(factory({ providerId, connection: { id: connection.id } }));
    }
    return adapters;
  }

  /**
   * The connection this provider has, if any.
   *
   * Asked for rather than passed in, so a caller cannot supply a different answer to this and to
   * `active()`.
   */
  private async savedConnectionFor(
    providerId: string,
    listConnections?: () => Promise<ReadonlyArray<SavedConnection>>,
  ): Promise<SavedConnection | undefined> {
    if (!listConnections) return undefined;
    return (await listConnections()).find((item) => item.providerId === providerId);
  }

  /**
   * The adapter for a provider, building it if it has to be built.
   *
   * Order matters and is not arbitrary: on-demand first, because those adapters are *specific* to
   * their provider and a generic OpenAI-compatible one would be wrong; then the registry; then the
   * saved-endpoint fallback, which is the only path that invents an adapter.
   */
  async resolve(providerId: string, pendingEndpoint?: PendingEndpoint, listConnections?: () => Promise<ReadonlyArray<SavedConnection>>): Promise<ProviderAdapter> {
    const factory = this.onDemandFactories.get(providerId);
    if (factory) {
      // Only the id crosses. The saved connection is looked up here rather than in the factory, so
      // this path and `active()` cannot disagree about which connection an adapter belongs to — and
      // the rest of the record stays the connection layer's business rather than becoming a second
      // opinion about the endpoint.
      const saved = await this.savedConnectionFor(providerId, listConnections);
      return factory({ providerId, ...(saved ? { connection: { id: saved.id } } : {}) });
    }

    const registered = this.registry.get(providerId);
    if (registered) return registered;

    // A connection being saved is not in the store yet, so the caller can pass the endpoint it is
    // about to use.
    const connection = await this.savedConnectionFor(providerId, listConnections);
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
