import { CLINE_OAUTH, ChatGptWebAdapter, FetchHttpTransport, KiroAdapter, chatGptWebCredential, chatGptWebModels, isFreeChatGptPlan, parseChatGptStorageState, chatGptWebProviderId, deepSeekWebCredential, deepseekWebProviderId, DeepSeekWebAdapter, probeQwenWeb, OpenAICompatibleAdapter, OpencodeConsoleAdapter, ProviderError, ZenAdapter, exchangeKiroSocialCode, kiroCredentialFromApiKey, kiroProviderId, type ChatChunk, type ChatRequest, type ChatResponse, type HttpTransport, type Model, type ModelImportPolicy, type ProviderAdapter, type ProviderCredential, type ProviderHealth, type ChatGptWebDriver, type ProviderRegistry, type ProviderRequestContext } from '@hilbras/omnihilbras';
import { ApiKeyLimitError, type ApiKeyRecord, type ApiKeyStore, type CreatedApiKey } from './api-keys.js';
import { ConnectionMetadataLimitError, ConnectionModelLimitError, defaultResilienceSettings, modelMetaPriceOrder, type ConnectionInput, type ConnectionRecord, type ConnectionStore, type ModelMeta, type ModelMetaMap, type ResilienceSettings } from './connections.js';
import { ClineSessionStore, beginClineAuthorization, clineCallbackPathFor, createClineAdapter, exchangeClineCode, providerSaid, toClineCredential } from './oauth.js';
import { OpencodeConsoleSessionStore, beginOpencodeConsoleSignIn, opencodeConsoleProviderId, pollOpencodeConsoleSignIn, type OpencodeConsoleSessionStatus } from './opencodeConsole.js';
import { KiroSessionStore, KiroSocialStore, importKiroRefreshToken, pollKiroSignInWithClaim, startKiroSignIn, startKiroSocialSignIn, type KiroSignInStatus } from './kiro.js';
import { createChatGptWebDriver } from './chatgptWeb.js';
import { HealthRegistry, SlidingWindowRateLimiter, isRetryableFailure, noCandidateMessage, resolveRoute, type RouteCandidate } from './routing.js';

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
const defaultProviderId = 'openai';
/** Consecutive failures before routing stops sending traffic to a connection. */
const defaultFailureThreshold = 3;
/** How often background health polling runs. 0 disables it. */
const defaultHealthIntervalMs = 60_000;

export type GatewayFailoverAttempt = {
  providerId: string;
  attempt: number;
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
};

export type GatewayChatOutcome = {
  response: ChatResponse;
  attempts: GatewayFailoverAttempt[];
};

export type GatewayStreamOutcome = {
  chunks: AsyncIterable<ChatChunk>;
  attempts: GatewayFailoverAttempt[];
};

/** The credential surface the service needs, keyed by connection id. */
export type CredentialSource = Pick<ConnectionStore, 'get' | 'set' | 'delete'>;

export type GatewayServiceOptions = {
  /** Consecutive failures before a connection stops receiving traffic. */
  failureThreshold?: number;
  /** How long an ejected connection waits before one probe request. */
  recoveryCooldownMs?: number;
  /** Injectable clock for the rate limiter and recovery cooldown. */
  now?: () => number;
  /** Shared transport, so provider and OAuth requests use one configured client. */
  transport?: HttpTransport;
  /**
   * Replaces the browser driver ChatGPT Web is driven through.
   *
   * Verifying a ChatGPT session means opening chatgpt.com, so the check and the connect both
   * cost a browser. This is the seam that lets that be tested without one, and the seam a
   * caller would use to supply a browser of their own.
   */
  chatGptWebDriver?: ChatGptWebDriver;
};

/** Error codes that mean "this request can never succeed on this route". */
const terminalRouteCodes = new Set(['INVALID_REQUEST', 'AUTHENTICATION_FAILED', 'NOT_SUPPORTED', 'NOT_FOUND']);

function noRouteAvailable(skipped: Array<{ providerId: string; reason: string }>) {
  const detail = skipped.length > 0 ? ` Skipped: ${skipped.map((entry) => `${entry.providerId} (${entry.reason})`).join(', ')}.` : '';
  return new ProviderError('PROVIDER_UNAVAILABLE', `${noCandidateMessage}${detail}`, { retryable: true, publicMessage: `${noCandidateMessage}${detail}` });
}

function attachAttempts(error: unknown, attempts: GatewayFailoverAttempt[]) {
  const failedProviders = [...new Set(attempts.filter((attempt) => !attempt.ok).map((attempt) => attempt.providerId))];
  if (error instanceof ProviderError) {
    // A single route keeps the adapter's own redacted public message, so existing
    // error semantics do not change when failover never engaged.
    if (failedProviders.length <= 1) {
      const suffix = failedProviders.length === 1 ? ` Tried: ${failedProviders[0]}.` : '';
      return new ProviderError(error.code, `${error.message}${suffix}`, {
        ...(error.providerId ? { providerId: error.providerId } : {}),
        ...(error.statusCode ? { statusCode: error.statusCode } : {}),
        retryable: error.retryable,
        ...(error.publicMessage ? { publicMessage: `${error.publicMessage}${suffix}` } : {}),
        // Carried through: without this the provider's own wording is lost the
        // moment a request passes through the failover path, and the operator is
        // left with a generic refusal and no cause.
        ...(error.details === undefined ? {} : { details: error.details }),
        cause: error,
      });
    }
    if (terminalRouteCodes.has(error.code)) {
      return new ProviderError(error.code, `${error.message} Tried: ${failedProviders.join(', ')}.`, {
        ...(error.providerId ? { providerId: error.providerId } : {}),
        ...(error.statusCode ? { statusCode: error.statusCode } : {}),
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
        cause: error,
      });
    }
    const message = `Every provider route failed. Tried: ${failedProviders.join(', ')}.`;
    return new ProviderError('PROVIDER_UNAVAILABLE', message, { retryable: true, publicMessage: message, cause: error });
  }
  const message = `Every provider route failed.${failedProviders.length > 0 ? ` Tried: ${failedProviders.join(', ')}.` : ''}`;
  return new ProviderError('PROVIDER_REQUEST_FAILED', message, { retryable: true, publicMessage: message, cause: error });
}
const missingApiKeyMessage = 'This gateway requires an API key. Create one on the API keys page and send it as "Authorization: Bearer <key>".';
const invalidApiKeyMessage = 'The API key is invalid or paused.';

export class GatewayService {
  private readonly connectionLocks = new Map<string, Promise<void>>();
  private readonly dynamicAdapters = new Map<string, { endpoint: string; adapter: ProviderAdapter }>();
  private readonly transport: HttpTransport;
  private cline?: ProviderAdapter;
  private zen?: ProviderAdapter;
  private opencodeConsole?: ProviderAdapter;
  private readonly opencodeConsoleSessions = new OpencodeConsoleSessionStore();
  private readonly kiroSessions = new KiroSessionStore();
  private readonly kiroSocial = new KiroSocialStore();
  private chatGptWeb?: ProviderAdapter;
  /** DeepSeek Web, built once so its access-token cache is shared across requests. */
  private deepSeek?: DeepSeekWebAdapter;
  private kiro?: ProviderAdapter;
  /** Why the last model discovery failed, when it was tolerated rather than fatal. */
  private lastDiscoveryNote?: string;
  private readonly clineSessions = new ClineSessionStore();
  private readonly providerHealth: HealthRegistry;
  private readonly rateLimiter: SlidingWindowRateLimiter;
  private readonly rateLimitWaitMs = new Map<string, number>();
  private failureThreshold = defaultFailureThreshold;
  private healthIntervalMs = defaultHealthIntervalMs;
  /** The most recent full sweep, served to every `GET /health` until the next one lands. */
  private lastHealth: { status: 'ok' | 'degraded'; checkedAt: string; providers: GatewayProviderHealth[] } | undefined;
  /** The sweep in flight, so concurrent callers share it rather than each starting one. */
  private healthSweep: Promise<{ status: 'ok' | 'degraded'; checkedAt: string; providers: GatewayProviderHealth[] }> | undefined;
  private healthTimer?: NodeJS.Timeout;
  /** Kept whole, because the ChatGPT Web driver is built lazily on first use. */
  private readonly options: GatewayServiceOptions;

