import { CLINE_OAUTH, ChatGptWebAdapter, FetchHttpTransport, KIMI_CODE, KimiCodeAdapter, KiroAdapter, chatGptWebCredential, chatGptWebModels, isFreeChatGptPlan, parseChatGptStorageState, chatGptWebProviderId, deepSeekWebCredential, deepseekWebProviderId, DeepSeekWebAdapter, probeQwenWeb, OpencodeConsoleAdapter, ProviderError, ZenAdapter, exchangeKiroSocialCode, kiroCredentialFromApiKey, kiroProviderId, type ChatChunk, type ChatRequest, type ChatResponse, type EmbeddingRequest, type EmbeddingResponse, type HttpTransport, type Model, type ModelImportPolicy, type ProviderAdapter, type ProviderCredential, type ProviderHealth, type ChatGptWebDriver, type ProviderRegistry, type ProviderRequestContext , type ModelPricing } from '@hilbras/omnihilbras';
import type { ApiKeyRecord, ApiKeyStore } from './api-keys.js';
import { type ConnectionInput, type ConnectionRecord, type ConnectionStore, type ResilienceSettings } from './connections.js';
import type { GatewayConfig } from './config.js';
import { ClineSessionStore, beginClineAuthorization, clineCallbackPathFor, createClineAdapter, exchangeClineCode, providerSaid, toClineCredential } from './oauth.js';
import { KimiCodeSessionStore, kimiCodeProviderId, type KimiCodeSessionStatus } from './kimiCode.js';
import { OpencodeConsoleSessionStore, beginOpencodeConsoleSignIn, opencodeConsoleProviderId, pollOpencodeConsoleSignIn, type OpencodeConsoleSessionStatus } from './opencodeConsole.js';
import { KiroSessionStore, KiroSocialStore, importKiroRefreshToken, pollKiroSignInWithClaim, startKiroSignIn, startKiroSocialSignIn, type KiroSignInStatus } from './kiro.js';
import { createChatGptWebDriver } from './chatgptWeb.js';
import { SlidingWindowRateLimiter, type RouteCandidate } from './routing.js';
import { HealthManager } from './health.js';
import { ProviderResolver } from './provider-resolver.js';
import { completeSignIn, describeSignInFailure } from './sign-in-coordinator.js';
import { CredentialManager } from './credential-manager.js';
import { CredentialLifecycle } from './credential-lifecycle.js';
import { localDeployment, type ConnectionSecretStore, type DeploymentConfig } from './runtime.js';
import { RoutingEngine } from './routing-engine.js';
import { ModelCatalog } from './model-catalog.js';
import { TimeoutPolicy } from './timeout-policy.js';
import { startRequestScope, type RequestScope } from './request-context.js';
import { notSupported } from './capability.js';
import { RequestExecutor, type GatewayChatOutcome, type GatewayEmbedOutcome, type GatewayStreamOutcome } from './request-executor.js';
import { ConnectionManager } from './connection-manager.js';
import { ApiKeyManager } from './api-key-manager.js';
import type { UsageStore } from './usage-store.js';
import { modelMetaPriceOrder } from './connections.js';

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
const defaultProviderId = 'openai';
/** Consecutive failures before routing stops sending traffic to a connection. */
/** How often background health polling runs. 0 disables it. */

/**
 * The attempt ledger and the outcomes the failover path returns.
 *
 * Re-exported rather than moved: the types now live with the loop that produces them, but every
 * existing importer of `service.js` keeps working without learning a second path for the same type.
 */
export type { GatewayFailoverAttempt, GatewayChatOutcome, GatewayStreamOutcome, GatewayEmbedOutcome } from './request-executor.js';

/**
 * The credential surface the service needs, keyed by connection id.
 *
 * Now an alias for the named `SecretStore` rather than a `Pick` of the local connection store. The
 * `Pick` admitted only an implementation of *that* store and described its origin rather than its
 * purpose, so "could this be remote" had to be answered by reading the constructor.
 */
export type CredentialSource = ConnectionSecretStore;