  constructor(
    readonly registry: ProviderRegistry,
    /**
   * Credentials are read per connection, so this is the narrow credential
   * surface rather than the SDK's provider-keyed `SecretStore`. A store whose
   * `get` ignores the provider id still satisfies it, which is what keeps the
   * in-memory test store usable.
   */
  private readonly secretStore: CredentialSource,
    private readonly connectionStore?: ConnectionStore,
    private readonly apiKeyStore?: ApiKeyStore,
    options: GatewayServiceOptions = {},
  ) {
    if (options.failureThreshold !== undefined) this.failureThreshold = options.failureThreshold;
    // Kept, not just read: the ChatGPT Web driver is built lazily on first use, long after
    // the constructor has returned, so the override has to outlive this call.
    this.options = options;
    this.transport = options.transport ?? new FetchHttpTransport();
    const now = options.now ?? (() => Date.now());
    this.providerHealth = new HealthRegistry(now, options.recoveryCooldownMs);
    this.rateLimiter = new SlidingWindowRateLimiter(now);
  }

  /** How often background health polling runs. 0 keeps polling off. */
  setHealthInterval(intervalMs: number) {
    this.healthIntervalMs = intervalMs;
    if (this.healthTimer) this.startHealthMonitor();
  }

  /** Starts background health polling so routing reflects reality without a request. */
  startHealthMonitor(intervalMs = this.healthIntervalMs) {
    this.stopHealthMonitor();
    this.healthIntervalMs = intervalMs;
    if (intervalMs <= 0) return;
    this.healthTimer = setInterval(() => { void this.refreshHealth(); }, intervalMs);
    this.healthTimer.unref?.();
    void this.refreshHealth();
  }

  stopHealthMonitor() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
  }

  /**
   * Polls every configured adapter and folds the result into routing state.
   *
   * Also stores the result, so `health()` can answer from it instead of starting a second
   * sweep per HTTP request. Concurrent callers share one sweep: without that, a page reload
   * and the background timer landing together would each start their own thirteen probes.
   */
  async refreshHealth(signal?: AbortSignal): Promise<{ status: 'ok' | 'degraded'; checkedAt: string; providers: GatewayProviderHealth[] }> {
    if (!this.healthSweep) {
      this.healthSweep = this.runHealthSweep(signal).finally(() => {
        this.healthSweep = undefined;
      });
    }
    return this.healthSweep;
  }

  private async runHealthSweep(signal?: AbortSignal): Promise<{ status: 'ok' | 'degraded'; checkedAt: string; providers: GatewayProviderHealth[] }> {
    const providers = await Promise.all((await this.activeAdapters()).map((adapter) => this.probeAdapter(adapter, signal)));
    const result = {
      status: providers.some((provider) => provider.status !== 'healthy') ? 'degraded' as const : 'ok' as const,
      checkedAt: new Date().toISOString(),
      providers,
    };
    this.lastHealth = result;
    this.rateLimiter.prune();
    return result;
  }

  /**
   * Probes one adapter and folds the result into routing state.
   *
   * Extracted from the full sweep so that "Test provider" can ask about the one provider the
   * user is looking at. Reading `/health` to answer that question meant waiting for all
   * thirteen providers to be probed — and on a loaded machine that was long enough that the
   * button looked permanently stuck, which is the same failure as a wrong answer: the user
   * learns nothing.
   */
  private async probeAdapter(adapter: ProviderAdapter, signal?: AbortSignal): Promise<GatewayProviderHealth> {
    if (!adapter.healthCheck) {
      return { providerId: adapter.id, status: 'unavailable' as const, checkedAt: new Date().toISOString(), message: 'Health checks are not supported.' };
    }
    const startedAt = Date.now();
    try {
      // Health is reported per provider, so it is checked with that provider's
      // first credentialed connection.
      const owner = await this.connectionFor(adapter.id);
      const health = await adapter.healthCheck(await this.context(owner?.id ?? adapter.id, adapter.id, signal));
      // An adapter may report `unavailable` instead of throwing. Recording
      // that as a success made routing report a healthy provider with zero
      // failures while `/health` said unavailable, and it corrupted the
      // failure counting that drives ejection.
      if (health.status === 'unavailable') {
        this.providerHealth.recordFailure(adapter.id, 'PROVIDER_UNAVAILABLE', health.message ?? 'The provider reported itself unavailable.');
        // The reason is returned too, so /health and the dashboard can say why
        // rather than only that something is wrong.
        return { providerId: adapter.id, ...health };
      }
      this.providerHealth.recordSuccess(adapter.id, health.latencyMs ?? Date.now() - startedAt, health.checkedAt);
      return { providerId: adapter.id, latencyMs: Date.now() - startedAt, ...health };
    } catch (error) {
      this.providerHealth.recordFailure(adapter.id, 'PROVIDER_UNAVAILABLE', 'The provider health check failed.');
      // The underlying reason, because "The provider health check failed" sends the user
      // looking at the provider when the cause was their own connection.
      return {
        providerId: adapter.id,
        status: 'unavailable' as const,
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The provider health check failed.',
      };
    }
  }

  /**
   * Health for a single provider, without the cost of the whole sweep.
   *
   * A provider that is not in the active set is named in the error rather than reported
   * unhealthy: "no such provider" and "this provider is down" are different problems, and
   * the second one sends the user to fix a credential that was never the issue.
   */
  async healthForProvider(providerId: string, signal?: AbortSignal): Promise<GatewayProviderHealth> {
    const adapters = await this.activeAdapters();
    const adapter = adapters.find((item) => item.id === providerId);
    if (!adapter) {
      throw new ProviderError('NOT_FOUND', `OmniHilbras has no active connection for ${providerId}. Connect it first, then test it.`, {
        providerId,
        publicMessage: `OmniHilbras has no active connection for ${providerId}. Connect it first, then test it.`,
      });
    }
    return this.probeAdapter(adapter, signal);
  }

  /** Live routing state for the dashboard. */
  async describeRouting() {
    const connections = await this.listConnections();
    return {
      failureThreshold: this.failureThreshold,
      connections: connections.map((connection) => ({
        connectionId: connection.id,
        providerId: connection.providerId,
        enabled: connection.enabled,
        hasCredential: connection.hasCredential,
        resilience: connection.resilience,
        ...(this.providerHealth.snapshot(connection.providerId, this.failureThreshold) ?? {}),
      })),
    };
  }

  /**
   * The health report, from the last sweep rather than a new one.
   *
   * This used to call `refreshHealth()` on every request, which probes **every** active
   * adapter — thirteen providers, around 8.5 seconds, each one a real request to somebody's
   * API. Two things were wrong with that. A dashboard that reloaded the page, or two tabs
   * open, multiplied the cost, and a status page is exactly the thing that gets polled.
   *
   * Worse, it was not just slow. The browser allows only six connections per origin, the page
   * asks for health on load, and a sweep that outlives the poll interval queued the next one
   * behind it — so health requests monopolised the pool and ordinary requests to the same
   * gateway queued behind them. A chat turn that answers in six seconds took over a minute,
   * which looked like the model hanging.
   *
   * A background sweep already runs every 60 seconds, so the freshest honest answer is almost
   * always at most that old. `checkedAt` is reported precisely so the caller can see the age
   * rather than being handed a report that implies it was just measured.
   */
  async health(signal?: AbortSignal): Promise<{ status: 'ok' | 'degraded'; checkedAt: string; providers: GatewayProviderHealth[] }> {
    if (this.lastHealth) return this.lastHealth;
    return this.refreshHealth(signal);
  }

  /**
   * Adapters that can actually serve traffic: registered ones plus an
   * OpenAI-compatible adapter per saved connection endpoint.
   */
  private async activeAdapters(): Promise<ProviderAdapter[]> {
    const connections = await this.listConnections();
    const adapters = new Map(this.registry.list().map((adapter) => [adapter.id, adapter]));
    // Cline has no static configuration, so it is only polled once a saved
    // connection with a credential exists.
    if (connections.some((connection) => connection.providerId === 'cline' && connection.hasCredential)) {
      adapters.set('cline', this.clineAdapter());
    }
    if (connections.some((connection) => connection.providerId === 'opencode' && connection.hasCredential)) {
      adapters.set('opencode', this.zenAdapter());
    }
    const consoleConnection = connections.find((connection) => connection.providerId === opencodeConsoleProviderId && connection.hasCredential);
    if (consoleConnection) {
      adapters.set(opencodeConsoleProviderId, this.opencodeConsoleAdapter(consoleConnection.id));
    }
    const kiroConnection = connections.find((connection) => connection.providerId === kiroProviderId && connection.hasCredential);
    if (kiroConnection) {
      adapters.set(kiroProviderId, this.kiroAdapter(kiroConnection.id));
    }
    const chatGptWebConnection = connections.find((connection) => connection.providerId === chatGptWebProviderId && connection.hasCredential);
    if (chatGptWebConnection) {
      adapters.set(chatGptWebProviderId, this.chatGptWebAdapter());
    }
    // DeepSeek Web needs the same treatment, and the omission was silent: without it the
    // connection fell through to a generic OpenAI-compatible adapter pointed at
    // chat.deepseek.com, which is not an OpenAI endpoint. Health then reported the provider as
    // `unavailable` with an empty message while routing worked perfectly — so "Test
    // provider" failed on a connection that could answer.
    const deepSeekWebConnection = connections.find((connection) => connection.providerId === deepseekWebProviderId && connection.hasCredential);
    if (deepSeekWebConnection) {
      adapters.set(deepseekWebProviderId, this.deepSeekAdapter());
    }
    for (const connection of connections) {
      if (adapters.has(connection.providerId)) continue;
      const cached = this.dynamicAdapters.get(connection.providerId);
      adapters.set(connection.providerId, cached && cached.endpoint === connection.endpoint
        ? cached.adapter
        : new OpenAICompatibleAdapter({ id: connection.providerId, name: connection.name, baseUrl: connection.endpoint }));
    }
    return [...adapters.values()];
  }

  async listAllModels(signal?: AbortSignal): Promise<GatewayModelList> {
    const connections = (await this.listConnections()).filter((connection) => connection.enabled && connection.hasCredential);
    if (connections.length > 0) {
      // Advertise the saved catalog so clients only see models this gateway
      // actually routes, instead of a provider's full paid inventory.
      return {
        models: connections.flatMap((connection) => connection.modelIds.map((id) => ({ id, providerId: connection.providerId } satisfies Model))),
        unavailable: [],
      };
    }

    const results = await Promise.all(this.registry.list().map(async (adapter) => {
      if (!adapter.listModels || adapter.capabilities.models !== true) return { providerId: adapter.id, models: [], unavailable: { providerId: adapter.id, code: 'NOT_SUPPORTED' } };
      try {
        const owner = await this.connectionFor(adapter.id);
        return { providerId: adapter.id, models: await adapter.listModels(await this.context(owner?.id ?? adapter.id, adapter.id, signal)), unavailable: undefined };
      } catch (error) {
        return { providerId: adapter.id, models: [], unavailable: { providerId: adapter.id, code: error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED' } };
      }
    }));
    return {
      models: results.flatMap((result) => result.models),
      unavailable: results.flatMap((result) => result.unavailable ? [result.unavailable] : []),
    };
  }

  /**
   * Resolves which provider should serve a model. An explicit request wins;
   * otherwise the saved connection catalog decides, so a plain OpenAI-compatible
   * client only needs a base URL, a key, and a model ID.
   */
  async resolveProviderId(model: string, explicitProviderId?: string) {
    if (explicitProviderId) return explicitProviderId;
    const modelId = model.trim();
    if (!modelId) return defaultProviderId;
    const connections = (await this.listConnections()).filter((connection) => connection.enabled && connection.hasCredential);
    const owners = [...new Set(connections.filter((connection) => connection.modelIds.includes(modelId)).map((connection) => connection.providerId))];
    if (owners.length === 1) return owners[0]!;
    if (owners.length > 1) {
      const chatCapable = (await this.activeAdapters()).find((adapter) => owners.includes(adapter.id) && adapter.capabilities.chat === true);
      return chatCapable?.id ?? owners[0]!;
    }
    if (connections.length === 1) return connections[0]!.providerId;
    return defaultProviderId;
  }

  async listModels(providerId: string, signal?: AbortSignal) {
    const adapter = this.requireAdapter(providerId);
    if (!adapter.listModels || adapter.capabilities.models !== true) throw notSupported(adapter, 'models');
    const owner = await this.connectionFor(providerId);
    return adapter.listModels(await this.context(owner?.id ?? adapter.id, adapter.id, signal));
  }

  async validateConnectionCredential(providerId: string, credential: ProviderCredential, signal?: AbortSignal): Promise<GatewayConnectionValidation> {
    return this.withProviderLock(providerId, () => this.validateConnectionCredentialUnlocked(providerId, credential, signal));
  }

  async saveConnection(input: ConnectionInput, credential: ProviderCredential, signal?: AbortSignal, options: { tolerateDiscoveryFailure?: boolean } = {}): Promise<ConnectionRecord> {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    // An unregistered provider is configuration for a custom endpoint, which is
    // validated when it is first used rather than at save time.
    this.registry.get(input.providerId);
    return this.withProviderLock(connectionMutationLock, async () => {
      // Not every provider can be probed without spending a request, so a
      // capability without a validator is saved without a pre-flight check.
      if (this.registry.get(input.providerId)?.validateCredential) {
        await this.validateConnectionCredentialUnlocked(input.providerId, credential, signal);
      } else if (input.providerId === 'cline') {
        // Cline is not in the registry; its adapter is resolved on demand.
        await (await this.resolveAdapter('cline')).validateCredential!(credential, signal ? { signal } : {});
      }
      let saveInput = input;
      if (input.modelPolicy) {
        // A sign-in that already came from the provider's own flow has proven the
        // credential, so a catalog that will not read is not a reason to throw the
        // session away. The connection is saved and the models arrive on the next read.
        const discovered = await this.discoverConnectionModels(input.providerId, credential, input.modelPolicy, signal, { endpoint: input.endpoint, name: input.name }).catch((error: unknown) => {
          if (!options.tolerateDiscoveryFailure) throw error;
          const said = error instanceof ProviderError ? providerSaid(error) : error instanceof Error ? error.message : undefined;
          this.lastDiscoveryNote = said;
          return [] as Model[];
        });
        const discoveredModelIds = discovered.map((model) => model.id);
        const existing = (await this.connectionStore!.list()).find((connection) => (input.id ? connection.id === input.id : connection.providerId === input.providerId));
        const customModelIds = input.customModelIds ?? existing?.customModelIds ?? [];
        const discoveredMeta = GatewayService.modelMetaFor(discovered);
        saveInput = {
          ...input,
          modelIds: [...discoveredModelIds, ...customModelIds],
          customModelIds,
          // Custom ids are the operator's own and carry no catalog metadata, so only the
          // discovered half is described here.
          ...(discoveredMeta ? { modelMeta: { ...(input.modelMeta ?? {}), ...discoveredMeta } } : {}),
        };
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

  /**
   * Completes a Cline sign-in: exchanges what the user pasted for tokens,
   * proves them against Cline, and only then stores the connection.
   */
  async connectCline(input: { code: string; callback?: string; redirectUri: string; name?: string; priority?: number }, signal?: AbortSignal): Promise<ConnectionRecord> {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    const tokens = await exchangeClineCode(input, this.transport, signal);
    const credential = toClineCredential(tokens);
    // `saveConnection` proves the token against Cline and imports the catalog
    // before anything reaches the vault, so nothing is stored on a bad sign-in.
    return this.saveConnection({
      id: 'cline',
      providerId: 'cline',
      name: input.name?.trim() || (tokens.email ? `Cline (${tokens.email})` : 'Cline'),
      endpoint: CLINE_OAUTH.apiBaseUrl,
      priority: input.priority ?? 1,
      proxyPool: 'none',
      modelPolicy: 'all',
    }, credential, signal);
  }

  /**
   * Re-reads a connection's catalog and stores the result.
   *
   * A connection can be saved with no models — a sign-in tolerates a catalog it could
   * not read, so an approved session is never thrown away — and a provider's catalog
   * changes over time. Without this, such a connection has no way back short of signing
   * in again, which for a device flow means a browser approval.
   */
  async refreshConnectionModels(connectionId: string, signal?: AbortSignal): Promise<ConnectionRecord> {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    const record = (await this.connectionStore.list()).find((item) => item.id === connectionId);
    if (!record) throw new ProviderError('NOT_FOUND', 'That connection no longer exists.', { providerId: connectionId });
    const credential = await this.secretStore.get(connectionId, record.providerId);
    const policy = record.modelPolicy ?? 'all';
    const discovered = await this.discoverConnectionModels(
      record.providerId,
      credential ?? { type: 'none' },
      policy,
      signal,
      { endpoint: record.endpoint, name: record.name },
    );
    // Custom models are the operator's own additions and survive a rescan.
    const merged = [...new Set([...discovered.map((model) => model.id), ...(record.customModelIds ?? [])])];
    // `replace`, not add: the provider is the authority on what it serves, and a union here
    // would keep a withdrawn model forever and file it as a custom addition besides.
    const updated = await this.connectionStore.updateModels(
      connectionId,
      merged,
      GatewayService.modelMetaFor(discovered),
      { replace: true },
    );
    if (!updated) throw new ProviderError('NOT_FOUND', 'That connection no longer exists.', { providerId: connectionId });
    return updated;
  }

  /**
   * Starts an OpenCode Console sign-in. This is a device flow: the Console hands back a
   * code the user types into its own page, so the dashboard shows the code and waits
   * rather than following a redirect.
   */
  async startOpencodeConsoleSignIn() {
    const started = await beginOpencodeConsoleSignIn();
    const session = this.opencodeConsoleSessions.create(started);
    return {
      sessionId: session.id,
      userCode: session.userCode,
      verificationUrl: session.verificationUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  /**
   * Reports whether the device sign-in finished, exchanging the code on the first poll
   * that finds it approved.
   *
   * The exchange is claimed before the Console is called, and a device code is
   * single-use: the poll that wins the claim receives the token, and the code is dead
   * from that moment. Without the claim a second poll arriving while the first is still
   * saving would spend the same code, be told `The device code is invalid`, and
   * overwrite a success that had already happened.
   */
  async opencodeConsoleSignInStatus(sessionId: string, signal?: AbortSignal): Promise<OpencodeConsoleSessionStatus | undefined> {
    const session = this.opencodeConsoleSessions.get(sessionId);
    if (!session) return undefined;
    if (session.status !== 'pending') return this.opencodeConsoleSessions.publicStatus(session);

    // Another poll owns the exchange. Report the session as it stands rather than
    // racing it, and let that poll publish the outcome.
    if (!this.opencodeConsoleSessions.claim(sessionId)) {
      return this.opencodeConsoleSessions.publicStatus(session);
    }

    const outcome = await pollOpencodeConsoleSignIn(session.deviceCode);
    if (outcome.status === 'pending') {
      // Nothing was spent, so the next poll may try again.
      this.opencodeConsoleSessions.release(session);
      return this.opencodeConsoleSessions.publicStatus(session);
    }
    if (outcome.status === 'denied') {
      this.opencodeConsoleSessions.resolve(session.id, { status: 'failed', error: outcome.error });
      return this.opencodeConsoleSessions.publicStatus(session);
    }
    try {
      // `orgName` only exists on the OAuth variant, so the union is narrowed rather
      // than read blind.
      const orgName = outcome.credential.type === 'oauth' ? outcome.credential.orgName : undefined;
      const connection = await this.saveConnection({
        id: opencodeConsoleProviderId,
        providerId: opencodeConsoleProviderId,
        name: `OpenCode Console${orgName ? ` (${orgName})` : ''}`,
        endpoint: 'https://opencode.ai/inference/openai/v1',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }, outcome.credential, signal, { tolerateDiscoveryFailure: true });
      const note = this.lastDiscoveryNote;
      this.lastDiscoveryNote = undefined;
      // The whole record, so the dashboard can render the page without a second fetch.
      this.opencodeConsoleSessions.resolve(session.id, {
        status: 'connected',
        connection,
        ...(note ? { error: `Connected, but the model list could not be read: ${note}` } : {}),
      });
    } catch (error) {
      // The transport's generic refusal hides the status and body that explain it,
      // so the provider's own words are preferred over `error.message`.
      const said = error instanceof ProviderError ? providerSaid(error) : undefined;
      const message = error instanceof ProviderError
        ? [error.publicMessage ?? error.message, said].filter(Boolean).join(' ')
        : error instanceof Error
          ? error.message
          : 'The sign-in could not be completed.';
      this.opencodeConsoleSessions.resolve(session.id, { status: 'failed', error: message });
    }
    return this.opencodeConsoleSessions.publicStatus(session);
  }

  /**
   * Starts a Cline sign-in and returns the URL to send the browser to. The
   * session id is how the dashboard learns the outcome; the `state` is what the
   * callback must echo back.
   */
  startClineSignIn(redirectUri: string) {
    // The session id goes in the redirect path, because the provider does not
    // echo `state` back and the path is the one part it must honour verbatim.
    // The same redirect is what gets sent to the token endpoint later.
    const { sessionId, state, redirectUri: callback } = this.clineSessions.start((id) => redirectUri.replace(/\/v1\/oauth\/cline\/callback\/?$/, clineCallbackPathFor(id)));
    return { ...this.beginClineAuthorization(callback, state), sessionId, state };
  }

  /**
   * Finishes a sign-in the browser delivered: exchanges the code, proves the
   * token against Cline, imports the catalog, then records the result on the
   * session so the dashboard can pick it up. The session is resolved either way,
   * so a failure is reported instead of leaving the dashboard waiting.
   */
  async completeClineSignIn(input: { sessionId?: string; state?: string; code: string; providerError?: string }, signal?: AbortSignal): Promise<{ ok: boolean; message: string; connection?: ConnectionRecord }> {
    if (!input.sessionId) {
      // Without a session there is nothing safe to correlate, so the code is not
      // exchanged. The paste box in the dashboard does not need a session.
      return { ok: false, message: 'This callback did not identify a sign-in, so nothing was saved. Use the paste box in OmniHilbras to finish connecting.' };
    }
    const session = this.clineSessions.claim(input.sessionId, input.state);
    if (!session) {
      return { ok: false, message: 'This sign-in has already been used or has expired. Start again from OmniHilbras.' };
    }
    if (input.providerError) {
      // The provider's error code comes back through the query string, so it is
      // reduced to a short token before it reaches a message.
      const code = input.providerError.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60);
      const message = `Cline reported ${code || 'an error'}.`;
      this.clineSessions.resolve(session.id, { status: 'failed', error: message });
      return { ok: false, message };
    }
    try {
      const connection = await this.connectCline({ code: input.code, redirectUri: session.redirectUri }, signal);
      // The whole record, so the dashboard can render the provider page from it
      // without a second fetch. It is metadata-only; the token stays in the vault.
      this.clineSessions.resolve(session.id, { status: 'connected', connection });
      return { ok: true, message: `Connected to ${connection.name} with ${connection.modelIds.length} models.`, connection };
    } catch (error) {
      // Prefer the provider's own words over a generic failure, so the operator
      // can see why Cline turned the sign-in away.
      const reason = error instanceof ProviderError ? providerSaid(error) : undefined;
      const message = error instanceof ProviderError
        ? [error.publicMessage ?? error.message, reason].filter(Boolean).join(' ')
        : 'The sign-in could not be completed.';
      this.clineSessions.resolve(session.id, { status: 'failed', error: message });
      return { ok: false, message };
    }
  }

  clineSignInStatus(sessionId: string) {
    return this.clineSessions.get(sessionId);
  }

  beginClineAuthorization(redirectUri: string, state?: string) {
    return beginClineAuthorization(redirectUri, state);
  }

  /** The Cline adapter, wired so a refreshed token is written back to the vault. */
  /**
   * OpenCode Zen serves one catalog through three wire formats, so the adapter
   * picks a lane per model. The generic on-demand adapter cannot, which is why
   * this provider is registered rather than resolved from its endpoint.
   */
  zenAdapter(): ProviderAdapter {
    if (!this.zen) this.zen = new ZenAdapter({ transport: this.transport });
    return this.zen;
  }

  /**
   * OpenCode Console is the credential that reaches the free Zen models, and it serves
   * the catalog from lanes the server names rather than one fixed base URL, so the
   * generic on-demand adapter cannot stand in for it.
   */
  /**
   * Kiro is CodeWhisperer's streaming service rather than an OpenAI-compatible endpoint,
   * so it needs its own adapter: a `conversationState` envelope in and an AWS eventstream
   * out.
   */
  /**
   * ChatGPT Web, which has no API to point an adapter at: the browser is the transport.
   *
   * The driver is created once and shared, so the Playwright import and the browser
   * availability check are not repeated per request.
   */
  chatGptWebAdapter(): ProviderAdapter {
    this.chatGptWeb ??= new ChatGptWebAdapter({ driver: this.options.chatGptWebDriver ?? createChatGptWebDriver() });
    return this.chatGptWeb;
  }

  /**
   * Stores an exported ChatGPT Web session.
   *
   * The pasted blob is parsed and filtered before anything is stored: only chatgpt.com and
   * openai.com cookies survive, so an export that happens to carry a session for another
   * site does not end up in this vault.
   */
  /**
   * Checks an export for real, and stores nothing.
   *
   * The connect route already refuses a bad session, but only after it has saved. So this is
   * the same verification done first: the session is parsed, then the adapter is asked to
   * validate it, which opens the page and confirms the account is actually signed in.
   *
   * **It launches a browser.** That is the cost of a button that says "check", and it is the
   * whole point — a parse alone accepts a dead token, so a "Check cookie" button that only
   * parsed would be a button that lies. What it costs is one page load, which the connect
   * immediately does again; what it saves is saving a connection that cannot answer.
   *
   * The model list is reported for every plan, because the plan narrows nothing: the page is
   * the authority on what the account gets, and a `planType` read out of an export is weaker
   * evidence than the page itself.
   */
  async checkChatGptWeb(exported: string, signal?: AbortSignal) {
    const state = parseChatGptStorageState(exported);
    const adapter = await this.resolveAdapter(chatGptWebProviderId, { endpoint: 'https://chatgpt.com', name: 'ChatGPT Web' });
    // Throws with the real cause — expired, challenged, signed out, no browser — so the
    // dialog says which of those it was instead of reporting a generic failure.
    await adapter.validateCredential?.(chatGptWebCredential(state), { signal });
    return {
      /** Absent when the export did not say, which is not the same as `free`. */
      planType: state.planType ?? null,
      isFreePlan: state.planType ? isFreeChatGptPlan(state.planType) : false,
      verified: true,
      models: chatGptWebModels(state.planType).map((model) => ({ id: model.id, name: model.name })),
    };
  }



  /**
   * The DeepSeek Web adapter, built once so its access-token cache is shared.
   *
   * Typed as the concrete class rather than `ProviderAdapter` on purpose: `validateCredential`
   * is optional on the interface, and both the sign-in and the paste path depend on it being
   * there. Narrowing the type makes the dependency a compile error instead of a runtime one.
   */
  deepSeekAdapter(): DeepSeekWebAdapter {
    this.deepSeek ??= new DeepSeekWebAdapter();
    return this.deepSeek;
  }



  /** Stores a DeepSeek Web userToken, after checking DeepSeek accepts it. */
  async connectDeepSeekWeb(userToken: string, signal?: AbortSignal) {
    const credential = deepSeekWebCredential(userToken);
    // Verified before the save, so a refused token never becomes a connection.
    await this.deepSeekAdapter().validateCredential(credential);
    return this.saveConnection(
      {
        id: deepseekWebProviderId,
        providerId: deepseekWebProviderId,
        name: 'DeepSeek Web',
        endpoint: 'https://chat.deepseek.com',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      },
      credential,
      signal,
    );
  }

  /**
   * Asks Qwen whether a credential works, and reports exactly what came back.
   *
   * A probe, not a connect, and deliberately so. The one question nobody can answer without a
   * signed-in account is whether Alibaba's bot-protection gate applies to an *authenticated*
   * request. Guessing either way is bad — claiming it works ships a card that cannot answer, and
   * refusing to try refuses on the strength of a measurement nobody made. So it asks, and it
   * returns the provider's own words.
   *
   * Nothing is stored. A probe that half-connects is worse than no probe: the user would believe
   * the credential is good and find out on their first request.
   */
  async checkQwenWeb(cookieHeader: string, signal?: AbortSignal) {
    return probeQwenWeb(cookieHeader, this.transport, signal);
  }

  async connectChatGptWeb(exported: string, signal?: AbortSignal, freeOnly = false) {
    const state = parseChatGptStorageState(exported);
    return this.saveConnection(
      {
        id: chatGptWebProviderId,
        providerId: chatGptWebProviderId,
        name: 'ChatGPT Web',
        endpoint: 'https://chatgpt.com',
        priority: 1,
        proxyPool: 'none',
        // Recorded on the connection, so the narrow import survives a model refresh instead of
        // quietly coming back in full.
        modelPolicy: freeOnly ? 'free' : 'all',
      },
      chatGptWebCredential(state),
      signal,
    );
  }

  kiroAdapter(connectionId: string): ProviderAdapter {
    if (!this.kiro) {
      this.kiro = new KiroAdapter({
        transport: this.transport,
        onTokensRefreshed: async (credential) => {
          if (!this.connectionStore) return;
          await this.connectionStore.set(connectionId, credential).catch(() => undefined);
        },
      });
    }
    return this.kiro;
  }

  /**
   * Starts a Kiro sign-in. AWS's device flow, so the user approves a code in their own
   * browser and the dashboard waits.
   */
  async startKiroSignInFlow(startUrl?: string) {
    return startKiroSignIn(this.kiroSessions, startUrl);
  }

  /**
   * Connects Kiro from a refresh token or a long-lived API key the user pasted.
   *
   * Both are stored through the same path as a sign-in, so the connection that results is
   * indistinguishable downstream from one built by the device flow.
   */
  async connectKiroFromCredential(
    credential: ProviderCredential,
    signal?: AbortSignal,
  ) {
    return this.saveConnection(
      {
        id: kiroProviderId,
        providerId: kiroProviderId,
        name: 'Kiro',
        endpoint: 'https://codewhisperer.us-east-1.amazonaws.com',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      },
      credential,
      signal,
    );
  }

  /** Spends a pasted refresh token once and stores the access token it returns. */
  async importKiroRefreshToken(refreshToken: string, signal?: AbortSignal) {
    return this.connectKiroFromCredential(await importKiroRefreshToken(refreshToken), signal);
  }

  /** Stores a pasted long-lived key. It cannot be renewed, so it is stored as given. */
  async connectKiroApiKey(apiKey: string, signal?: AbortSignal) {
    return this.connectKiroFromCredential(kiroCredentialFromApiKey(apiKey), signal);
  }

  /**
   * Starts a Google or GitHub sign-in.
   *
   * The returned URL redirects to a `kiro://` scheme that only the Kiro desktop app
   * handles, so the browser cannot come back here on its own. The user pastes the code
   * instead, and the exchange happens below.
   */
  async startKiroSocialSignInFlow(provider: 'google' | 'github') {
    return startKiroSocialSignIn(this.kiroSocial, provider);
  }

  /**
   * Completes a social sign-in with the code the user pasted.
   *
   * The code is spent at most once: a second attempt against the same session is refused
   * rather than sending an already-used code to Kiro.
   */
  async completeKiroSocialSignIn(sessionId: string, code: string, signal?: AbortSignal) {
    const session = this.kiroSocial.claim(sessionId);
    if (!session) {
      throw new ProviderError('INVALID_REQUEST', 'This sign-in has expired or was already completed. Start again.', {
        providerId: kiroProviderId,
        publicMessage: 'This sign-in has expired or was already completed. Start again.',
      });
    }
    try {
      const credential = await exchangeKiroSocialCode(session, code);
      return await this.connectKiroFromCredential(credential, signal);
    } catch (error) {
      // A failed exchange leaves the session usable, so a mistyped code can be retried.
      this.kiroSocial.release(sessionId);
      throw error;
    }
  }

  /**
   * Reports whether the Kiro sign-in finished, exchanging the device grant on the first
   * poll that finds it approved.
   */
  async kiroSignInStatus(sessionId: string, signal?: AbortSignal): Promise<KiroSignInStatus | undefined> {
    const session = this.kiroSessions.get(sessionId);
    if (!session) return undefined;
    const outcome = await pollKiroSignInWithClaim(this.kiroSessions, sessionId);
    if (outcome === 'in-progress') return this.kiroSessions.publicStatus(session);
    if (outcome.status !== 'connected') return this.kiroSessions.publicStatus(session);
    try {
      const connection = await this.saveConnection(
        {
          id: kiroProviderId,
          providerId: kiroProviderId,
          name: 'Kiro',
          endpoint: 'https://codewhisperer.us-east-1.amazonaws.com',
          priority: 1,
          proxyPool: 'none',
          modelPolicy: 'all',
        },
        outcome.credential,
        signal,
      );
      this.kiroSessions.resolve(sessionId, { status: 'connected', connection });
    } catch (error) {
      const said = error instanceof ProviderError ? providerSaid(error) : undefined;
      const message = error instanceof ProviderError
        ? [error.publicMessage ?? error.message, said].filter(Boolean).join(' ')
        : error instanceof Error
          ? error.message
          : 'The Kiro sign-in could not be completed.';
      this.kiroSessions.resolve(sessionId, { status: 'failed', error: message });
    }
    return this.kiroSessions.publicStatus(session);
  }

  opencodeConsoleAdapter(connectionId: string): ProviderAdapter {
    if (!this.opencodeConsole) {
      this.opencodeConsole = new OpencodeConsoleAdapter({
        transport: this.transport,
        // A renewal has to outlive the request that triggered it, or the next one
        // would present a token the Console has already replaced.
        onTokensRefreshed: async (credential) => {
          if (!this.connectionStore) return;
          await this.connectionStore.set(connectionId, credential).catch(() => undefined);
        },
      });
    }
    return this.opencodeConsole;
  }

  clineAdapter(): ProviderAdapter {
    if (!this.cline) {
      this.cline = createClineAdapter({
        transport: this.transport,
        onTokensRefreshed: async (tokens) => {
          await this.connectionStore?.set('cline', toClineCredential(tokens));
        },
      });
    }
    return this.cline;
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

  async updateConnectionResilience(connectionId: string, resilience: Partial<ResilienceSettings>) {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    return this.withProviderLock(connectionMutationLock, async () => {
      try {
        const connection = await this.connectionStore!.updateResilience(connectionId, resilience);
        if (!connection) throw new ProviderError('NOT_FOUND', 'The local connection was not found.');
        return connection;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (error instanceof ConnectionMetadataLimitError) throw new ProviderError('INVALID_REQUEST', error.message, { cause: error });
        throw new ProviderError('CONFIGURATION_ERROR', 'The connection settings could not be saved.', { cause: error });
      }
    });
  }

  /** The connection that serves a provider: the only one, or the first enabled. */
  private async connectionFor(providerId: string) {
    const matches = (await this.listConnections()).filter((connection) => connection.providerId === providerId && connection.hasCredential);
    return matches[0];
  }

  async chat(providerId: string, request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const adapter = await this.resolveAdapter(providerId);
    if (!adapter.chat || adapter.capabilities.chat !== true) throw notSupported(adapter, 'chat');
    const connection = await this.connectionFor(providerId);
    return adapter.chat(request, await this.context(connection?.id ?? adapter.id, adapter.id, signal));
  }

  async *streamChat(providerId: string, request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const adapter = await this.resolveAdapter(providerId);
    if (!adapter.streamChat || adapter.capabilities.streaming !== true) throw notSupported(adapter, 'streaming');
    const connection = await this.connectionFor(providerId);
    yield* adapter.streamChat(request, await this.context(connection?.id ?? adapter.id, adapter.id, signal));
  }

  /**
   * Serves one request across a failover chain: each candidate gets its own
   * retry budget, and a retryable failure moves on to the next connection.
   */
  async chatWithFailover(request: ChatRequest, explicitProviderId: string | undefined, signal?: AbortSignal): Promise<GatewayChatOutcome> {
    const decision = await this.planRoute(request.model, explicitProviderId);
    if (decision.candidates.length === 0) throw noRouteAvailable(decision.skipped);
    const attempts: GatewayFailoverAttempt[] = [];
    const race = await this.tryHedgedRace(decision.candidates, request, signal);
    if (race) {
      attempts.push(...race.attempts);
      if (race.response) return { response: race.response, attempts };
      // The race found no winner; continue down the normal chain.
    }
    const racedProviders = new Set(race?.attempts.filter((attempt) => !attempt.ok).map((attempt) => attempt.providerId));
    let lastError: unknown = race?.lastError;

    for (const candidate of decision.candidates) {
      if (racedProviders.has(candidate.providerId)) continue;
      for (let attempt = 1; attempt <= candidate.resilience.maxRetries + 1; attempt += 1) {
        if (signal?.aborted) throw new ProviderError('CANCELLED', 'The request was cancelled.', { cause: signal.reason });
        const startedAt = Date.now();
        try {
          this.enforceRateLimit(candidate);
          const response = await this.withDeadline(signal, candidate.resilience.timeoutMs, candidate.providerId, (deadline) => this.chat(candidate.providerId, request, deadline));
          const latencyMs = Date.now() - startedAt;
          this.providerHealth.recordSuccess(candidate.providerId, latencyMs);
          this.rateLimiter.record(candidate.connectionId);
          attempts.push({ providerId: candidate.providerId, attempt, ok: true, latencyMs });
          return { response, attempts };
        } catch (error) {
          const latencyMs = Date.now() - startedAt;
          const code = error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED';
          this.providerHealth.recordFailure(candidate.providerId, code, error instanceof Error ? error.message : 'The provider request failed.');
          attempts.push({ providerId: candidate.providerId, attempt, ok: false, latencyMs, errorCode: code });
          // A per-connection limit should hand off to the next route, not retry here.
          if (error instanceof ProviderError && error.code === 'RATE_LIMITED' && attempts.length > 1) break;
          if (!isRetryableFailure(error)) throw attachAttempts(error, attempts);
          lastError = error;
          if (signal?.aborted) break;
        }
      }
    }
    throw attachAttempts(lastError, attempts);
  }

  /**
   * Races the leading candidates when a hedge delay is configured. The first
   * successful reply wins and the losers are aborted, so the client waits for
   * the fastest route instead of the first-priority one. A hedge is only sent
   * while the leader is still in flight and another candidate can serve the
   * model, so a single connection never pays the extra cost.
   */
  private async tryHedgedRace(candidates: RouteCandidate[], request: ChatRequest, signal: AbortSignal | undefined) {
    const [leader, ...rest] = candidates;
    if (!leader || rest.length === 0 || leader.resilience.hedgeAfterMs <= 0) return undefined;

    type Outcome = { candidate: RouteCandidate; ok: boolean; latencyMs: number; response?: ChatResponse; error?: unknown };
    const attempts: GatewayFailoverAttempt[] = [];
    const inflight: Array<{ candidate: RouteCandidate; abort: () => void; done: Promise<Outcome>; startedAt: number }> = [];
    const settled = new Set<Promise<Outcome>>();
    const started = new Set<RouteCandidate>();
    let winner: Outcome | undefined;
    let lastError: unknown;
    let onChange: () => void = () => undefined;
    const resetChange = () => new Promise<void>((resolve) => { onChange = resolve; });

    const start = (candidate: RouteCandidate) => {
      started.add(candidate);
      const controller = new AbortController();
      const startedAt = Date.now();
      const done = this.withDeadline(signal, candidate.resilience.timeoutMs, candidate.providerId, (deadline) => this.chat(candidate.providerId, request, deadline))
        .then(
          (response): Outcome => ({ candidate, ok: true, latencyMs: Date.now() - startedAt, response }),
          (error: unknown): Outcome => ({ candidate, ok: false, latencyMs: Date.now() - startedAt, error }),
        )
        .then((outcome) => {
          settled.add(done);
          const code = outcome.ok ? undefined : outcome.error instanceof ProviderError ? outcome.error.code : 'PROVIDER_REQUEST_FAILED';
          if (outcome.ok) {
            this.providerHealth.recordSuccess(candidate.providerId, outcome.latencyMs);
            this.rateLimiter.record(candidate.connectionId);
          } else {
            this.providerHealth.recordFailure(candidate.providerId, code ?? 'PROVIDER_REQUEST_FAILED', outcome.error instanceof Error ? outcome.error.message : 'The provider request failed.');
          }
          attempts.push({ providerId: candidate.providerId, attempt: 1, ok: outcome.ok, latencyMs: outcome.latencyMs, ...(code ? { errorCode: code } : {}) });
          if (outcome.ok) {
            if (!winner) {
              winner = outcome;
              // A faster route answered: stop paying for the others. The
              // abandoned attempts are recorded now so the client can see that
              // a hedge was fired and won.
              for (const other of inflight) {
                if (other.candidate === candidate) continue;
                other.abort();
                if (!settled.has(other.done)) {
                  attempts.push({ providerId: other.candidate.providerId, attempt: 1, ok: false, latencyMs: Date.now() - other.startedAt, errorCode: 'CANCELLED' });
                }
              }
            }
          } else {
            lastError = outcome.error;
          }
          onChange();
          return outcome;
        });
      inflight.push({ candidate, done, startedAt, abort: () => controller.abort(new ProviderError('CANCELLED', 'A faster provider answered this request.')) });
      return done;
    };

    start(leader);
    let hedgePending = true;
    const hedgeTimer = setInterval(() => {
      if (winner || signal?.aborted) {
        clearInterval(hedgeTimer);
        hedgePending = false;
        return;
      }
      // Only hedge while the leader is still in flight.
      if (settled.size > 0) {
        clearInterval(hedgeTimer);
        hedgePending = false;
        return;
      }
      const next = rest.find((candidate) => !started.has(candidate));
      if (next) {
        start(next);
        onChange();
      } else {
        clearInterval(hedgeTimer);
        hedgePending = false;
      }
    }, leader.resilience.hedgeAfterMs);
    hedgeTimer.unref?.();

    // Wait for the first success, or until every candidate has been tried.
    while (!winner) {
      const running = inflight.filter((handle) => !settled.has(handle.done));
      if (running.length === 0) {
        if (hedgePending) {
          // The hedge timer decides whether another candidate is worth starting.
          await resetChange();
          continue;
        }
        break;
      }
      await resetChange();
    }
    clearInterval(hedgeTimer);
    if (winner) {
      // Return immediately: the losers were aborted and their own bookkeeping
      // continues in the background. Waiting for them would reintroduce the
      // leader's latency, which is exactly what hedging exists to avoid.
      return { response: winner.response!, attempts, lastError };
    }
    await Promise.allSettled(inflight.map((handle) => handle.done));
    return attempts.length === 0 ? undefined : { response: undefined, attempts, lastError };
  }

  /** Streaming cannot retry after bytes are sent, so failover only covers the first chunk. */
  async streamChatWithFailover(request: ChatRequest, explicitProviderId: string | undefined, signal?: AbortSignal): Promise<GatewayStreamOutcome> {
    const decision = await this.planRoute(request.model, explicitProviderId);
    if (decision.candidates.length === 0) throw noRouteAvailable(decision.skipped);
    const attempts: GatewayFailoverAttempt[] = [];
    let lastError: unknown;

    for (const candidate of decision.candidates) {
      const startedAt = Date.now();
      let opening: ChatChunk | undefined;
      let rest: AsyncIterator<ChatChunk> | undefined;
      try {
        this.enforceRateLimit(candidate);
        const opened = await this.withDeadline(signal, candidate.resilience.timeoutMs, candidate.providerId, async (deadline) => {
          const source = this.streamChat(candidate.providerId, request, deadline)[Symbol.asyncIterator]();
          const first = await source.next();
          if (first.done) throw new ProviderError('INVALID_RESPONSE', 'The provider stream ended before producing a chunk.');
          // The deadline has passed; the rest of the stream continues without it.
          const remainder = (async function* (): AsyncGenerator<ChatChunk> {
            while (true) {
              const next = await source.next();
              if (next.done) return;
              yield next.value;
            }
          })();
          return { first: first.value, remainder };
        });
        opening = opened.first;
        rest = opened.remainder[Symbol.asyncIterator]();
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'PROVIDER_REQUEST_FAILED';
        this.providerHealth.recordFailure(candidate.providerId, code, error instanceof Error ? error.message : 'The provider stream failed.');
        attempts.push({ providerId: candidate.providerId, attempt: 1, ok: false, latencyMs: Date.now() - startedAt, errorCode: code });
        lastError = error;
        if (!isRetryableFailure(error) || signal?.aborted) break;
        continue;
      }
      this.rateLimiter.record(candidate.connectionId);
      attempts.push({ providerId: candidate.providerId, attempt: 1, ok: true, latencyMs: Date.now() - startedAt });
      const settled = opening;
      return {
        attempts,
        chunks: (async function* (self: GatewayService) {
          if (settled) yield settled;
          try {
            while (true) {
              const next = await rest!.next();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            self.providerHealth.recordSuccess(candidate.providerId, Date.now() - startedAt);
          }
        })(this),
      };
    }
    throw attachAttempts(lastError, attempts);
  }

  private async planRoute(model: string, explicitProviderId?: string) {
    const connections = await this.listConnections();
    const decision = resolveRoute({
      connections,
      model,
      ...(explicitProviderId === undefined ? {} : { explicitProviderId }),
      health: this.providerHealth,
      failureThreshold: this.failureThreshold,
      rateLimitWaitMs: this.rateLimitWaitMs,
    });
    if (decision.candidates.length > 0) return decision;
    // Without connection metadata there is nothing to route on, so an embedded
    // service still serves the requested provider directly.
    if (connections.length === 0) {
      const providerId = explicitProviderId ?? defaultProviderId;
      this.requireAdapter(providerId);
      return { ...decision, candidates: [{ providerId, connectionId: `unmanaged:${providerId}`, priority: 0, resilience: { ...defaultResilienceSettings } }] };
    }
    return decision;
  }

  private enforceRateLimit(candidate: RouteCandidate) {
    const waitMs = this.rateLimiter.check(candidate.connectionId, candidate.resilience.requestsPerMinute);
    this.rateLimitWaitMs.set(candidate.connectionId, waitMs);
    if (waitMs > 0) {
      throw new ProviderError('RATE_LIMITED', `This connection reached its limit of ${candidate.resilience.requestsPerMinute} requests per minute.`, {
        providerId: candidate.providerId,
        retryable: true,
      });
    }
  }

  /**
   * Applies a per-connection deadline without leaking timers: the timeout aborts
   * the provider call, and the timer is always released once the call settles.
   */
  private async withDeadline<T>(signal: AbortSignal | undefined, timeoutMs: number, providerId: string, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
    if (timeoutMs <= 0) return run(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The deadline is enforced here rather than trusted to the adapter, so a
    // provider that ignores the abort signal still cannot hang the request.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderError('PROVIDER_TIMEOUT', `The provider did not respond within ${timeoutMs} ms.`, { providerId, retryable: true }));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([run(controller.signal), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Reads a provider's catalog. Returns the full records, not just ids, because the
   * prices, context windows and modalities a catalog states are the only source for the
   * dashboard's model filters, and asking the provider a second time to get them would
   * mean a request per page load.
   */
  private async discoverConnectionModels(providerId: string, credential: ProviderCredential, policy: ModelImportPolicy, signal?: AbortSignal, pendingEndpoint?: { endpoint: string; name: string }) {
    const adapter = await this.resolveAdapter(providerId, pendingEndpoint);
    // The policy is passed here as well as to `discoverModels`, because a provider that
    // narrows its own list reads it off the context. Without it a free-only import is
    // correct on connect and silently comes back in full on the next refresh.
    const context: ProviderRequestContext = { credential, importPolicy: policy, ...(signal ? { signal } : {}) };
    /**
     * Both paths are open for either policy.
     *
     * The policy travels in the context, so an adapter whose `listModels` narrows by it does
     * so, and one that ignores it returns its full list — which is the documented meaning of
     * a `free` policy on a provider that cannot narrow. Gating this branch on
     * `policy === 'all'` looked stricter and was worse: it made a free-only connection
     * **unrefreshable**, so the toggle could create a connection that broke the next time
     * anybody asked the provider what it serves.
     */
    const models = adapter.discoverModels
      ? await adapter.discoverModels(context, { policy })
      : adapter.listModels && adapter.capabilities.models === true
        ? await adapter.listModels(context)
        : undefined;
    if (!models) throw notSupported(adapter, policy === 'free' ? 'free model discovery' : 'model discovery');
    return models;
  }

  /**
   * Reduces catalog records to the compact form stored alongside the ids. A model the
   * provider described only as an id yields no entry at all, so the dashboard can tell
   * "nothing was stated" from "stated as zero".
   */
  private static modelMetaFor(models: readonly Model[]): ModelMetaMap | undefined {
    const meta: ModelMetaMap = {};
    for (const model of models) {
      const prices = modelMetaPriceOrder
        .map((key) => model.pricing?.[key])
        .filter((value): value is number => typeof value === 'number');
      const entry: ModelMeta = {
        ...(model.displayName ? { n: model.displayName } : {}),
        ...(model.contextWindow ? { c: model.contextWindow } : {}),
        ...(model.inputModalities?.length ? { i: [...model.inputModalities] } : {}),
        ...(model.outputModalities?.length ? { o: [...model.outputModalities] } : {}),
        ...(prices.length ? { p: prices } : {}),
      };
      if (Object.keys(entry).length > 0) meta[model.id] = entry;
    }
    return Object.keys(meta).length > 0 ? meta : undefined;
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

  /**
   * Resolves the adapter for a provider, building one on demand for a saved
   * connection that has no registered adapter. That is what lets any
   * OpenAI-compatible endpoint added through the dashboard serve traffic, using
   * the same transport and credential vault as the built-in adapters.
   */
  private async resolveAdapter(providerId: string, pendingEndpoint?: { endpoint: string; name: string }): Promise<ProviderAdapter> {
    if (providerId === 'cline') return this.clineAdapter();
    if (providerId === 'opencode') return this.zenAdapter();
    if (providerId === opencodeConsoleProviderId) return this.opencodeConsoleAdapter(providerId);
    if (providerId === kiroProviderId) return this.kiroAdapter(providerId);
    if (providerId === chatGptWebProviderId) return this.chatGptWebAdapter();
    if (providerId === deepseekWebProviderId) return this.deepSeekAdapter();
    const registered = this.registry.get(providerId);
    if (registered) return registered;
    // A connection being saved is not in the store yet, so the caller can pass
    // the endpoint it is about to use.
    const connection = (await this.listConnections()).find((item) => item.providerId === providerId);
    const endpoint = pendingEndpoint ?? (connection ? { endpoint: connection.endpoint, name: connection.name } : undefined);
    if (!endpoint) return this.registry.require(providerId);
    const cached = this.dynamicAdapters.get(providerId);
    if (cached && cached.endpoint === endpoint.endpoint) return cached.adapter;
    const adapter = new OpenAICompatibleAdapter({ id: providerId, name: endpoint.name, baseUrl: endpoint.endpoint });
    this.dynamicAdapters.set(providerId, { endpoint: endpoint.endpoint, adapter });
    return adapter;
  }

  /**
   * The credential belongs to a connection, not to a provider: one provider can
   * hold several. The provider id is still passed so an environment credential
   * keeps resolving.
   */
  private async context(connectionId: string, providerId: string, signal?: AbortSignal): Promise<ProviderRequestContext> {
    const [credential, policy] = await Promise.all([
      this.secretStore.get(connectionId, providerId),
      // The connection's own model policy, so a provider that narrows its list does it the
      // same way on a manual refresh as on a connect, and a `free` import does not come back
      // in full. A store without `list` simply has no policy to honour.
      this.connectionStore?.list().then((all) => all.find((entry) => entry.id === connectionId)?.modelPolicy),
    ]);
    return {
      credential,
      ...(policy ? { importPolicy: policy } : {}),
      ...(signal ? { signal } : {}),
    };
  }
}

function notSupported(adapter: ProviderAdapter, capability: string) {
  const message = `${adapter.name} does not support ${capability}.`;
  return new ProviderError('NOT_SUPPORTED', message, { providerId: adapter.id, publicMessage: message });
}