export type GatewayServiceOptions = {
  /**
   * The gateway's own configuration.
   *
   * **Required when the service is constructed directly**, which every test does and only `createGatewayService`
   * does not. Optional because the alternative is a `GatewayConfig` default built here, and that would mean
   * `service.ts` importing `config.ts` — which already imports `service.ts`, for `deploymentFrom`. The cycle
   * would be invisible in TypeScript (type-only on one side) and a real hazard at module-init on the other.
   *
   * So: required here, supplied by the one factory that reads the environment.
   */
  config?: GatewayConfig;
  /**
   * Where per-request records go. **Optional, and absent by default.**
   *
   * A caller that wants usage passes a store; a caller that does not, gets nothing written. That is
   * deliberate: a default store would mean every existing test and every embedding silently started
   * accumulating records, and "records nothing" would stop being a state anyone chose.
   */
  usageStore?: UsageStore;
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

export class GatewayService {
  private readonly connectionLocks = new Map<string, Promise<void>>();
  /** Absent means the gateway records nothing; see `GatewayServiceOptions.usageStore`. */
  private readonly usageStore?: UsageStore;
  private readonly gatewayConfig: GatewayConfig | undefined;
  private readonly transport: HttpTransport;
  private cline?: ProviderAdapter;
  private zen?: ProviderAdapter;
  private opencodeConsole?: ProviderAdapter;
  private readonly opencodeConsoleSessions = new OpencodeConsoleSessionStore();
  private readonly kimiCodeSessions = new KimiCodeSessionStore();
  /** Built on demand, so signing in is what constructs it. */
  private kimiCode?: KimiCodeAdapter;
  private readonly kiroSessions = new KiroSessionStore();
  private readonly kiroSocial = new KiroSocialStore();
  private chatGptWeb?: ProviderAdapter;
  /** DeepSeek Web, built once so its access-token cache is shared across requests. */
  private deepSeek?: DeepSeekWebAdapter;
  private kiro?: ProviderAdapter;
  /** Why the last model discovery failed, when it was tolerated rather than fatal. */
  private lastDiscoveryNote?: string;
  private readonly clineSessions = new ClineSessionStore();
  /** API keys, extracted so key policy can be tested without a service around it. */
  private readonly apiKeys: ApiKeyManager;
  /**
   * Provider resolution, so the algorithm that picks an adapter knows no provider's name.
   *
   * The registrations are in the constructor. A provider still names itself once, in one place,
   * which is the step short of "a provider adds itself" — and that step is worth taking
   * separately rather than pretending this is already it.
   */
  private readonly providers: ProviderResolver;
  /**
   * The failover chain. Holds the order, the retry counting and the attempt ledger; every effect
   * it performs is one of this service's methods, passed in above.
   */
  private readonly requests: RequestExecutor;
  /**
   * The credential surface a request is made with, and which connection serves a provider.
   *
   * Five call sites used to answer that second question themselves, with the local variable named
   * differently at each. The provider-id-versus-connection-id mix-up this seam is prone to had
   * already happened one layer up, in the adapter factories.
   */
  private readonly credentials: CredentialManager;
  /**
   * Whether a stored credential is still usable, answered without asking the provider.
   *
   * The saving is concrete rather than architectural: a ChatGPT Web health check launches a
   * browser, and a session that ended an hour ago was launching one on every sweep to be told what
   * the credential already said in writing.
   */
  private readonly credentialLifecycle: CredentialLifecycle;
  /**
   * Which routes a request may take, given the current health and limits.
   *
   * The algorithm was already in `routing.ts`; the inputs it needed were scattered across this
   * class, so a routing change looked like a service change.
   */
  private readonly routing: RoutingEngine;
  /**
   * What this gateway serves, and which provider serves what.
   *
   * Four provider-neutral jobs that were scattered through this class: the list a client sees, the
   * list one provider offers, which provider a model id belongs to, and what a provider will
   * actually serve when asked.
   */
  private readonly models: ModelCatalog;
  /**
   * What a timeout value means, and the deadline that enforces it.
   *
   * "0 means no deadline" was decided in two files — here and in `connections.ts` — which is how
   * the default came to be 0 while the code claimed a provider could never hold a request open.
   */
  private readonly timeouts: TimeoutPolicy;
  /**
   * Storing and changing connections, with one error mapper and one catalog-merge policy.
   *
   * `canValidate` is what removed the Core's last reason to know a provider's name: it used to be
   * `if (this.registry.get(id)?.validateCredential) … else if (id === 'cline') …`, because Cline is
   * not in the registry and its adapter is built on demand. Asking the resolver instead means a
   * second on-demand provider needs no edit here.
   */
  private readonly connections: ConnectionManager;
  private readonly rateLimiter: SlidingWindowRateLimiter;
  /**
   * The outer runtime, as named. Carried rather than threaded per call, because a tenant is a
   * property of a *deployment* and a public base URL is a property of the machine — and a gateway
   * that read them out of module-level state could not be told otherwise.
   */
  private readonly deploymentConfig: DeploymentConfig;
  /**
   * Health, extracted so it can be tested without routing.
   *
   * The manager is given two questions and nothing else — which adapters exist, and what context
   * to ask one in — so it has no knowledge of connections, OAuth or model discovery. The public
   * methods below are kept so callers and the HTTP layer are unchanged.
   */
  private readonly healthManager: HealthManager;
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
    /**
     * The outer runtime. Optional, with a local default, because the overwhelming majority of
     * callers are embedded or single-user and must not be asked to think about any of it — which is
     * what keeps a cloud boundary from becoming a tax on the local case it is meant to be optional
     * for.
     */
    deployment: DeploymentConfig = localDeployment(),
  ) {
    this.deploymentConfig = deployment;
    this.usageStore = options.usageStore;
    this.gatewayConfig = options.config;
    // Kept, not just read: the ChatGPT Web driver is built lazily on first use, long after
    // the constructor has returned, so the override has to outlive this call.
    this.options = options;
    this.transport = options.transport ?? new FetchHttpTransport();
    const now = options.now ?? (() => Date.now());
    this.rateLimiter = new SlidingWindowRateLimiter(now);
    this.apiKeys = new ApiKeyManager(this.apiKeyStore);
    this.connections = new ConnectionManager(this.connectionStore, {
      lock: (operation) => this.withProviderLock(connectionMutationLock, operation),
      canValidate: (providerId) => this.providers.canValidateCredential(providerId),
      validate: async (providerId, credential, signal) => { await this.validateConnectionCredentialUnlocked(providerId, credential, signal); },
      discover: ({ providerId, credential, policy, signal, pendingEndpoint }) =>
        this.discoverConnectionModels(providerId, credential, policy, signal, pendingEndpoint),
      readCredential: (connectionId, providerId) => this.secretStore.get(connectionId, providerId),
      noteDiscoveryFailure: (error) => { this.lastDiscoveryNote = error instanceof ProviderError ? providerSaid(error) : error instanceof Error ? error.message : undefined; },
    });
    this.credentials = new CredentialManager(this.secretStore, this.connections);
    this.routing = new RoutingEngine({
      health: { getFailureThreshold: () => this.healthManager.getFailureThreshold(), registry: () => this.healthManager.snapshotRegistry() },
      rateLimiter: this.rateLimiter,
      defaultProviderId,
      requireAdapter: (providerId) => { this.requireAdapter(providerId); },
    });
    this.models = new ModelCatalog({
      connections: this.connections,
      credentials: this.credentials,
      resolveAdapter: (providerId, pendingEndpoint) => this.resolveAdapter(providerId, pendingEndpoint),
      activeAdapters: () => this.activeAdapters(),
      defaultProviderId,
    });
    this.timeouts = new TimeoutPolicy();
    this.requests = new RequestExecutor({
      planRoute: (model, explicitProviderId) => this.planRoute(model, explicitProviderId),
      chat: (providerId, request, signal, scope) => this.chat(providerId, request, signal, scope),
      streamChat: (providerId, request, signal, scope) => this.streamChat(providerId, request, signal, scope),
      embed: (providerId, request, signal, scope) => this.embed(providerId, request, signal, scope),
      withDeadline: (signal, timeoutMs, providerId, run) => this.withDeadline(signal, timeoutMs, providerId, run),
      enforceRateLimit: (candidate) => this.enforceRateLimit(candidate),
      recordSuccess: (providerId, latencyMs, at) => this.healthManager.recordSuccess(providerId, latencyMs, at),
      recordFailure: (providerId, code, reason) => this.healthManager.recordFailure(providerId, code, reason),
      recordRateLimitUse: (connectionId) => this.rateLimiter.record(connectionId),
    });
    this.providers = new ProviderResolver(registry)
      .onDemand('cline', () => this.clineAdapter(), { validateOnSave: true })
      .onDemand('opencode', () => this.zenAdapter())
      .onDemand(opencodeConsoleProviderId, ({ providerId, connection }) => this.opencodeConsoleAdapter(connection?.id ?? providerId))
      .onDemand(kimiCodeProviderId, ({ providerId, connection }) => this.kimiCodeAdapter(connection?.id ?? providerId))
      .onDemand(kiroProviderId, ({ providerId, connection }) => this.kiroAdapter(connection?.id ?? providerId))
      .onDemand(chatGptWebProviderId, () => this.chatGptWebAdapter())
      .onDemand(deepseekWebProviderId, () => this.deepSeekAdapter());
    this.credentialLifecycle = new CredentialLifecycle({
      adapterFor: (providerId) => { try { return this.registry.get(providerId); } catch { return undefined; } },
      now,
    });
    this.healthManager = new HealthManager(
      {
        adapters: () => this.activeAdapters(),
        contextFor: (adapterId, signal) => this.contextForAdapter(adapterId, signal),
        // The third question the health probe can ask, and the only one that costs nothing. Asked
        // before the adapter's own check so an expired session is not discovered by launching a
        // browser to be told what the credential already said.
        credentialStanding: async (adapterId) => {
          const context = await this.contextForAdapter(adapterId);
          return this.credentialLifecycle.standing(adapterId, context.credential);
        },
      },
      {
        now,
        ...(options.recoveryCooldownMs === undefined ? {} : { recoveryCooldownMs: options.recoveryCooldownMs }),
        ...(options.failureThreshold === undefined ? {} : { failureThreshold: options.failureThreshold }),
      },
    );
  }

  /**
   * The ejection registry, for `resolveRoute`.
   *
   * Routing needs to *read* failure counts to decide who is ejected, and it should not need to
   * know that the counters live inside the health manager. Exposing the registry rather than the
   * counters keeps `resolveRoute`'s signature — which is provider-agnostic and well tested —
   * unchanged, while the health concern still has exactly one owner.
   */


  /** How often background health polling runs. 0 keeps polling off. */
  setHealthInterval(intervalMs: number) {
    this.healthManager.setInterval(intervalMs);
  }

  /** Starts background health polling so routing reflects reality without a request. */
  startHealthMonitor(intervalMs?: number) {
    this.healthManager.start(intervalMs);
  }

  stopHealthMonitor() {
    this.healthManager.stop();
  }

  /**
   * Releases everything this service holds, in the order that makes the release safe.
   *
   * Two resources, and the order is the point. The health monitor polls adapters, so it is stopped
   * first — otherwise it can enqueue work while the drain is running. The API key store is drained
   * second, because `authenticate` records `lastUsedAt` with a bare `void` (authentication is on
   * every request, and awaiting a disk write there is a real cost) and that leaves a write in
   * flight when `authenticate` resolves. Draining is what makes "the disk has caught up" a fact
   * rather than a hope, so whatever calls this can exit knowing nothing is lost.
   *
   * **Call this after the HTTP server has stopped accepting.** The store's drain loops until its
   * queue stops advancing, which terminates on an idle queue and does not terminate on a busy one.
   */
  async close(): Promise<void> {
    this.stopHealthMonitor();
    await this.apiKeyStore?.close?.();
  }

  /**
   * Polls every configured adapter and folds the result into routing state.
   *
   * Delegates. The caching, the shared in-flight sweep, and the reason-carrying failures all live
   * in `HealthManager` now, where they can be tested without a routing decision in the way.
   */
  refreshHealth(signal?: AbortSignal) {
    return this.healthManager.refresh(signal);
  }

  /** Health for a single provider, without the cost of the whole sweep. */
  healthForProvider(providerId: string, signal?: AbortSignal) {
    return this.healthManager.forProvider(providerId, signal);
  }

  /** The health report, from the last sweep rather than a new one. */
  health(signal?: AbortSignal) {
    return this.healthManager.report(signal);
  }

  /**
   * Live routing state for the dashboard.
   *
   * The wait is included because `RateLimitPolicy` records it *for* this report — its own comment
   * says the wait is held so a cooling-down connection cannot look ready — and nothing read it. A
   * connection over its per-minute limit was skipped by routing with reason `rate-limited` and
   * reported here as an ordinary eligible connection, so the page told an operator "routing can
   * choose this" about a connection routing was refusing. The promise was in the code; the value
   * never reached a caller.
   *
   * Absent when never checked, `0` when checked and not waiting. Collapsing those two is how a
   * connection that has never been asked about its limit looks identical to one that is free.
   */
  async describeRouting() {
    const connections = await this.listConnections();
    const waits = this.routing.waits();
    return {
      failureThreshold: this.healthManager.getFailureThreshold(),
      connections: connections.map((connection) => ({
        connectionId: connection.id,
        providerId: connection.providerId,
        enabled: connection.enabled,
        hasCredential: connection.hasCredential,
        resilience: connection.resilience,
        ...(waits.has(connection.id) ? { rateLimitWaitMs: waits.get(connection.id) } : {}),
        ...(this.healthManager.snapshot(connection.providerId) ?? {}),
      })),
    };
  }

  /**
   * Adapters that can actually serve traffic: registered ones plus an
   * OpenAI-compatible adapter per saved connection endpoint.
   */
  /**
   * Every adapter worth probing, registered plus on-demand.
   *
   * The on-demand half is `ProviderResolver.active()`: a provider with no static configuration is
   * only polled once it has a credential, because probing without one spends a request that cannot
   * succeed. That used to be six hand-written branches, and two of them passed the connection id
   * while the resolution path passed the provider id to the same factory.
   */
  private async activeAdapters(): Promise<ProviderAdapter[]> {
    const connections = await this.listConnections();
    return [...this.registry.list(), ...(await this.providers.active(connections))];
  }


  async listAllModels(signal?: AbortSignal): Promise<GatewayModelList> {
    return this.models.listAll(signal);
  }


  /**
   * Resolves which provider should serve a model. An explicit request wins;
   * otherwise the saved connection catalog decides, so a plain OpenAI-compatible
   * client only needs a base URL, a key, and a model ID.
   */
  async resolveProviderId(model: string, explicitProviderId?: string) {
    return this.models.resolveProviderId(model, explicitProviderId);
  }


  async listModels(providerId: string, signal?: AbortSignal) {
    return this.models.listForProvider(providerId, this.requireAdapter(providerId), signal);
  }


  async validateConnectionCredential(providerId: string, credential: ProviderCredential, signal?: AbortSignal): Promise<GatewayConnectionValidation> {
    return this.withProviderLock(providerId, () => this.validateConnectionCredentialUnlocked(providerId, credential, signal));
  }

  /**
   * Stores a connection, after proving its credential.
   *
   * The store, the mutation lock, the catalog merge and the error mapping live in
   * `ConnectionManager`. What stays here is the provider-facing half — proving a credential and
   * reading a catalog — because both need the registry and the resolver.
   */
  async saveConnection(input: ConnectionInput, credential: ProviderCredential, signal?: AbortSignal, options: { tolerateDiscoveryFailure?: boolean } = {}): Promise<ConnectionRecord> {
    return this.connections.save(input, credential, signal, options);
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
    return this.connections.refreshModels(connectionId, signal);
  }


  /**
   * Starts an OpenCode Console sign-in. This is a device flow: the Console hands back a
   * code the user types into its own page, so the dashboard shows the code and waits
   * rather than following a redirect.
   */
  /**
   * Starts a Kimi Code sign-in. A device flow, so the user approves a code in their own browser and
   * the dashboard polls — nothing is redirected back to us.
   */
  async startKimiCodeSignIn() {
    // **The registered adapter, not a fresh one.** A `new KimiCodeAdapter` here would build its own
    // `FetchHttpTransport` and reach the real Kimi even when the gateway was constructed with a
    // scripted transport — so a test of this flow made a live network call, and a caller who supplied
    // their own transport silently had it ignored for the sign-in. The adapter is memoised per
    // connection, which is exactly the lifetime this needs.
    const started = await this.kimiCodeAdapter(kimiCodeProviderId).beginSignIn();
    const session = this.kimiCodeSessions.create(started);
    return {
      sessionId: session.id,
      userCode: session.userCode,
      verificationUrl: session.verificationUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  /**
   * Reports whether the Kimi Code sign-in finished, spending the device code on the first poll that
   * finds it approved.
   *
   * Routed through `completeSignIn`, which claims the session *before* the exchange. A device code is
   * single-use, so two concurrent polls would otherwise spend it twice, the second be told the code is
   * invalid, and a success that already happened be overwritten with a failure.
   */
  kimiCodeSignInStatus(sessionId: string, signal?: AbortSignal): Promise<KimiCodeSessionStatus | undefined> {
    return completeSignIn({
      sessions: this.kimiCodeSessions,
      sessionId,
      signal,
      fallback: 'The Kimi Code sign-in could not be completed.',
      poll: async () => {
        const session = this.kimiCodeSessions.get(sessionId);
        if (!session) return { status: 'denied', error: 'This sign-in no longer exists.' };
        const outcome = await this.kimiCodeAdapter(sessionId).pollSignIn(session.deviceCode, signal, session.deviceId);
        if (outcome.status === 'pending') return { status: 'pending' };
        if (outcome.status === 'denied') return { status: 'denied', error: outcome.error };
        return { status: 'connected', credential: outcome.credential };
      },
      takeDiscoveryNote: () => {
        const note = this.lastDiscoveryNote;
        this.lastDiscoveryNote = undefined;
        return note;
      },
      connection: () => ({
        id: kimiCodeProviderId,
        providerId: kimiCodeProviderId,
        name: 'Kimi Code',
        // The endpoint is fixed by the adapter, so it is recorded for display rather than read back —
        // an operator needs to see which host this connection talks to.
        endpoint: KIMI_CODE.server,
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }),
      save: (input, credential, pollSignal) => this.saveConnection(input, credential, pollSignal),
    });
  }

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
  /**
   * Polls an OpenCode Console sign-in to its conclusion.
   *
   * The order — claim, poll, save, then publish — is in `completeSignIn`, because getting it wrong
   * spends an OAuth grant twice or reports a connection that does not exist.
   */
  async opencodeConsoleSignInStatus(sessionId: string, signal?: AbortSignal): Promise<OpencodeConsoleSessionStatus | undefined> {
    return completeSignIn({
      sessions: this.opencodeConsoleSessions,
      sessionId,
      signal,
      fallback: 'The sign-in could not be completed.',
      poll: async () => {
        const session = this.opencodeConsoleSessions.get(sessionId);
        if (!session) return { status: 'denied', error: 'This sign-in no longer exists.' };
        const outcome = await pollOpencodeConsoleSignIn(session.deviceCode);
        if (outcome.status === 'pending') return { status: 'pending' };
        if (outcome.status === 'denied') return { status: 'denied', error: outcome.error };
        return { status: 'connected', credential: outcome.credential };
      },
      connection: (credential) => {
        // `orgName` only exists on the OAuth variant, so the union is narrowed rather than read
        // blind — a blind read is a runtime failure on exactly the accounts that paid.
        const orgName = credential.type === 'oauth' ? credential.orgName : undefined;
        return {
          id: opencodeConsoleProviderId,
          providerId: opencodeConsoleProviderId,
          name: `OpenCode Console${orgName ? ` (${orgName})` : ''}`,
          endpoint: 'https://opencode.ai/inference/openai/v1',
          priority: 1,
          proxyPool: 'none',
          modelPolicy: 'all',
        };
      },
      save: (input, credential, withSignal) => this.saveConnection(input, credential, withSignal, { tolerateDiscoveryFailure: true }),
      takeDiscoveryNote: () => {
        // Taken, not read, so one failure cannot be shown twice on a healthy connection.
        const note = this.lastDiscoveryNote;
        this.lastDiscoveryNote = undefined;
        return note;
      },
    });
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
      // The provider's own words first, so the operator can see why Cline turned the sign-in
      // away. This branch used to fall straight to the generic fallback for anything that was not
      // a `ProviderError`, so a socket that closed mid-exchange reported *"The sign-in could not be
      // completed."* and nothing else — the user was told the sign-in failed and not why.
      const message = describeSignInFailure(error, 'The sign-in could not be completed.');
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

  /**
   * Kimi Code, the `api.kimi.com/coding` subscription.
   *
   * A separate adapter from the `kimi` platform card because they are separate accounts with
   * separate billing: a subscription token and a platform key both work here, but they are not the
   * same thing and a connection saved under one is never consulted for the other.
   */
  kimiCodeAdapter(connectionId: string): KimiCodeAdapter {
    if (!this.kimiCode) {
      this.kimiCode = new KimiCodeAdapter({
        transport: this.transport,
        // A renewal must outlive the request that triggered it, or the next request presents a
        // token Kimi has already replaced.
        onTokensRefreshed: async (credential) => {
          if (!this.connectionStore) return;
          await this.connectionStore.set(connectionId, credential).catch(() => undefined);
        },
      });
    }
    return this.kimiCode;
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
    return completeSignIn({
      sessions: this.kiroSessions,
      sessionId,
      signal,
      fallback: 'The Kiro sign-in could not be completed.',
      poll: async () => {
        const outcome = await pollKiroSignInWithClaim(this.kiroSessions, sessionId);
        if (outcome === 'in-progress') return { status: 'pending' };
        if (outcome.status !== 'connected') return { status: 'denied', error: describeSignInFailure(outcome, 'The Kiro sign-in could not be completed.') };
        return { status: 'connected', credential: outcome.credential };
      },
      connection: () => ({
        id: kiroProviderId,
        providerId: kiroProviderId,
        name: 'Kiro',
        endpoint: 'https://codewhisperer.us-east-1.amazonaws.com',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }),
      save: (input, credential, withSignal) => this.saveConnection(input, credential, withSignal),
      takeDiscoveryNote: () => this.lastDiscoveryNote,
    });
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
    return this.connections.list();
  }

  async addConnectionModels(connectionId: string, modelIds: string[]) {
    return this.connections.setModels(connectionId, modelIds);
  }

  async removeConnection(connectionId: string) {
    return this.connections.remove(connectionId);
  }

  /** The API keys this gateway knows about, and whether a key is required to use it. */
  listApiKeys(): Promise<GatewayApiKeyList> {
    return this.apiKeys.list();
  }

  /** Creating a key returns its secret exactly once; it is never readable again. */
  createApiKey(name: string) {
    return this.apiKeys.create(name);
  }

  setApiKeyEnabled(id: string, enabled: boolean) {
    return this.apiKeys.setEnabled(id, enabled);
  }

  removeApiKey(id: string) {
    return this.apiKeys.remove(id);
  }

  setRequireApiKey(value: boolean) {
    return this.apiKeys.setEnforced(value);
  }

  /**
   * Guards the public LLM surface. Callers that are already trusted local administration
   * surfaces (the dashboard) must not call this.
   */
  authorizePublicRequest(presentedKey: string | undefined) {
    return this.apiKeys.authorize(presentedKey);
  }

  async updateConnectionResilience(connectionId: string, resilience: Partial<ResilienceSettings>) {
    return this.connections.setResilience(connectionId, resilience);
  }

  /** The connection that serves a provider: the only one, or the first enabled. */


  async chat(providerId: string, request: ChatRequest, signal?: AbortSignal, scope?: RequestScope): Promise<ChatResponse> {
    const adapter = await this.resolveAdapter(providerId);
    if (!adapter.chat || adapter.capabilities.chat !== true) throw notSupported(adapter, 'chat');
    return adapter.chat(request, await this.credentials.contextForProvider(providerId, signal, scope));
  }

  async *streamChat(providerId: string, request: ChatRequest, signal?: AbortSignal, scope?: RequestScope): AsyncIterable<ChatChunk> {
    const adapter = await this.resolveAdapter(providerId);
    if (!adapter.streamChat || adapter.capabilities.streaming !== true) throw notSupported(adapter, 'streaming');
    yield* adapter.streamChat(request, await this.credentials.contextForProvider(providerId, signal, scope));
  }

  /**
   * Embeds with one provider.
   *
   * The gate is two-part on purpose and both parts are load-bearing. `notSupported(adapter,
   * 'embeddings')` is what a user needs to hear when their provider has no embeddings endpoint, and it
   * is a `NOT_SUPPORTED` code, which `terminalRouteCodes` already treats as never worth retrying — so
   * the request is not also spent walking to the next connection that cannot serve it either.
   *
   * Requiring `capabilities.embeddings === true` *and* `typeof adapter.embed === 'function'` is
   * redundant for today's adapters and correct for future ones: an adapter can carry the capability
   * flag without having implemented the call (a registry entry that advertises before it builds), and
   * calling `undefined` would be a `TypeError` reaching the client as a 500 instead of a 404.
   */
  async embed(providerId: string, request: EmbeddingRequest, signal?: AbortSignal, scope?: RequestScope): Promise<EmbeddingResponse> {
    const adapter = await this.resolveAdapter(providerId);
    if (adapter.capabilities.embeddings !== true || typeof adapter.embed !== 'function') throw notSupported(adapter, 'embeddings');
    return adapter.embed(request, await this.credentials.contextForProvider(providerId, signal, scope));
  }

  /**
   * Serves one request across a failover chain: each candidate gets its own
   * retry budget, and a retryable failure moves on to the next connection.
   */
  /**
   * The failover chain: hedge, retry, then the next route.
   *
   * The loop, the attempt ledger, and the ordering live in `RequestExecutor`. This method is the
   * wiring — every effect the loop performs is one of this service's own methods, passed in rather
   * than reached for, which is what lets the loop be tested without a gateway.
   */
  async chatWithFailover(request: ChatRequest, explicitProviderId: string | undefined, signal?: AbortSignal, scope?: RequestScope): Promise<GatewayChatOutcome> {
    return this.requests.chat(request, explicitProviderId, signal, scope);
  }

  /**
   * A scope for one request, created at the edge so the id is per *request* rather than per
   * provider.
   *
   * Public because the HTTP layer is the only place that knows a request has been accepted, and it
   * needs to hand the id to the client *and* to the providers it will be sent to.
   */
  startScope(requestedModel: string, explicitProviderId?: string): RequestScope {
    return startRequestScope({ requestedModel, ...(explicitProviderId === undefined ? {} : { explicitProviderId }) });
  }

  /**
   * Which deployment this instance is, as the outer runtime describes it.
   *
   * Read rather than assumed, so a caller can see what the gateway believes about itself —
   * which tenant it serves, where its state lives, and which origins may reach it — without
   * reconstructing it from the config it already had.
   */
  deployment(): DeploymentConfig {
    return this.deploymentConfig;
  }

  /**
   * Embeds across a failover chain, beside {@link chatWithFailover}.
   *
   * Same chain, same retry budget, same ledger, **no hedge** — see `RequestExecutor.embed` for why a
   * second concurrent embeddings call is a cost rather than a latency win.
   */
  async embedWithFailover(request: EmbeddingRequest, explicitProviderId: string | undefined, signal?: AbortSignal, scope?: RequestScope): Promise<GatewayEmbedOutcome> {
    return this.requests.embed(request, explicitProviderId, signal, scope);
  }

  /** Streaming cannot retry after bytes are sent, so failover only covers the first chunk. */
  async streamChatWithFailover(request: ChatRequest, explicitProviderId: string | undefined, signal?: AbortSignal, scope?: RequestScope): Promise<GatewayStreamOutcome> {
    return this.requests.stream(request, explicitProviderId, signal, scope);
  }

  private async planRoute(model: string, explicitProviderId?: string) {
    return this.routing.plan({ connections: await this.listConnections(), model, ...(explicitProviderId === undefined ? {} : { explicitProviderId }) });
  }


  private enforceRateLimit(candidate: RouteCandidate) {
    this.routing.enforceRateLimit(candidate);
  }


  /**
   * Applies a per-connection deadline without leaking timers: the timeout aborts
   * the provider call, and the timer is always released once the call settles.
   */
  private async withDeadline<T>(signal: AbortSignal | undefined, timeoutMs: number, providerId: string, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
    return this.timeouts.within({ timeoutMs, providerId, ...(signal ? { signal } : {}) }, run);
  }


  /**
   * Reads a provider's catalog. Returns the full records, not just ids, because the
   * prices, context windows and modalities a catalog states are the only source for the
   * dashboard's model filters, and asking the provider a second time to get them would
   * mean a request per page load.
   */
  private async discoverConnectionModels(providerId: string, credential: ProviderCredential, policy: ModelImportPolicy, signal?: AbortSignal, pendingEndpoint?: { endpoint: string; name: string }) {
    return this.models.discover({ providerId, credential, policy, ...(signal ? { signal } : {}), ...(pendingEndpoint ? { pendingEndpoint } : {}) });
  }


  /**
   * Reduces catalog records to the compact form stored alongside the ids. A model the
   * provider described only as an id yields no entry at all, so the dashboard can tell
   * "nothing was stated" from "stated as zero".
   */


  private async validateConnectionCredentialUnlocked(providerId: string, credential: ProviderCredential, signal?: AbortSignal): Promise<GatewayConnectionValidation> {
    /**
     * Resolved, not required.
     *
     * `requireAdapter` is the registry-only lookup and throws for a provider whose adapter is built
     * on demand — which is how a ChatGPT Web or Cline credential could be saved at all before
     * `ConnectionManager` asked this question itself. It used to reach those through a literal
     * branch; asking the resolver covers every one of them.
     */
    const adapter = await this.resolveAdapter(providerId);
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

  /**
   * The adapter for a provider, building it when it has to be built.
   *
   * Resolved on demand for a saved connection that has no registered adapter, which is what lets
   * any OpenAI-compatible endpoint added through the dashboard serve traffic using the same
   * transport and credential vault as the built-in ones.
   *
   * Every branch that used to live here is now a `.onDemand()` registration below. The resolution
   * algorithm itself is in `ProviderResolver` and contains no provider id, so adding a provider
   * is a registration rather than a new case in someone else's control flow.
   */
  private async resolveAdapter(providerId: string, pendingEndpoint?: { endpoint: string; name: string }): Promise<ProviderAdapter> {
    return this.providers.resolve(providerId, pendingEndpoint, () => this.listConnections());
  }

  /**
   * The configuration this gateway loaded, after defaults and validation.
   *
   * Read-only, exposed for one consumer: `GET /v1/settings`. The gateway resolved these values once at
   * startup and **validated** them — `OMNIHILBRAS_PORT=0` is refused rather than clamped — so the effective
   * configuration is a fact about this process that nothing outside it can otherwise read.
   *
   * `undefined` when the service was constructed without one, which is every test. That is honest rather than
   * convenient: a service with no loaded config has no settings to report, and inventing defaults here would
   * duplicate `config.ts`'s own — two sources of truth for the same numbers, drifting apart silently.
   */
  config(): GatewayConfig | undefined {
    return this.gatewayConfig;
  }

  /**
   * The usage store, or `undefined` when the gateway was not given one.
   *
   * Exposed rather than the records, so a caller cannot write to the store through the service: the route
   * serving `GET /v1/usage` needs to read it and nothing else.
   */
  get usage(): UsageStore | undefined {
    return this.usageStore;
  }

  /**
   * The price a connection's catalog quotes for a model, or `undefined` if it quotes nothing.
   *
   * ## Why this is a lookup and not a stored price on the record
   *
   * Prices live on the connection's model metadata — the `p` array, positionally `modelMetaPriceOrder` —
   * because that is where a catalog rescan writes them. A usage record stores *tokens*, and the
   * multiplication happens when `/v1/usage` is read, so a price change is reflected immediately rather than
   * leaving a stored cost that was right last week.
   *
   * ## Why it returns `undefined` rather than a default
   *
   * Most connections to an API-key provider carry no price at all: the provider does not publish one. A
   * default would put a plausible number in a column that otherwise holds measured ones, and nothing on the
   * page could tell them apart. So the answer to "what did that cost" is sometimes "nobody has said", and
   * `usage-pricing.ts` is written to carry that through rather than average it away.
   *
   * @param connectionId Which saved connection served the request.
   * @param model The model id as it was requested.
   */
  async modelPrice(connectionId: string | undefined, model: string): Promise<ModelPricing | undefined> {
    if (!connectionId) return undefined;
    // `ConnectionManager` exposes `list()`, not `get()` — I wrote `get` from the shape of `ConnectionStore`
    // and the compiler caught it. `list()` is a full array read, which is fine here: `/v1/usage` prices its
    // own records once, and a second pass over a connection list per record would be the slower shape.
    const record = (await this.connections.list()).find((connection) => connection.id === connectionId);
    const prices = record?.modelMeta?.[model]?.p;
    if (!Array.isArray(prices) || prices.length === 0) return undefined;
    const pricing: ModelPricing = {};
    modelMetaPriceOrder.forEach((key, index) => {
      const value = prices[index];
      // Validated rather than trusted: this array is read back from a file a user can edit, and a NaN or a
      // negative rate would produce a negative total rather than an obviously wrong one.
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000) {
        pricing[key] = value;
      }
    });
    return Object.keys(pricing).length > 0 ? pricing : undefined;
  }

  private requireAdapter(providerId: string): ProviderAdapter {
    return this.providers.require(providerId);
  }

  /**
   * The context a health check should be asked in.
   *
   * Health is checked per *provider* while credentials are stored per *connection*, so this
   * resolves the provider's first credentialed connection and then defers to the same `context()`
   * the request path uses. One place builds a request context, so a credential cannot be
   * assembled one way for a health check and another for a real request.
   */
  private async contextForAdapter(providerId: string, signal?: AbortSignal, scope?: RequestScope): Promise<ProviderRequestContext> {
    return this.credentials.contextForProvider(providerId, signal, scope);
  }



}

