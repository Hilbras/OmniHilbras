import { randomUUID } from 'node:crypto';
import { ApmixAdapter } from '@omnihilbras/sdk-apmix';
import { BeatApiAdapter } from '@omnihilbras/sdk-beatapi';
import { NousAdapter } from '@omnihilbras/sdk-nous';
import { ZenAdapter, ZEN_GO_BASE_URL } from '@omnihilbras/sdk-zen';
import { CLINE_OAUTH } from '@omnihilbras/sdk-cline';
import { FetchHttpTransport, ProviderError, completeToolRounds, compressToolResults, toolResultBytes, type ChatChunk, type ChatRequest, type ChatResponse, type EmbeddingRequest, type EmbeddingResponse, type HttpTransport, type Model, type ModelImportPolicy, type ProviderAdapter, type ProviderCredential, type ProviderHealth, type ProviderQuota, type ProviderRegistry, type ProviderRequestContext, type ModelPricing } from './index.js';
import { ChatGptWebAdapter, chatGptWebCredential, chatGptWebModels, isFreeChatGptPlan, parseChatGptStorageState, chatGptWebProviderId, type ChatGptWebDriver } from '@omnihilbras/sdk-chatgpt-web';
import { CLAUDE_CODE, ClaudeCodeAdapter, claudeCodeProviderId } from '@omnihilbras/sdk-claude-code';
import { ClinePassAdapter } from '@omnihilbras/sdk-clinepass';
import { deepSeekWebCredential, deepseekWebProviderId, DeepSeekWebAdapter } from '@omnihilbras/sdk-deepseek-web';
import { DuckDuckGoWebAdapter, duckduckgoWebProviderId, DUCKDUCKGO_WEB, normalizeDuckDuckGoWebCookie, freeDuckDuckGoWebModels, type DuckDuckGoWebDriver } from '@omnihilbras/sdk-duckduckgo-web';
import { GeminiWebAdapter, geminiWebProviderId, GEMINI_WEB_MODELS, normalizeGeminiWebCookie, geminiWebCookiePresent, type GeminiWebDriver } from '@omnihilbras/sdk-gemini-web';
import { createKiloCodeAdapter } from '@omnihilbras/sdk-kilocode';
import { KIMI_CODE, KimiCodeAdapter } from '@omnihilbras/sdk-kimi-code';
import { KiroAdapter, kiroCredentialFromApiKey, kiroProviderId } from '@omnihilbras/sdk-kiro';
import { createMinimaxCodeAdapter } from '@omnihilbras/sdk-minimax-code';
import { OpencodeConsoleAdapter } from '@omnihilbras/sdk-opencode-console';
import { createQoderAdapter } from '@omnihilbras/sdk-qoder';
import { probeQwenWeb } from '@omnihilbras/sdk-qwen-web';
import { TokenHarborWebAdapter, tokenHarborWebCredential, tokenHarborWebProviderId } from '@omnihilbras/sdk-tokenharbor-web';
import type { ApiKeyRecord, ApiKeyStore } from './api-keys.js';
import { type ConnectionInput, type ConnectionRecord, type ConnectionStore, type ResilienceSettings } from './connections.js';
import type { GatewayConfig } from './config.js';
import { ClineSessionStore, beginClineAuthorization, clineCallbackPathFor, createClineAdapter, exchangeClineCode, providerSaid, toClineCredential } from './oauth.js';
import { KimiCodeSessionStore, kimiCodeProviderId, type KimiCodeSessionStatus } from '../providers/kimiCode.js';
import { NousSessionStore, nousProviderId, NOUS_BASE_URL, type NousSessionStatus } from '../providers/nous.js';
import { KiloCodeSessionStore, kilocodeProviderId, KILOCODE, type KiloCodeSessionStatus } from '../providers/kilocode.js';
import {
  CodeBuddySessionStore,
  codebuddyCnProviderId,
  codebuddyEndpointFor,
  codebuddyIntlProviderId,
  codebuddyRegionFor,
  codebuddySignInAdapter,
  type CodeBuddySessionStatus,
} from '../providers/codebuddy.js';
import { MinimaxCodeSessionStore, minimaxCodeSiteEndpoint, minimaxCodeGlobalProviderId, minimaxCodeProviderId, type MinimaxCodeSessionStatus } from '../providers/minimaxCode.js';
import { QoderSessionStore, qoderProviderId, type QoderSessionStatus } from '../providers/qoder.js';
import { qoderSignRequest } from '../providers/qoderCosy.js';
import { ClaudeCodeSessionStore, beginClaudeCodeSignIn, completeClaudeCodeSignIn, type ClaudeCodeSessionStatus } from '../providers/claudeCode.js';
import { CodexAdapter, codexProviderId } from '@omnihilbras/sdk-codex';
import { beginCodexSignIn, CodexSessionStore, completeCodexSignIn, resolveCodexConfig, type CodexSignInStatus } from '../providers/codexOAuth.js';
import { CodexCallbackListener } from './codexCallbackListener.js';
import { OpencodeConsoleSessionStore, beginOpencodeConsoleSignIn, opencodeConsoleProviderId, pollOpencodeConsoleSignIn, withConsoleWorkspace, type OpencodeConsoleSessionStatus } from './opencodeConsole.js';
import { KiroSessionStore, importKiroRefreshToken, pollKiroSignInWithClaim, startKiroSignIn, startKiroSocialDeviceFlow, type KiroSignInStatus } from '../providers/kiro.js';
import { createChatGptWebDriver } from '../providers/chatgptWeb.js';
import { createGeminiWebDriver } from '../providers/geminiWeb.js';
import { createDuckDuckGoWebDriver } from '../providers/duckduckgoWeb.js';
import { SlidingWindowRateLimiter, bareModelFor, type RouteCandidate } from './routing.js';
import { HealthManager } from './health.js';
import { ConnectionLatencyLedger } from './connection-latency.js';
import { TokenRenewal, classifyRenewalFailure } from './token-renewal.js';
import { ProviderResolver } from './provider-resolver.js';
import { completeSignIn, describeSignInFailure } from './sign-in-coordinator.js';
import { assertPublicDestination } from './destination-check.js';
import { CredentialManager } from './credential-manager.js';
import { CredentialLifecycle } from './credential-lifecycle.js';
import { localDeployment, type ConnectionSecretStore, type DeploymentConfig } from './runtime.js';
import { RoutingEngine } from './routing-engine.js';
import { ModelCatalog } from './model-catalog.js';
import { TimeoutPolicy } from './timeout-policy.js';
import { startRequestScope, withRequestScope, type RequestScope } from './request-context.js';
import { decryptBackup, encryptBackup } from './backup.js';
import { notSupported } from './capability.js';
import { RequestExecutor, type GatewayChatOutcome, type GatewayEmbedOutcome, type GatewayStreamOutcome } from './request-executor.js';
import { providerAlias, sharedCatalogProviders } from './provider-alias.js';
import { ConnectionManager } from './connection-manager.js';
import { ApiKeyManager } from './api-key-manager.js';
import type { UsageRecord, UsageStore } from './usage-store.js';
import { modelMetaPriceOrder } from './connections.js';

function pricingFromConnection(connection: ConnectionRecord | undefined, model: string): ModelPricing | undefined {
  const prices = connection?.modelMeta?.[model]?.p;
  if (!Array.isArray(prices) || prices.length === 0) return undefined;
  const pricing: ModelPricing = {};
  modelMetaPriceOrder.forEach((key, index) => {
    const value = prices[index];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000) {
      pricing[key] = value;
    }
  });
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

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
/** A token expiring within this window is renewed before a burst of requests can meet it expired. */
const renewalWindowMs = 30 * 60_000;
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
  /** Injected the same way, so a test can drive the Gemini provider without a browser. */
  geminiWebDriver?: GeminiWebDriver;
  duckDuckGoWebDriver?: DuckDuckGoWebDriver;
};

export class GatewayService {
  private readonly connectionLocks = new Map<string, Promise<void>>();
  /** Absent means the gateway records nothing; see `GatewayServiceOptions.usageStore`. */
  private readonly usageStore?: UsageStore;
  private readonly gatewayConfig: GatewayConfig | undefined;
  private readonly transport: HttpTransport;
  private readonly clineAdapters = new Map<string, ProviderAdapter>();
  private readonly clinepassAdapters = new Map<string, ProviderAdapter>();
  private apmix?: ProviderAdapter;
  private beatapi?: ProviderAdapter;
  private readonly nousAdapters = new Map<string, ProviderAdapter>();
  private readonly nousSessions = new NousSessionStore();
  private zen?: ProviderAdapter;
  private opencodeGo?: ProviderAdapter;
  private readonly opencodeConsoleAdapters = new Map<string, ProviderAdapter>();
  private readonly opencodeConsoleSessions = new OpencodeConsoleSessionStore();
  private readonly opencodeSignInSessions = new NousSessionStore();
  private readonly opencodeGoSignInSessions = new NousSessionStore();
  private readonly kimiCodeSessions = new KimiCodeSessionStore();
  /** Built on demand per connection, so signing in is what constructs it. */
  private readonly kimiCodeAdapters = new Map<string, KimiCodeAdapter>();
  private kilocode?: ProviderAdapter;
  private readonly minimaxAdapters = new Map<string, ProviderAdapter>();
  private qoder?: ProviderAdapter;
  private readonly claudeCodeSessions = new ClaudeCodeSessionStore();
  /** Built on demand per connection, so signing in is what constructs it. */
  private readonly claudeCodeAdapters = new Map<string, ClaudeCodeAdapter>();
  private readonly codexSessions = new CodexSessionStore();
  /** Serves the registered redirect port while a Codex sign-in is in flight. */
  private readonly codexCallbackListener = new CodexCallbackListener((pathname, params) => this.codexRegisteredCallback(pathname, params));
  private readonly kiroSessions = new KiroSessionStore();
  private readonly kilocodeSessions = new KiloCodeSessionStore();
  /** CodeBuddy, both regions: one store, with the region kept on each session. */
  private readonly codebuddySessions = new CodeBuddySessionStore();
  private readonly codebuddyAdapters = new Map<string, ProviderAdapter>();
  private readonly minimaxCodeSessions = new MinimaxCodeSessionStore();
  private readonly qoderSessions = new QoderSessionStore();
  private readonly chatGptWebAdapters = new Map<string, ProviderAdapter>();
  private readonly geminiWebAdapters = new Map<string, ProviderAdapter>();
  private duckDuckGoWeb?: ProviderAdapter;
  /** DeepSeek Web, built once so its access-token cache is shared across requests. */
  private deepSeek?: DeepSeekWebAdapter;
  private tokenHarborWeb?: TokenHarborWebAdapter;
  private readonly kiroAdapters = new Map<string, ProviderAdapter>();
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
  /** Test seam only. Undefined in production; see `RequestExecutorDeps.afterPlan`. */
  testAfterPlan?: () => Promise<void> | void;
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
  /** Each provider's strategy, synchronous for routing. Loaded from the store and updated only through this service. */
  private readonly providerStrategies = new Map<string, 'priority' | 'round-robin' | 'fastest'>();
  /** How fast each account has been, keyed by connection. Read by the `fastest` strategy. */
  private readonly connectionLatency = new ConnectionLatencyLedger();
  /** Saved model aliases, synchronous for routing. Loaded from the store and updated only through this service. */
  private readonly aliasSnapshot = new Map<string, { providerId: string; model: string }>();
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
    this.usageStore = options.usageStore ? this.publishingUsage(options.usageStore) : undefined;
    this.gatewayConfig = options.config;
    // Kept, not just read: the ChatGPT Web driver is built lazily on first use, long after
    // the constructor has returned, so the override has to outlive this call.
    this.options = options;
    this.transport = options.transport ?? new FetchHttpTransport({ checkDestination: assertPublicDestination });
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
      // A service built without a store has nothing to fingerprint against, and no save will reach
      // here; the empty string simply never matches a stored fingerprint.
      credentialFingerprint: (providerId, credential) => this.connectionStore?.credentialFingerprint(providerId, credential) ?? Promise.resolve(''),
      canonicalProviderId: (providerId) => providerAlias(providerId) ?? providerId,
    });
    this.credentials = new CredentialManager(this.secretStore, this.connections);
    this.routing = new RoutingEngine({
      health: { getFailureThreshold: () => this.healthManager.getFailureThreshold(), registry: () => this.healthManager.snapshotRegistry() },
      rateLimiter: this.rateLimiter,
      defaultProviderId,
      requireAdapter: (providerId) => { this.requireAdapter(providerId); },
      aliasFor: (name) => this.aliasSnapshot.get(name),
      familyOf: (providerId) => this.registry.get(providerId)?.modelFamily,
      strategyFor: (providerId) => this.providerStrategies.get(providerId) ?? 'priority',
      latencyFor: (connectionId) => this.connectionLatency.get(connectionId),
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
      afterPlan: () => this.testAfterPlan?.(),
      chat: (providerId, request, signal, scope, connectionId) => this.chat(providerId, request, signal, scope, connectionId),
      streamChat: (providerId, request, signal, scope, connectionId) => this.streamChat(providerId, request, signal, scope, connectionId),
      embed: (providerId, request, signal, scope, connectionId) => this.embed(providerId, request, signal, scope, connectionId),
      withDeadline: (signal, timeoutMs, providerId, run) => this.withDeadline(signal, timeoutMs, providerId, run),
      enforceRateLimit: (candidate) => this.enforceRateLimit(candidate),
      recordSuccess: (providerId, latencyMs, at, connectionId) => {
        this.healthManager.recordSuccess(providerId, latencyMs, at, connectionId);
        // The account that served it, when the attempt named one: `unmanaged:` candidates have no
        // connection record, and inventing one would put a reading under an id nobody can look up.
        if (connectionId && !connectionId.startsWith('unmanaged:')) this.connectionLatency.record(connectionId, latencyMs);
      },
      recordFailure: (providerId, code, reason, connectionId) => this.healthManager.recordFailure(providerId, code, reason, connectionId),
      recordModelRateLimit: (providerId, modelId, input, connectionId) => this.healthManager.recordModelRateLimit(providerId, modelId, input, connectionId),
      recordRateLimitUse: (connectionId) => this.rateLimiter.record(connectionId),
    });
    this.providers = new ProviderResolver(registry)
      .onDemand('cline', ({ connection }) => this.clineAdapter(connection?.id ?? 'cline'), { validateOnSave: true })
      // No `validateOnSave`: ClinePass stores no credential of its own — it reads Cline's connection
      // through the alias in `credential-manager.ts` — so there is nothing to prove at save time.
      .onDemand('clinepass', ({ connection }) => this.clinepassAdapter(connection?.id ?? 'cline'))
      .onDemand('apmix', () => this.apmixAdapter())
      .onDemand('beatapi', () => this.beatapiAdapter())
      // `validateOnSave`: Nous publishes its model catalog unauthenticated, so a save that only read
      // the catalog would accept any string as a key. The adapter proves it with one 1-token inference.
      .onDemand('nous', ({ providerId, connection }) => this.nousAdapter(connection?.id ?? providerId), { validateOnSave: true })
      .onDemand('opencode', () => this.zenAdapter())
      // OpenCode Go is the same wire on the subscription lane (`/zen/go`), so it is the same adapter with
      // a different base and id. `validateOnSave`: both lanes judge a key — measured on Zen, where the
      // listing answers 401 for a bad one — so a save proves it rather than trusting it.
      .onDemand('opencode-go', () => this.opencodeGoAdapter(), { validateOnSave: true })
      .onDemand(opencodeConsoleProviderId, ({ providerId, connection }) => this.opencodeConsoleAdapter(connection?.id ?? providerId))
      .onDemand(kimiCodeProviderId, ({ providerId, connection }) => this.kimiCodeAdapter(connection?.id ?? providerId))
      .onDemand(claudeCodeProviderId, ({ providerId, connection }) => this.claudeCodeAdapter(connection?.id ?? providerId))
      .onDemand(codexProviderId, ({ providerId, connection }) => this.codexAdapter(connection?.id ?? providerId))
      .onDemand(kiroProviderId, ({ providerId, connection }) => this.kiroAdapter(connection?.id ?? providerId))
      .onDemand(kilocodeProviderId, ({ providerId, connection }) => this.kilocodeAdapter(connection?.id ?? providerId))
      .onDemand(minimaxCodeProviderId, ({ providerId, connection }) => this.minimaxCodeAdapter(connection?.id ?? providerId))
      .onDemand(minimaxCodeGlobalProviderId, ({ providerId, connection }) => this.minimaxCodeAdapter(connection?.id ?? providerId))
      .onDemand(codebuddyCnProviderId, ({ providerId, connection }) => this.codebuddyAdapter(connection?.id ?? providerId))
      .onDemand(codebuddyIntlProviderId, ({ providerId, connection }) => this.codebuddyAdapter(connection?.id ?? providerId))
      .onDemand(qoderProviderId, ({ providerId, connection }) => this.qoderAdapter(connection?.id ?? providerId))
      .onDemand(chatGptWebProviderId, ({ providerId, connection }) => this.chatGptWebAdapter(connection?.id ?? providerId))
      .onDemand(geminiWebProviderId, ({ providerId, connection }) => this.geminiWebAdapter(connection?.id ?? providerId))
      .onDemand(duckduckgoWebProviderId, () => this.duckDuckGoWebAdapter())
      .onDemand(deepseekWebProviderId, () => this.deepSeekAdapter())
      .onDemand(tokenHarborWebProviderId, () => this.tokenHarborWebAdapter());
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


  /**
   * One renewal pass: refreshes each OAuth connection whose token expires within the window, by asking its
   * adapter to validate it. An adapter that cannot say whether a token has expired is left alone, rather than
   * refreshed on a guess.
   */
  async renewExpiringTokens(): Promise<void> {
    await this.tokenRenewal().pass();
  }

  /** Starts renewal passes on their own timer, so an idle OAuth token is refreshed before a burst meets it. */
  startTokenRenewal(intervalMs?: number): void {
    this.tokenRenewal(intervalMs).start();
  }

  stopTokenRenewal(): void {
    this.tokenRenewalTimer?.stop();
  }

  private tokenRenewalTimer: TokenRenewal | undefined;

  private tokenRenewal(intervalMs?: number): TokenRenewal {
    if (this.tokenRenewalTimer) return this.tokenRenewalTimer;
    this.tokenRenewalTimer = this.buildTokenRenewal(intervalMs);
    return this.tokenRenewalTimer;
  }

  private buildTokenRenewal(intervalMs?: number): TokenRenewal {
    return new TokenRenewal({
      connections: async () => {
        const due: Array<{ id: string; providerId: string; expiresAt?: string }> = [];
        for (const connection of await this.listConnections()) {
          if (!connection.enabled || !connection.hasCredential) continue;
          const context = await this.credentials.context(connection.id, connection.providerId);
          const credential = context.credential;
          if (!credential || credential.type !== 'oauth' || typeof credential.expiresAt !== 'string') continue;
          due.push({ id: connection.id, providerId: connection.providerId, expiresAt: credential.expiresAt });
        }
        return due;
      },
      renew: async (connection) => {
        const adapter = await this.resolveAdapter(connection.providerId, undefined, connection.id);
        const context = await this.credentials.context(connection.id, connection.providerId);
        const credential = context.credential;
        if (!credential || credential.type !== 'oauth' || !adapter.isCredentialExpired) return;
        const expiring = adapter.isCredentialExpired(credential, Date.now() + renewalWindowMs);
        if (expiring !== true) return;
        /**
         * Renew when the adapter can, probe when it cannot.
         *
         * Calling only `validateCredential` was a silent no-op for renewal: it asks the provider whether a
         * token works, and never replaces one that is about to expire. An idle connection therefore drifted
         * past its expiry and the next request paid for it — which is what "the session only lasts a few
         * hours" actually was. `renewCredential` is optional, so a provider that cannot renew still gets the
         * probe and behaves exactly as before.
         */
        const renewable = adapter as { renewCredential?: (credential: ProviderCredential) => Promise<void> };
        if (typeof renewable.renewCredential === 'function') {
          await renewable.renewCredential(credential);
          return;
        }
        await adapter.validateCredential?.(credential, context);
      },
    }, {
      windowMs: renewalWindowMs,
      ...(intervalMs === undefined ? {} : { intervalMs }),
      onError: (connection, error) => {
        if (classifyRenewalFailure(error) !== 'needs-sign-in') return;
        this.healthManager.noteLoginRefused(connection.providerId, 'The login needs sign-in again: refresh was refused.');
      },
    });
  }

  /** A provider's connection strategy: `priority` (the default), `round-robin`, or `fastest`. */
  providerStrategy(providerId: string): 'priority' | 'round-robin' | 'fastest' {
    return this.providerStrategies.get(providerId) ?? 'priority';
  }

  /** A requested name that is a saved alias is replaced by the model it points at; any other name is returned as given. */
  private resolvedModel(model: string): string {
    return this.aliasSnapshot.get(model.trim())?.model ?? model;
  }

  /** Saves a model alias and makes it routable at once. */
  async setModelAlias(name: string, target: { providerId: string; model: string }): Promise<void> {
    const store = this.connectionStore as { setAlias?: (n: string, t: { providerId: string; model: string }) => Promise<void> } | undefined;
    if (!store?.setAlias) throw new ProviderError('CONFIGURATION_ERROR', 'Model aliases are not stored by this connection store.');
    await store.setAlias(name, target);
    this.aliasSnapshot.set(name.trim(), { providerId: target.providerId, model: target.model.trim() });
  }

  /** Reads the saved aliases into routing. Called at startup so an alias works from the first request. */
  async loadModelAliases(): Promise<void> {
    const store = this.connectionStore as { aliases?: () => Promise<Record<string, { providerId: string; model: string }>> } | undefined;
    if (!store?.aliases) return;
    for (const [name, target] of Object.entries(await store.aliases())) this.aliasSnapshot.set(name, target);
  }

  /** Reads the saved strategies into routing. Called at startup so a restart keeps every choice in effect. */
  async loadProviderStrategies(): Promise<void> {
    const store = this.connectionStore as { allStrategies?: () => Promise<Array<[string, string]>> } | undefined;
    if (!store?.allStrategies) return;
    for (const [providerId, strategy] of await store.allStrategies()) {
      this.providerStrategies.set(providerId, strategy as 'priority' | 'round-robin' | 'fastest');
    }
  }

  /** Changes a provider's strategy. Routing reads the change on the next request, with no restart. */
  async setProviderStrategy(providerId: string, strategy: string): Promise<void> {
    if (strategy !== 'priority' && strategy !== 'round-robin' && strategy !== 'fastest') {
      throw new ProviderError('INVALID_REQUEST', 'The provider strategy must be one of priority, round-robin, fastest.');
    }
    const store = this.connectionStore as { setStrategy?: (id: string, value: string) => Promise<void> } | undefined;
    if (!store?.setStrategy) throw new ProviderError('CONFIGURATION_ERROR', 'Provider strategies are not stored by this connection store.');
    await store.setStrategy(providerId, strategy);
    this.providerStrategies.set(providerId, strategy as 'priority' | 'round-robin' | 'fastest');
  }

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
    this.stopTokenRenewal();
    this.codexCallbackListener.close();
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
    const strategies = Object.fromEntries(this.providerStrategies);
    return {
      failureThreshold: this.healthManager.getFailureThreshold(),
      strategies,
      connections: connections.map((connection) => ({
        connectionId: connection.id,
        providerId: connection.providerId,
        enabled: connection.enabled,
        hasCredential: connection.hasCredential,
        // Measured round trip for this account, when it has served a request. Absent, never zero:
        // "never measured" and "instant" are different answers and the panel shows them differently.
        ...(this.connectionLatency.get(connection.id) ? { latency: this.connectionLatency.get(connection.id) } : {}),
        resilience: connection.resilience,
        ...(waits.has(connection.id) ? { rateLimitWaitMs: waits.get(connection.id) } : {}),
        ...(this.healthManager.snapshot(connection.id) ?? this.healthManager.snapshot(connection.providerId) ?? {}),
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
    return (await this.saveConnectionDetailed(input, credential, signal, options)).connection;
  }

  /**
   * The same save, reporting what happened to the credential.
   *
   * `identical` means the key was already saved and nothing was written — the caller should say so
   * rather than imply a new account. `updated` means the same sign-in was renewed in place. The plain
   * `saveConnection` wraps this for the many callers that only want the record.
   */
  async saveConnectionDetailed(input: ConnectionInput, credential: ProviderCredential, signal?: AbortSignal, options: { tolerateDiscoveryFailure?: boolean } = {}): Promise<{ connection: ConnectionRecord; duplicate: 'none' | 'identical' | 'updated' }> {
    const saved = await this.connections.save(input, credential, signal, options);
    // A provider whose catalog lives on a **shared** record has no connection of its own until this
    // runs: ClinePass was reachable by the gateway but absent from the model list and, at routing time,
    // skipped as `no-models`. It is created here — after Cline's catalog imported, with the same
    // credential, which the record shares rather than duplicates — and its tier is imported now.
    await this.ensureSharedCatalogConnections(signal);
    return saved;
  }

  /**
   * Creates the record for every provider whose catalog is not stored on the connection it shares.
   *
   * Deliberately best-effort: a tier that will not read must not fail a sign-in that was already
   * approved. What it must not do is *borrow* the owner's credential — `providers` is what makes the
   * credential shared, and the tier is listed from the adapter instead.
   */
  async ensureSharedCatalogConnections(signal?: AbortSignal) {
    for (const [aliasId, ownerId] of Object.entries(sharedCatalogProviders)) {
      const connections = await this.connections.list();
      if (connections.some((connection) => connection.providerId === aliasId)) continue;
      const owner = connections.find((connection) => connection.providerId === ownerId && connection.hasCredential);
      if (!owner) continue;
      try {
        /**
         * A `none` credential, not a copy of the owner's.
         *
         * This record is a **catalog alias**: `CredentialManager` resolves the alias for the request
         * path, so the token is read from Cline's connection. Copying it here is what the old code did,
         * and it both invalidated one of two copies on refresh and failed outright with "Connection ID
         * is already used by another provider" — a failure the bare `catch` then hid, so the shared
         * card simply never existed.
         */
        await this.connections.save({
          id: aliasId,
          providerId: aliasId,
          name: aliasId === 'clinepass' ? 'ClinePass (via Cline)' : aliasId,
          endpoint: owner.endpoint,
          priority: owner.priority,
          proxyPool: owner.proxyPool,
          modelPolicy: owner.modelPolicy ?? 'all',
        }, { type: 'none' }, signal, { tolerateDiscoveryFailure: true });
      } catch (error) {
        // Best-effort still, but not silent: a shared card that could not be created is a real
        // missing capability, and the sign-in it followed has already succeeded.
        console.warn(`[shared-catalog] could not create ${aliasId}: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
  }

  /**
   * Completes a Cline sign-in: exchanges what the user pasted for tokens,
   * proves them against Cline, and only then stores the connection.
   */
  async connectCline(input: { code: string; callback?: string; redirectUri: string; connectionId?: string; name?: string; priority?: number }, signal?: AbortSignal): Promise<ConnectionRecord> {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    const tokens = await exchangeClineCode(input, this.transport, signal);
    const credential = toClineCredential(tokens);
    // `saveConnection` proves the token against Cline and imports the catalog
    // before anything reaches the vault, so nothing is stored on a bad sign-in.
    return this.saveConnection({
      id: input.connectionId ?? 'cline',
      providerId: 'cline',
      name: input.name?.trim() || (tokens.email ? `Cline (${tokens.email})` : 'Cline'),
      endpoint: CLINE_OAUTH.apiBaseUrl,
      priority: input.priority ?? 1,
      proxyPool: 'none',
      modelPolicy: 'all',
      // A sign-in that Cline's own flow approved has proven the credential, so a catalog that will not
      // read must not throw the session away. Every other provider's sign-in passes this; Cline's did
      // not, so any discovery failure (a rate-limit, a changed endpoint, a 5xx on the model list) became
      // `CONFIGURATION_ERROR — The local connection could not be saved` and the user was told to sign in
      // again, losing a perfectly good session. The models arrive on the next read instead.
    }, credential, signal, { tolerateDiscoveryFailure: true });
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
    const refreshed = await this.connections.refreshModels(connectionId, signal);
    // A refresh is also the moment an account signed in before this existed — or before its tier was
    // importable — gets its shared record. Doing it here is what makes the fix self-healing instead of
    // a migration only the code that runs at sign-in time would perform.
    await this.ensureSharedCatalogConnections(signal);
    return refreshed;
  }


  /**
   * Starts an OpenCode Console sign-in. This is a device flow: the Console hands back a
   * code the user types into its own page, so the dashboard shows the code and waits
   * rather than following a redirect.
   */
  /**
   * Starts a Kimi Code sign-in. A device flow, so the user approves a code in their own browser and
   * the dashboard polls — nothing is redirected back to us.
   *
   * `addAccount` decides what the sign-in saves to, made here rather than at poll time: the provider's
   * one connection for a repair, a fresh unique id for a second account — the rule Kiro's
   * multi-account flow states, and the reason a second Kimi account can exist beside the first without
   * overwriting it.
   */
  async startKimiCodeSignIn(addAccount = false, targetConnectionId?: string) {
    // **The registered adapter, not a fresh one.** A `new KimiCodeAdapter` here would build its own
    // `FetchHttpTransport` and reach the real Kimi even when the gateway was constructed with a
    // scripted transport — so a test of this flow made a live network call, and a caller who supplied
    // their own transport silently had it ignored for the sign-in. The adapter is memoised per
    // connection, which is exactly the lifetime this needs.
    const connectionId = targetConnectionId ?? (addAccount ? `${kimiCodeProviderId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : kimiCodeProviderId);
    const started = await this.kimiCodeAdapter(connectionId).beginSignIn();
    const session = this.kimiCodeSessions.create({ ...started, connectionId });
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
        const outcome = await this.kimiCodeAdapter(session.connectionId ?? kimiCodeProviderId).pollSignIn(session.deviceCode, signal, session.deviceId);
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
        // The session's target id, not the bare provider id: an "add account" sign-in reserved a fresh
        // one at start, and a repair targets the connection it is repairing. Falling back to the
        // provider id keeps every existing caller — and every old client that never sent the flag —
        // behaving exactly as before.
        id: this.kimiCodeSessions.get(sessionId)?.connectionId ?? kimiCodeProviderId,
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

  /* ------------------------------------------------------------------ *
   * Nous Research — a device flow beside the API-key path on the same card.
   * ------------------------------------------------------------------ */

  async startNousSignIn(addAccount = false, targetConnectionId?: string) {
    const adapter = this.nousAdapter(nousProviderId) as unknown as {
      beginSignIn(): Promise<{ deviceCode: string; userCode: string; verificationUrl: string; expiresIn?: number }>;
    };
    const started = await adapter.beginSignIn();
    const session = this.nousSessions.create({
      ...started,
      connectionId: targetConnectionId ?? (addAccount ? `${nousProviderId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : nousProviderId),
    });
    return {
      sessionId: session.id,
      userCode: session.userCode,
      verificationUrl: session.verificationUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  nousSignInStatus(sessionId: string, signal?: AbortSignal): Promise<NousSessionStatus | undefined> {
    return completeSignIn({
      sessions: this.nousSessions,
      sessionId,
      signal,
      fallback: 'The Nous Research sign-in could not be completed.',
      poll: async () => {
        const session = this.nousSessions.get(sessionId);
        if (!session) return { status: 'denied', error: 'This sign-in no longer exists.' };
        const adapter = this.nousAdapter(nousProviderId) as unknown as {
          pollSignIn(deviceCode: string, signal?: AbortSignal): Promise<
            | { status: 'pending' }
            | { status: 'denied'; error: string }
            | { status: 'connected'; credential: ProviderCredential; account: string }
          >;
        };
        const outcome = await adapter.pollSignIn(session.deviceCode, signal);
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
        // The session's target: the provider id for a repair, a reserved fresh id for an added account.
        id: this.nousSessions.get(sessionId)?.connectionId ?? nousProviderId,
        providerId: nousProviderId,
        name: 'Nous Research',
        endpoint: NOUS_BASE_URL,
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }),
      save: (input, credential, pollSignal) => this.saveConnection(input, credential, pollSignal),
    });
  }

  /* ------------------------------------------------------------------ *
   * OpenCode Zen / Go — an OpenCode Console sign-in beside the API-key path.
   *
   * Both use the Console's device flow to obtain an access token, then save
   * it as the connection's credential for their own Zen/Go endpoint. The
   * token is a bearer the lane accepts, so no Console lane resolution is
   * needed here — the existing Zen adapter serves the models.
   * ------------------------------------------------------------------ */

  async startOpencodeSignIn(addAccount = false, targetConnectionId?: string) {
    const started = await beginOpencodeConsoleSignIn();
    const session = this.opencodeSignInSessions.create({
      ...started,
      connectionId: targetConnectionId ?? (addAccount ? `opencode-${randomUUID().replace(/-/g, '').slice(0, 12)}` : 'opencode'),
    });
    return {
      sessionId: session.id,
      userCode: session.userCode,
      verificationUrl: session.verificationUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  opencodeSignInStatus(sessionId: string, signal?: AbortSignal): Promise<NousSessionStatus | undefined> {
    return completeSignIn({
      sessions: this.opencodeSignInSessions,
      sessionId,
      signal,
      fallback: 'The OpenCode sign-in could not be completed.',
      poll: async () => {
        const session = this.opencodeSignInSessions.get(sessionId);
        if (!session) return { status: 'denied', error: 'This sign-in no longer exists.' };
        const outcome = await pollOpencodeConsoleSignIn(session.deviceCode);
        if (outcome.status === 'pending') return { status: 'pending' };
        if (outcome.status === 'denied') return { status: 'denied', error: outcome.error };
        if (outcome.status === 'choose') {
          const workspace = outcome.workspaces[0];
          if (!workspace) return { status: 'denied', error: 'No workspace was offered for this account.' };
          return { status: 'connected', credential: withConsoleWorkspace(outcome.credential, workspace) };
        }
        return { status: 'connected', credential: outcome.credential };
      },
      takeDiscoveryNote: () => {
        const note = this.lastDiscoveryNote;
        this.lastDiscoveryNote = undefined;
        return note;
      },
      connection: () => ({
        id: this.opencodeSignInSessions.get(sessionId)?.connectionId ?? 'opencode',
        providerId: 'opencode',
        name: 'OpenCode Zen',
        endpoint: 'https://opencode.ai/zen/v1',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }),
      save: (input, credential, pollSignal) => this.saveConnection(input, credential, pollSignal, { tolerateDiscoveryFailure: true }),
    });
  }

  async startOpencodeGoSignIn(addAccount = false, targetConnectionId?: string) {
    const started = await beginOpencodeConsoleSignIn();
    const session = this.opencodeGoSignInSessions.create({
      ...started,
      connectionId: targetConnectionId ?? (addAccount ? `opencode-go-${randomUUID().replace(/-/g, '').slice(0, 12)}` : 'opencode-go'),
    });
    return {
      sessionId: session.id,
      userCode: session.userCode,
      verificationUrl: session.verificationUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  opencodeGoSignInStatus(sessionId: string, signal?: AbortSignal): Promise<NousSessionStatus | undefined> {
    return completeSignIn({
      sessions: this.opencodeGoSignInSessions,
      sessionId,
      signal,
      fallback: 'The OpenCode sign-in could not be completed.',
      poll: async () => {
        const session = this.opencodeGoSignInSessions.get(sessionId);
        if (!session) return { status: 'denied', error: 'This sign-in no longer exists.' };
        const outcome = await pollOpencodeConsoleSignIn(session.deviceCode);
        if (outcome.status === 'pending') return { status: 'pending' };
        if (outcome.status === 'denied') return { status: 'denied', error: outcome.error };
        if (outcome.status === 'choose') {
          const workspace = outcome.workspaces[0];
          if (!workspace) return { status: 'denied', error: 'No workspace was offered for this account.' };
          return { status: 'connected', credential: withConsoleWorkspace(outcome.credential, workspace) };
        }
        return { status: 'connected', credential: outcome.credential };
      },
      takeDiscoveryNote: () => {
        const note = this.lastDiscoveryNote;
        this.lastDiscoveryNote = undefined;
        return note;
      },
      connection: () => ({
        id: this.opencodeGoSignInSessions.get(sessionId)?.connectionId ?? 'opencode-go',
        providerId: 'opencode-go',
        name: 'OpenCode Go',
        endpoint: 'https://opencode.ai/zen/go/v1',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }),
      save: (input, credential, pollSignal) => this.saveConnection(input, credential, pollSignal, { tolerateDiscoveryFailure: true }),
    });
  }

  /* ------------------------------------------------------------------ *
   * Kilo Code, MiniMax Code, Qoder — all device flows.
   * ------------------------------------------------------------------ */

  async startKilocodeSignIn(addAccount = false, targetConnectionId?: string) {
    const adapter = this.kilocodeAdapter(kilocodeProviderId) as unknown as {
      beginSignIn(): Promise<{ deviceCode: string; userCode: string; verificationUrl: string; expiresIn?: number }>;
    };
    const started = await adapter.beginSignIn();
    const session = this.kilocodeSessions.create({ ...started, connectionId: targetConnectionId ?? (addAccount ? `kilocode-${randomUUID().replace(/-/g, '').slice(0, 12)}` : kilocodeProviderId) });
    return { sessionId: session.id, userCode: session.userCode ?? started.userCode, verificationUrl: session.verificationUrl, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  kilocodeSignInStatus(sessionId: string, signal?: AbortSignal): Promise<KiloCodeSessionStatus | undefined> {
    return completeSignIn({
      sessions: this.kilocodeSessions,
      sessionId,
      signal,
      fallback: 'The Kilo Code sign-in could not be completed.',
      poll: async () => {
        const session = this.kilocodeSessions.get(sessionId);
        if (!session) return { status: 'denied', error: 'This sign-in no longer exists.' };
        const adapter = this.kilocodeAdapter(kilocodeProviderId) as unknown as {
          pollSignIn(deviceCode: string, signal?: AbortSignal): Promise<
            | { status: 'pending' }
            | { status: 'denied'; error: string }
            | { status: 'expired'; error: string }
            | { status: 'connected'; credential: ProviderCredential; account: string }
          >;
        };
        const outcome = await adapter.pollSignIn(session.deviceCode, signal);
        if (outcome.status === 'pending') return { status: 'pending' };
        if (outcome.status === 'denied' || outcome.status === 'expired') return { status: 'denied', error: outcome.error };
        return { status: 'connected', credential: outcome.credential };
      },
      takeDiscoveryNote: () => {
        const note = this.lastDiscoveryNote;
        this.lastDiscoveryNote = undefined;
        return note;
      },
      connection: () => ({
        id: this.kilocodeSessions.get(sessionId)?.connectionId ?? kilocodeProviderId,
        providerId: kilocodeProviderId,
        name: 'Kilo Code',
        endpoint: KILOCODE.server,
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }),
      save: (input, credential, pollSignal) => this.saveConnection(input, credential, pollSignal),
    });
  }

  /**
   * CodeBuddy, both regions.
   *
   * Not a typed device code despite the upstream field names: the start returns an approval URL, the
   * user approves in a browser, and the poll asks for the token. So `userCode` is absent from the
   * response and the dashboard opens `verificationUrl`.
   */
  async startCodeBuddySignIn(providerId: string, addAccount = false, targetConnectionId?: string) {
    const region = codebuddyRegionFor(providerId);
    const adapter = codebuddySignInAdapter(region, { transport: this.transport }) as unknown as {
      beginSignIn(): Promise<{ deviceCode: string; userCode: string; verificationUrl: string; expiresIn?: number }>;
    };
    const started = await adapter.beginSignIn();
    const session = this.codebuddySessions.create({ ...started, region, connectionId: targetConnectionId ?? (addAccount ? `${providerId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : providerId) });
    return {
      sessionId: session.id,
      verificationUrl: session.verificationUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  codebuddySignInStatus(providerId: string, sessionId: string, signal?: AbortSignal): Promise<CodeBuddySessionStatus | undefined> {
    return completeSignIn({
      sessions: this.codebuddySessions,
      sessionId,
      signal,
      fallback: 'The CodeBuddy sign-in could not be completed.',
      poll: async () => {
        const session = this.codebuddySessions.get(sessionId);
        if (!session) return { status: 'denied', error: 'This sign-in no longer exists.' };
        // The adapter is built from the region the start recorded, not from the id the poll arrived
        // with: a session opened against one region must never be exchanged against the other.
        const adapter = codebuddySignInAdapter(session.region, { transport: this.transport }) as unknown as {
          pollSignIn(deviceCode: string, signal?: AbortSignal): Promise<
            | { status: 'pending' }
            | { status: 'denied'; error: string }
            | { status: 'expired'; error: string }
            | { status: 'connected'; credential: ProviderCredential; account: string }
          >;
        };
        const outcome = await adapter.pollSignIn(session.deviceCode, signal);
        if (outcome.status === 'pending') return { status: 'pending' };
        if (outcome.status === 'denied' || outcome.status === 'expired') return { status: 'denied', error: outcome.error };
        return { status: 'connected', credential: outcome.credential };
      },
      takeDiscoveryNote: () => {
        const note = this.lastDiscoveryNote;
        this.lastDiscoveryNote = undefined;
        return note;
      },
      connection: () => ({
        id: this.codebuddySessions.get(sessionId)?.connectionId ?? providerId,
        providerId,
        name: providerId === codebuddyIntlProviderId ? 'CodeBuddy (Global)' : 'CodeBuddy',
        endpoint: codebuddyEndpointFor(providerId),
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }),
      save: (input, credential, pollSignal) => this.saveConnection(input, credential, pollSignal),
    });
  }

  async startMinimaxCodeSignIn(providerId: string, addAccount = false, targetConnectionId?: string) {
    const connectionId = targetConnectionId ?? (addAccount ? `${providerId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : providerId);
    const adapter = this.minimaxCodeAdapter(connectionId) as unknown as {
      beginSignIn(): Promise<{ deviceCode: string; userCode: string; verificationUrl: string; codeVerifier: string; expiresIn?: number }>;
    };
    const started = await adapter.beginSignIn();
    const session = this.minimaxCodeSessions.create({ ...started, connectionId });
    return { sessionId: session.id, userCode: session.userCode, verificationUrl: session.verificationUrl, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  minimaxCodeSignInStatus(providerId: string, sessionId: string, signal?: AbortSignal): Promise<MinimaxCodeSessionStatus | undefined> {
    return completeSignIn({
      sessions: this.minimaxCodeSessions,
      sessionId,
      signal,
      fallback: 'The MiniMax Code sign-in could not be completed.',
      poll: async () => {
        const session = this.minimaxCodeSessions.get(sessionId);
        if (!session) return { status: 'denied', error: 'This sign-in no longer exists.' };
        const adapter = this.minimaxCodeAdapter(session.connectionId ?? providerId) as unknown as {
          pollSignIn(deviceCode: string, signal?: AbortSignal, codeVerifier?: string, userCode?: string, pollByUserCode?: boolean): Promise<
            | { status: 'pending' }
            | { status: 'slow_down' }
            | { status: 'denied'; error: string }
            | { status: 'expired'; error: string }
            | { status: 'connected'; credential: ProviderCredential }
          >;
        };
        // `device_code` by default; `user_code` only for the variant that issued no device code.
        const outcome = await adapter.pollSignIn(session.deviceCode, signal, session.codeVerifier, session.userCode, session.pollByUserCode);
        if (outcome.status === 'pending' || outcome.status === 'slow_down') return { status: 'pending' };
        if (outcome.status === 'denied' || outcome.status === 'expired') return { status: 'denied', error: outcome.error };
        return { status: 'connected', credential: outcome.credential };
      },
      takeDiscoveryNote: () => {
        const note = this.lastDiscoveryNote;
        this.lastDiscoveryNote = undefined;
        return note;
      },
      connection: () => ({
        id: this.minimaxCodeSessions.get(sessionId)?.connectionId ?? providerId,
        providerId,
        name: providerId === minimaxCodeGlobalProviderId ? 'MiniMax Code (Global)' : 'MiniMax Code',
        endpoint: minimaxCodeSiteEndpoint(providerId),
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }),
      save: (input, credential, pollSignal) => this.saveConnection(input, credential, pollSignal),
    });
  }

  async startQoderSignIn(addAccount = false, targetConnectionId?: string) {
    const adapter = this.qoderAdapter(qoderProviderId) as unknown as {
      beginSignIn(): Promise<{ deviceCode: string; userCode: string; verificationUrl: string; codeVerifier: string; machineId: string; expiresIn: number }>;
    };
    const started = await adapter.beginSignIn();
    const connectionId = targetConnectionId ?? (addAccount ? `qoder-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}` : qoderProviderId);
    const session = this.qoderSessions.create({ ...started, connectionId });
    return { sessionId: session.id, userCode: session.userCode, verificationUrl: session.verificationUrl, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  qoderSignInStatus(sessionId: string, signal?: AbortSignal): Promise<QoderSessionStatus | undefined> {
    return completeSignIn({
      sessions: this.qoderSessions,
      sessionId,
      signal,
      fallback: 'The Qoder sign-in could not be completed.',
      poll: async () => {
        const session = this.qoderSessions.get(sessionId);
        if (!session) return { status: 'denied', error: 'This sign-in no longer exists.' };
        const adapter = this.qoderAdapter(qoderProviderId) as unknown as {
          pollSignIn(nonce: string, signal?: AbortSignal, codeVerifier?: string, machineId?: string): Promise<
            { status: 'pending' } | { status: 'denied'; error: string } | { status: 'connected'; credential: ProviderCredential }
          >;
        };
        const outcome = await adapter.pollSignIn(session.nonce, signal, session.codeVerifier, session.machineId);
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
        id: this.qoderSessions.get(sessionId)?.connectionId ?? qoderProviderId,
        providerId: qoderProviderId,
        name: 'Qoder',
        endpoint: 'https://api3.qoder.sh',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }),
      save: (input, credential, pollSignal) => this.saveConnection(input, credential, pollSignal, { tolerateDiscoveryFailure: true }),
    });
  }

  /**
   * Starts a Claude Code sign-in. An authorization-code flow with PKCE, so the browser opens on
   * Claude's page and returns to a callback this gateway serves; nothing is typed by the user.
   *
   * The public base URL is supplied by the route rather than read from a config field, because that
   * is where the gateway's own reachable origin is known — the same value `defaultClineRedirect`
   * uses. The callback path derived from it must match the one the route and `http.ts` exempt.
   */
  startClaudeCodeSignIn(publicBaseUrl: string, addAccount = false, targetConnectionId?: string) {
    return beginClaudeCodeSignIn({ store: this.claudeCodeSessions, publicBaseUrl, connectionId: targetConnectionId ?? (addAccount ? `claude-code-${randomUUID().replace(/-/g, '').slice(0, 12)}` : claudeCodeProviderId) });
  }

  /**
   * Begins a Codex sign-in, opening the loopback port its redirect URI points at.
   *
   * The public Codex client is registered against a callback on a port this gateway does not
   * otherwise serve, so a second loopback listener has to stand in for it. It is opened here rather
   * than at startup so that fixed port is held only while a sign-in is in flight, and it closes the
   * moment the callback lands. A redirect that already points at the gateway's own listener — which
   * is what an operator's registered URI does — needs no second socket, and opening one there
   * would simply collide with the server that is already bound to it.
   */
  async startCodexSignIn(publicBaseUrl: string, addAccount = false, targetConnectionId?: string) {
    const config = this.gatewayConfig?.codex;
    const redirect = resolveCodexConfig({ clientId: config?.clientId, redirectUri: config?.redirectUri, publicBaseUrl });
    const gatewayPort = Number(new URL(publicBaseUrl).port || 80);
    if (redirect.redirectPort !== gatewayPort) {
      await this.codexCallbackListener.open(redirect.redirectPort, '127.0.0.1');
    }
    return beginCodexSignIn({ store: this.codexSessions, ...redirect, connectionId: targetConnectionId ?? (addAccount ? `codex-${randomUUID().replace(/-/g, '').slice(0, 12)}` : codexProviderId) });
  }

  /**
   * Serves a callback that arrived on the registered loopback port rather than on the gateway's own.
   *
   * Same state correlation and one-time claim as the gateway route — only the socket differs, and
   * the correlation is what makes the second socket safe rather than a way around the first.
   */
  private async codexRegisteredCallback(pathname: string, params: URLSearchParams) {
    const state = params.get('state') ?? '';
    const code = params.get('code') ?? '';
    const providerError = params.has('error');
    const session = state ? this.codexSessions.findCallback(pathname, state) : undefined;
    const status = session && providerError
      ? this.codexSessions.failCallback(pathname, state, 'Codex sign-in was not approved. Start again from OmniHilbras.')
      : session && code
        ? await this.completeCodexCallback({ sessionId: session.id, code, state })
        : undefined;
    return {
      ok: status?.status === 'connected',
      message: status?.error ?? (status?.status === 'connected' ? 'Connected to Codex.' : 'This callback did not identify a Codex sign-in. Start again from OmniHilbras.'),
    };
  }

  codexCallbackSession(path: string, state: string) {
    return this.codexSessions.findCallback(path, state);
  }

  failCodexCallback(path: string, state: string, error: string) {
    const session = this.codexSessions.failCallback(path, state, error);
    return session ? this.codexSessions.publicStatus(session) : undefined;
  }

  codexSignInStatus(sessionId: string): CodexSignInStatus | undefined {
    const session = this.codexSessions.get(sessionId);
    return session ? this.codexSessions.publicStatus(session) : undefined;
  }

  completeCodexCallback(input: { sessionId: string; code: string; state: string }, signal?: AbortSignal) {
    // The client is the session's own, not this process's current configuration: the authorize
    // request and the exchange have to present the same client, and a sign-in started before a
    // configuration change must still finish with the pair it was begun with.
    return completeCodexSignIn({
      store: this.codexSessions,
      ...input,
      transport: this.transport,
      ...(signal ? { signal } : {}),
      // Tolerant on purpose: the credential is already exchanged and valid, so a catalog that cannot
      // be read must not throw away a completed sign-in. The connection is stored and the reason the
      // model list is missing travels with it, which is what the dashboard shows afterwards.
      saveConnection: async (credential) => this.saveConnection({
        id: this.codexSessions.get(input.sessionId)?.connectionId ?? codexProviderId,
        providerId: codexProviderId,
        name: 'Codex',
        endpoint: 'https://chatgpt.com/backend-api/codex/responses',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }, credential, signal, { tolerateDiscoveryFailure: true }),
    });
  }

  /** Whether a started Claude Code sign-in has finished, and how it went. */
  claudeCodeSignInStatus(sessionId: string) {
    const session = this.claudeCodeSessions.get(sessionId);
    return session ? this.claudeCodeSessions.publicStatus(session) : undefined;
  }

  /**
   * Finishes the sign-in a callback delivered: the code is exchanged with the stored PKCE verifier,
   * the credential is proved against Claude, the catalog is imported, and only then is anything
   * saved. Completion lives in `claudeCode.ts`, which is close to the store that holds the verifier;
   * what stays here is the connection the gateway records for it.
   */
  completeClaudeCodeCallback(input: { sessionId?: string; raw: string }, signal?: AbortSignal): Promise<ClaudeCodeSessionStatus | undefined> {
    if (!input.sessionId) return Promise.resolve(undefined);
    const sessionId = input.sessionId;
    return completeClaudeCodeSignIn({
      store: this.claudeCodeSessions,
      sessionId: input.sessionId,
      raw: input.raw,
      transport: this.transport,
      ...(signal ? { signal } : {}),
      saveConnection: async ({ credential }) => this.saveConnection({
        id: this.claudeCodeSessions.get(sessionId)?.connectionId ?? claudeCodeProviderId,
        providerId: claudeCodeProviderId,
        name: 'Claude Code',
        // The endpoint is fixed by the adapter; recorded so an operator can see which host it reaches.
        endpoint: CLAUDE_CODE.server,
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }, credential, signal),
    });
  }

  async startOpencodeConsoleSignIn(addAccount = false, targetConnectionId?: string) {
    const started = await beginOpencodeConsoleSignIn();
    const connectionId = targetConnectionId ?? (addAccount ? `opencode-console-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}` : opencodeConsoleProviderId);
    const session = this.opencodeConsoleSessions.create({ ...started, connectionId });
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
  /**
   * Saves the OpenCode Console connection with the workspace the user picked.
   *
   * The id must be one of the workspaces the sign-in offered, so a made-up id is refused rather than
   * saved. The parked credential is taken once, so a second pick cannot save it twice.
   */
  async chooseOpencodeConsoleWorkspace(sessionId: string, workspaceId: string, signal?: AbortSignal): Promise<OpencodeConsoleSessionStatus | undefined> {
    const session = this.opencodeConsoleSessions.get(sessionId);
    if (!session) return undefined;
    const offered = session.workspaces?.find((workspace) => workspace.id === workspaceId);
    if (!offered) throw new ProviderError('INVALID_REQUEST', 'That workspace was not offered for this sign-in.', { providerId: opencodeConsoleProviderId, publicMessage: 'That workspace was not offered for this sign-in.' });
    const parked = this.opencodeConsoleSessions.takeChoice(sessionId);
    if (!parked) throw new ProviderError('INVALID_REQUEST', 'This sign-in has no workspace waiting to be chosen.', { providerId: opencodeConsoleProviderId, publicMessage: 'This sign-in has no workspace waiting to be chosen.' });
    const credential = withConsoleWorkspace(parked.credential, offered);
    const orgName = credential.type === 'oauth' ? credential.orgName : undefined;
    try {
      const connection = await this.saveConnection({
        id: this.opencodeConsoleSessions.get(sessionId)?.connectionId ?? opencodeConsoleProviderId,
        providerId: opencodeConsoleProviderId,
        name: `OpenCode Console${orgName ? ` (${orgName})` : ''}`,
        endpoint: 'https://opencode.ai/inference/openai/v1',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }, credential, signal, { tolerateDiscoveryFailure: true });
      this.opencodeConsoleSessions.resolve(sessionId, { status: 'connected', connection });
    } catch (error) {
      this.opencodeConsoleSessions.resolve(sessionId, { status: 'failed', error: error instanceof Error ? error.message : 'The connection could not be saved.' });
    }
    return this.opencodeConsoleSessions.publicStatus(session);
  }

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
        if (outcome.status === 'choose') {
          this.opencodeConsoleSessions.parkForChoice(sessionId, { credential: outcome.credential, account: outcome.account }, outcome.workspaces);
          return { status: 'pending' };
        }
        return { status: 'connected', credential: outcome.credential };
      },
      connection: (credential) => {
        // `orgName` only exists on the OAuth variant, so the union is narrowed rather than read
        // blind — a blind read is a runtime failure on exactly the accounts that paid.
        const orgName = credential.type === 'oauth' ? credential.orgName : undefined;
        return {
          id: this.opencodeConsoleSessions.get(sessionId)?.connectionId ?? opencodeConsoleProviderId,
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
   * session id is how the dashboard learns the outcome; the `state` is what
   * ties the callback to this sign-in when Cline hands one back at all.
   */
  startClineSignIn(redirectUri: string, addAccount = false, targetConnectionId?: string) {
    // The session id goes in the redirect path, because the path is the one
    // part of the callback Cline has to honour verbatim.
    // The same redirect is what gets sent to the token endpoint later.
    const { sessionId, state, redirectUri: callback } = this.clineSessions.start((id) => redirectUri.replace(/\/v1\/oauth\/cline\/callback\/?$/, clineCallbackPathFor(id)), targetConnectionId ?? (addAccount ? `cline-${randomUUID().replace(/-/g, '').slice(0, 12)}` : 'cline'));
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
      /**
       * The session is resolved even when it could not be claimed. Leaving it `pending`
       * on a rejected callback made the dashboard poll a session that was never going to
       * change, so a sign-in that Cline had already refused waited out the dialog's full
       * five minutes and then reported a timeout — which named neither the refusal nor the
       * reason for it.
       */
      const message = 'This sign-in has already been used or has expired. Start again from OmniHilbras.';
      this.clineSessions.failPending(input.sessionId, message);
      return { ok: false, message };
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
      const connection = await this.connectCline({ code: input.code, redirectUri: session.redirectUri, connectionId: session.connectionId }, signal);
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
  apmixAdapter(): ProviderAdapter {
    if (!this.apmix) this.apmix = new ApmixAdapter({ transport: this.transport });
    return this.apmix;
  }

  beatapiAdapter(): ProviderAdapter {
    if (!this.beatapi) this.beatapi = new BeatApiAdapter({ transport: this.transport });
    return this.beatapi;
  }

  /**
   * One adapter per connection, because a renewal has to be written back to the account that made it.
   * A single shared adapter would renew one account's token and hand it the storage callback of whichever
   * connection happened to build it first — the drift the per-provider caches exist to avoid.
   *
   * `onTokensRefreshed` is only supplied when there is a saved connection to write to: during a first
   * save the connection does not exist yet, and the credential being renewed is about to be stored by
   * the save itself.
   */
  nousAdapter(connectionId: string): ProviderAdapter {
    const existing = this.nousAdapters.get(connectionId);
    if (existing) return existing;
    const adapter = new NousAdapter({
      transport: this.transport,
      ...(this.connectionStore
        ? { onTokensRefreshed: async (credential) => { await this.connectionStore?.set(connectionId, credential).catch(() => undefined); } }
        : {}),
    });
    this.nousAdapters.set(connectionId, adapter);
    return adapter;
  }

  opencodeGoAdapter(): ProviderAdapter {
    if (!this.opencodeGo) {
      this.opencodeGo = new ZenAdapter({ id: 'opencode-go', name: 'OpenCode Go', base: ZEN_GO_BASE_URL, transport: this.transport });
    }
    return this.opencodeGo;
  }

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
  chatGptWebAdapter(connectionId = chatGptWebProviderId): ProviderAdapter {
    const memo = this.chatGptWebAdapters.get(connectionId);
    if (memo) return memo;
    // One persistent browser profile per connection. A single shared profile meant account B's stored
    // cookies were never used when the profile was signed in as A, and "Check cookie" reported A's plan
    // for B's paste.
    const adapter = new ChatGptWebAdapter({ driver: this.options.chatGptWebDriver ?? createChatGptWebDriver(connectionId) });
    this.chatGptWebAdapters.set(connectionId, adapter);
    return adapter;
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
  async checkChatGptWeb(exported: string, signal?: AbortSignal, connectionId?: string) {
    const state = parseChatGptStorageState(exported);
    const adapter = connectionId
      ? this.chatGptWebAdapter(connectionId)
      : await this.resolveAdapter(chatGptWebProviderId, { endpoint: 'https://chatgpt.com', name: 'ChatGPT Web' });
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
   * Gemini Web, built once so the Playwright import and the browser check are not repeated per request.
   *
   * Typed as `ProviderAdapter` like ChatGPT Web's, because nothing here reaches past the interface — the
   * rotation callback is what carries a refreshed cookie back, and it is wired in.
   */
  geminiWebAdapter(connectionId = geminiWebProviderId): ProviderAdapter {
    const memo = this.geminiWebAdapters.get(connectionId);
    if (memo) return memo;
    const adapter = new GeminiWebAdapter({
      driver: this.options.geminiWebDriver ?? createGeminiWebDriver(),
      // Rotation reaches storage here, keyed by the connection whose cookie was rotated. Writing to the
      // provider id made a second account overwrite the first — or write a credential for a connection
      // that does not exist. Deliberately tolerant: a turn that produced an answer must not be reported
      // as failed because the refreshed cookie could not be written.
      onTokensRefreshed: async (merged) => {
        await this.connectionStore?.set(connectionId, { type: 'api-key', value: merged }).catch(() => undefined);
      },
    });
    this.geminiWebAdapters.set(connectionId, adapter);
    return adapter;
  }

  /** Checks a pasted Gemini cookie and stores nothing. */
  async checkGeminiWeb(raw: string, signal?: AbortSignal) {
    const cookie = normalizeGeminiWebCookie(raw);
    if (!geminiWebCookiePresent(cookie)) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'No usable Gemini cookie was pasted.', {
        providerId: geminiWebProviderId,
        publicMessage: 'Paste the value of `__Secure-1PSID`, or a whole `Cookie:` header from gemini.google.com.',
      });
    }
    const driver = this.options.geminiWebDriver ?? createGeminiWebDriver();
    // Whether a turn can be served needs a browser and a live session; whether the *page* accepts the cookie is
    // answerable now, and it is the one that says whether the pasted value is worth storing.
    if (!driver.verify) return { verified: false, note: 'This build cannot open a browser to verify the session.', models: GEMINI_WEB_MODELS.map((model) => ({ id: model.id, name: model.name })) };
    const result = await driver.verify({ cookie, ...(signal ? { signal } : {}) });
    return {
      verified: result.ok,
      ...(result.note ? { note: result.note } : {}),
      models: GEMINI_WEB_MODELS.map((model) => ({ id: model.id, name: model.name })),
    };
  }

  /**
   * Stores a Gemini Web cookie, after checking the page accepts it.
   *
   * Checked first, so a refused cookie never becomes a connection that looks connected and answers nothing.
   */
  async connectGeminiWeb(raw: string, signal?: AbortSignal, addAccount = false) {
    const cookie = normalizeGeminiWebCookie(raw);
    if (!geminiWebCookiePresent(cookie)) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'No usable Gemini cookie was pasted.', {
        providerId: geminiWebProviderId,
        publicMessage: 'Paste the value of `__Secure-1PSID`, or a whole `Cookie:` header from gemini.google.com.',
      });
    }
    const check = await this.checkGeminiWeb(cookie, signal);
    if (!check.verified) {
      throw new ProviderError('AUTHENTICATION_FAILED', check.note ?? 'The Gemini session was not accepted.', {
        providerId: geminiWebProviderId,
        publicMessage: check.note ?? 'Gemini did not accept that session. Copy fresh cookies from gemini.google.com while signed in.',
      });
    }
    return this.saveConnection(
      {
        id: addAccount ? `${geminiWebProviderId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : geminiWebProviderId,
        providerId: geminiWebProviderId,
        name: 'Gemini Web',
        endpoint: 'https://gemini.google.com',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      },
      { type: 'api-key', value: cookie },
      signal,
    );
  }

  /**
   * The Duck.ai adapter.
   *
   * One structural difference from the two browser-driven web-session providers: there is nothing external to
   * be missing. The anti-bot challenge runs in a `vm`, which is part of Node, so `available()` cannot fail and
   * the gateway needs no driver from its options to serve a turn.
   */
  duckDuckGoWebAdapter(): ProviderAdapter {
    this.duckDuckGoWeb ??= new DuckDuckGoWebAdapter({
      driver: this.options.duckDuckGoWebDriver ?? createDuckDuckGoWebDriver(),
    });
    return this.duckDuckGoWeb;
  }

  /**
   * The pasted cookie, normalised — or `undefined` when nothing was pasted.
   *
   * A paste that carries text but reads as no cookie is a **mistake** and is refused here; an empty paste is
   * this provider's normal case. Collapsing those two is how "no cookie is needed" becomes indistinguishable
   * from "the cookie you gave me is bad", which is the distinction the whole provider turns on.
   */
  private duckDuckGoWebPaste(raw: string | undefined): string | undefined {
    if (raw === undefined || raw.trim() === '') return undefined;
    const cookie = normalizeDuckDuckGoWebCookie(raw);
    if (!cookie) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'The pasted Duck.ai cookie could not be read.', {
        providerId: duckduckgoWebProviderId,
        publicMessage: 'That does not look like a cookie. Paste the whole `Cookie:` line from duck.ai, or leave the field empty — no cookie is required.',
      });
    }
    return cookie;
  }

  /**
   * Checks the endpoint and stores nothing. **The cookie is optional here too.**
   *
   * What a check can honestly establish for this provider is that the service answered and served a challenge
   * this gateway solved. It cannot establish that a cookie works, because the service does not read one — so
   * the note says which of the two happened and never claims the stronger thing.
   */
  async checkDuckDuckGoWeb(raw: string | undefined, signal?: AbortSignal) {
    const cookieHeader = this.duckDuckGoWebPaste(raw);
    const driver = this.options.duckDuckGoWebDriver ?? createDuckDuckGoWebDriver();

    let models: Array<{ id: string; name: string }> = [];
    try {
      models = freeDuckDuckGoWebModels(await driver.catalog({ ...(signal ? { signal } : {}) })).map((model) => ({ id: model.id, name: model.displayName }));
    } catch {
      // A catalog that could not be read is not a failure of the endpoint check, and reporting it as one would
      // blame the request for a listing problem.
    }

    const status = await driver.status({ ...(signal ? { signal } : {}) });
    return {
      verified: status.challengeServed,
      note: status.challengeServed
        ? cookieHeader
          ? 'Duck.ai answered and served a challenge this gateway solved. The cookie was sent; this service does not read one, so this does not prove the cookie is valid.'
          : 'Duck.ai answered and served a challenge this gateway solved. No cookie was needed.'
        : 'Duck.ai answered without serving an anti-bot challenge, so a turn cannot be proven from here.',
      models,
    };
  }

  /**
   * Stores the connection, after checking the endpoint.
   *
   * The credential is `{ type: 'none' }` when nothing was pasted, and that is a decision rather than a gap: a
   * fabricated placeholder would be a secret the vault keeps and audits as real, and *no* credential would
   * leave the connection outside routing entirely — `hasCredential` is what `RoutingEngine.plan` filters on.
   * `none` is the honest third option, and 1.86.0 is the release that made it a credential the vault can read
   * back.
   */
  async connectDuckDuckGoWeb(raw: string | undefined, signal?: AbortSignal, addAccount = false) {
    const cookieHeader = this.duckDuckGoWebPaste(raw);
    const check = await this.checkDuckDuckGoWeb(raw, signal);
    if (!check.verified) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', check.note ?? 'Duck.ai could not be reached.', {
        providerId: duckduckgoWebProviderId,
        publicMessage: check.note ?? 'Duck.ai did not answer with a solvable challenge, so no connection was saved.',
      });
    }
    return this.saveConnection(
      {
        id: addAccount ? `duckai-${randomUUID().replace(/-/g, '').slice(0, 12)}` : duckduckgoWebProviderId,
        providerId: duckduckgoWebProviderId,
        name: 'Duck.ai',
        endpoint: DUCKDUCKGO_WEB.origin,
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      },
      cookieHeader ? { type: 'api-key', value: cookieHeader } : { type: 'none' },
      signal,
    );
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
  async connectDeepSeekWeb(userToken: string, signal?: AbortSignal, addAccount = false) {
    const credential = deepSeekWebCredential(userToken);
    // Verified before the save, so a refused token never becomes a connection.
    await this.deepSeekAdapter().validateCredential(credential);
    return this.saveConnection(
      {
        id: addAccount ? `${deepseekWebProviderId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : deepseekWebProviderId,
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
   * Token Harbor Web, built once. Typed as the concrete class for the same reason as DeepSeek's:
   * both the check and the connect path depend on `validateCredential` being present, and the
   * concrete type makes that a compile error rather than a runtime one.
   */
  tokenHarborWebAdapter(): TokenHarborWebAdapter {
    this.tokenHarborWeb ??= new TokenHarborWebAdapter();
    return this.tokenHarborWeb;
  }

  /**
   * Checks a pasted Token Harbor session cookie and stores nothing.
   *
   * The check is a real read of `/api/me/profile`, which answers 401 to a session Token Harbor
   * does not recognise. That is a credential check and not a completion, and it is reported as
   * one: whether a model can answer is only known by sending a turn, which the connect path does
   * not do either.
   */
  async checkTokenHarborWeb(cookie: string, signal?: AbortSignal) {
    const credential = tokenHarborWebCredential(cookie);
    await this.tokenHarborWebAdapter().validateCredential(credential, { signal });
    return { verified: true };
  }

  /**
   * Stores a Token Harbor Web session cookie, after confirming Token Harbor accepts it.
   *
   * Verified **before** the save, so a refused cookie never becomes a connection — the same order
   * as DeepSeek Web, and the opposite of what produced a saved-but-dead connection in the past.
   *
   * `modelPolicy` follows the dialog's free-only checkbox. The adapter's catalog is a dated
   * snapshot that needs no request, and the two `:free` ids are the ones that do not bill.
   */
  async connectTokenHarborWeb(cookie: string, signal?: AbortSignal, freeOnly = false, addAccount = false) {
    const credential = tokenHarborWebCredential(cookie);
    await this.tokenHarborWebAdapter().validateCredential(credential, { signal });
    return this.saveConnection(
      {
        id: addAccount ? `${tokenHarborWebProviderId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : tokenHarborWebProviderId,
        providerId: tokenHarborWebProviderId,
        name: 'Token Harbor Web',
        endpoint: 'https://tokenharbor.ai',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: freeOnly ? 'free' : 'all',
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

  async connectChatGptWeb(exported: string, signal?: AbortSignal, freeOnly = false, addAccount = false) {
    const state = parseChatGptStorageState(exported);
    const connectionId = addAccount ? `${chatGptWebProviderId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : chatGptWebProviderId;
    // Verified before the save, like Gemini, DeepSeek and Token Harbor. Parsing accepts a revoked or
    // dead token; the page is the only authority on whether the session still works. The check uses the
    // target connection's profile, so it reads the pasted session rather than another account's.
    await this.checkChatGptWeb(exported, signal, connectionId);
    return this.saveConnection(
      {
        id: connectionId,
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
    const memo = this.kimiCodeAdapters.get(connectionId);
    if (memo) return memo;
    const adapter = new KimiCodeAdapter({
      transport: this.transport,
      // A renewal must outlive the request that triggered it, or the next request presents a
      // token Kimi has already replaced.
      onTokensRefreshed: async (credential) => {
        if (!this.connectionStore) return;
        await this.connectionStore.set(connectionId, credential).catch(() => undefined);
      },
    });
    this.kimiCodeAdapters.set(connectionId, adapter);
    return adapter;
  }

  /**
   * Kilo Code — signed in by device auth. Its token is long-lived and never refreshed, so the
   * adapter is memoised with no per-connection write-back.
   */
  kilocodeAdapter(_connectionId: string): ProviderAdapter {
    if (!this.kilocode) this.kilocode = createKiloCodeAdapter({ transport: this.transport });
    return this.kilocode;
  }

  /**
   * CodeBuddy, both regions. One adapter per connection, because a renewal must write back to the
   * connection it belongs to.
   */
  codebuddyAdapter(connectionId: string): ProviderAdapter {
    const region = codebuddyRegionFor(connectionId);
    const memo = this.codebuddyAdapters.get(connectionId);
    if (memo) return memo;
    const adapter = codebuddySignInAdapter(region, {
      transport: this.transport,
      // The token endpoint may or may not rotate the refresh token, so whatever it returns is written
      // back rather than assuming either way.
      onTokensRefreshed: async (credential) => {
        if (!this.connectionStore) return;
        await this.connectionStore.set(connectionId, credential).catch(() => undefined);
      },
    });
    this.codebuddyAdapters.set(connectionId, adapter);
    return adapter;
  }

  /**
   * MiniMax Code (both regional cards). Access tokens last about an hour and refresh tokens are
   * single-use, so a renewal writes back through `onTokensRefreshed`.
   */
  minimaxCodeAdapter(connectionId: string): ProviderAdapter {
    const siteName = connectionId.startsWith(minimaxCodeGlobalProviderId) ? 'global' : 'cn';
    const memo = this.minimaxAdapters.get(connectionId);
    if (memo) return memo;
    const adapter = createMinimaxCodeAdapter(siteName, {
      transport: this.transport,
      onTokensRefreshed: async (credential) => {
        if (!this.connectionStore) return;
        await this.connectionStore.set(connectionId, credential).catch(() => undefined);
      },
    });
    this.minimaxAdapters.set(connectionId, adapter);
    return adapter;
  }

  /**
   * Qoder — a custom device flow and a COSY-signed chat endpoint. Its token lives ~30 days and the
   * refresh endpoint refuses, so there is nothing to renew; a dead token has to be re-signed-in.
   */
  qoderAdapter(_connectionId: string): ProviderAdapter {
    if (!this.qoder) this.qoder = createQoderAdapter({ transport: this.transport, signRequest: qoderSignRequest });
    return this.qoder;
  }

  /**
   * Claude Code — the Anthropic subscription reached by OAuth, not the metered `anthropic` API key.
   *
   * A separate adapter from `anthropic` because they are separate accounts with separate billing, the
   * same reasoning as `kimi` versus `kimi-code`. Its access tokens are short-lived, so a renewal must
   * outlive the request that triggered it — hence the write-back to the vault below.
   */
  claudeCodeAdapter(connectionId: string): ClaudeCodeAdapter {
    const memo = this.claudeCodeAdapters.get(connectionId);
    if (memo) return memo;
    const adapter = new ClaudeCodeAdapter({
      transport: this.transport,
      onTokensRefreshed: async (credential) => {
        if (!this.connectionStore) return;
        await this.connectionStore.set(connectionId, credential).catch(() => undefined);
      },
    });
    this.claudeCodeAdapters.set(connectionId, adapter);
    return adapter;
  }

  codexAdapter(connectionId: string): CodexAdapter {
    return new CodexAdapter({
      clientId: this.gatewayConfig?.codex.clientId ?? '',
      ...(this.gatewayConfig?.codex.clientVersion ? { clientVersion: this.gatewayConfig.codex.clientVersion } : {}),
      transport: this.transport,
      onTokensRefreshed: async (credential) => {
        if (!this.connectionStore) return;
        await this.connectionStore.set(connectionId, credential).catch(() => undefined);
      },
    });
  }

  kiroAdapter(connectionId: string): ProviderAdapter {
    const memo = this.kiroAdapters.get(connectionId);
    if (memo) return memo;
    const adapter = new KiroAdapter({
      transport: this.transport,
      onTokensRefreshed: async (credential) => {
        if (!this.connectionStore) return;
        await this.connectionStore.set(connectionId, credential).catch(() => undefined);
      },
    });
    this.kiroAdapters.set(connectionId, adapter);
    return adapter;
  }

  /**
   * Starts a Kiro sign-in. AWS's device flow, so the user approves a code in their own
   * browser and the dashboard waits.
   */
  /**
   * Begins a Kiro sign-in.
   *
   * `addAccount` decides whether this replaces the provider's existing connection or becomes a second one.
   * Without it, every sign-in upserted `id: 'kiro'` and a second account silently overwrote the first — the
   * "I want more than one account" gap. The flag is explicit rather than automatic because re-signing-in to
   * *repair* a connection is the common case and must not leave a duplicate behind.
   */
  async startKiroSignInFlow(startUrl?: string, addAccount = false, targetConnectionId?: string) {
    return startKiroSignIn(this.kiroSessions, startUrl, addAccount, targetConnectionId);
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
  async startKiroSocialSignInFlow(provider: 'google' | 'github', addAccount = false, targetConnectionId?: string) {
    return startKiroSocialDeviceFlow(this.kiroSessions, provider, addAccount, targetConnectionId);
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
        // Both "another poll owns it" and "Kiro has not approved yet" are pending. Only a real refusal is
        // a denial; reading an un-approved poll as a denial marked every new sign-in failed.
        if (outcome === 'in-progress' || outcome.status === 'pending') return { status: 'pending' };
        if (outcome.status !== 'connected') return { status: 'denied', error: describeSignInFailure(outcome, 'The Kiro sign-in could not be completed.') };
        return { status: 'connected', credential: outcome.credential };
      },
      connection: () => ({
        // The session's target id, not the bare provider id: an "add account" sign-in reserves a fresh id,
        // and a repair sign-in targets the one it is repairing. Falling back to the provider id keeps every
        // existing caller — and every old client that never sent the flag — behaving exactly as before.
        id: this.kiroSessions.get(sessionId)?.connectionId ?? kiroProviderId,
        providerId: kiroProviderId,
        name: 'Kiro',
        endpoint: 'https://codewhisperer.us-east-1.amazonaws.com',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      }),
      save: (input, credential, withSignal) => this.saveConnection(input, credential, withSignal),
      /**
       * Taken, not read, for the reason the OpenCode Console branch above spells out.
       * This one only read it, so a Kiro discovery failure was never cleared. It stayed on
       * the service, and the next Kiro sign-in — or a later poll of the session it had been
       * left on — attached a note describing a failure that had nothing to do with it, so a
       * user with a working Kiro connection was shown an error about a request they never
       * made.
       */
      takeDiscoveryNote: () => {
        const note = this.lastDiscoveryNote;
        this.lastDiscoveryNote = undefined;
        return note;
      },
    });
  }


  opencodeConsoleAdapter(connectionId: string): ProviderAdapter {
    const memo = this.opencodeConsoleAdapters.get(connectionId);
    if (memo) return memo;
    const adapter = new OpencodeConsoleAdapter({
      transport: this.transport,
      // A renewal has to outlive the request that triggered it, or the next one
      // would present a token the Console has already replaced.
      onTokensRefreshed: async (credential) => {
        if (!this.connectionStore) return;
        await this.connectionStore.set(connectionId, credential).catch(() => undefined);
      },
    });
    this.opencodeConsoleAdapters.set(connectionId, adapter);
    return adapter;
  }

  clineAdapter(connectionId = 'cline'): ProviderAdapter {
    const memo = this.clineAdapters.get(connectionId);
    if (memo) return memo;
    const adapter = createClineAdapter({
      transport: this.transport,
      onTokensRefreshed: async (tokens) => {
        await this.connectionStore?.set(connectionId, toClineCredential(tokens));
      },
    });
    this.clineAdapters.set(connectionId, adapter);
    return adapter;
  }

  /**
   * ClinePass is the same account as Cline, reached through the same sign-in, so it carries **Cline's**
   * OAuth token rather than a key of its own. The renewal is wired back to the `cline` vault entry — the
   * one connection the two cards share — because the token it renews is that connection's.
   */
  clinepassAdapter(connectionId = 'cline'): ProviderAdapter {
    const memo = this.clinepassAdapters.get(connectionId);
    if (memo) return memo;
    const adapter = new ClinePassAdapter({
      transport: this.transport,
      onTokensRefreshed: async (tokens) => {
        await this.connectionStore?.set(connectionId, toClineCredential(tokens));
      },
    });
    this.clinepassAdapters.set(connectionId, adapter);
    return adapter;
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
   * Everything needed to rebuild this gateway, encrypted under a passphrase.
   *
   * Connections carry their decrypted credential on purpose: that is what makes the backup useful, and
   * the envelope is the only place it travels. The API-key section holds hashes, not plaintext — the
   * plaintext existed once, at creation, and a backup cannot invent it.
   */
  async exportBackup(passphrase: string) {
    const connections: Array<{ connection: Record<string, unknown>; credential: unknown }> = [];
    for (const connection of await this.connections.list()) {
      const credential = await this.secretStore.get(connection.id, connection.providerId);
      if (!credential) continue;
      const { credentialFingerprint: _fingerprint, hasCredential: _hasCredential, credentialType: _credentialType, email: _email, ...metadata } = connection as typeof connection & Record<string, unknown>;
      connections.push({ connection: metadata, credential });
    }
    const apiKeys = this.apiKeyStore?.exportState ? await this.apiKeyStore.exportState() : undefined;
    return encryptBackup({
      format: 'omnihilbras-gateway-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      connections,
      strategies: Object.fromEntries(this.providerStrategies),
      apiKeys,
    }, passphrase);
  }

  /**
   * Replaces connections, strategies and API keys with a decrypted backup.
   *
   * Replace, not merge: a backup is a snapshot of one gateway, and merging two snapshots by id leaves
   * credentials from the old machine attached to records from the new one. The caller has to say yes to
   * that; the route passes the confirmation through.
   */
  async importBackup(passphrase: string, envelope: unknown) {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'This gateway has no connection store to import into.');
    const payload = decryptBackup(envelope, passphrase) as {
      format?: unknown;
      version?: unknown;
      connections?: Array<{ connection?: Record<string, unknown>; credential?: unknown }>;
      strategies?: Record<string, unknown>;
      apiKeys?: unknown;
    };
    if (payload?.format !== 'omnihilbras-gateway-backup' || payload.version !== 1 || !Array.isArray(payload.connections)) {
      throw new ProviderError('INVALID_REQUEST', 'The backup payload is not a gateway backup.');
    }
    for (const entry of payload.connections) {
      if (!entry?.connection || typeof entry.connection.id !== 'string' || typeof entry.connection.providerId !== 'string' || !entry.credential) {
        throw new ProviderError('INVALID_REQUEST', 'The backup contains an unreadable connection.');
      }
    }
    const previous = await this.connectionStore.list();
    for (const connection of previous) await this.connectionStore.remove(connection.id);
    let imported = 0;
    for (const entry of payload.connections) {
      await this.connectionStore.save(entry.connection as never, entry.credential as never);
      imported += 1;
    }
    let strategies = 0;
    const store = this.connectionStore as { setStrategy?: (providerId: string, strategy: string) => Promise<void> };
    for (const [providerId, strategy] of Object.entries(payload.strategies ?? {})) {
      if (strategy !== 'priority' && strategy !== 'round-robin' && strategy !== 'fastest') continue;
      if (!store.setStrategy) break;
      await store.setStrategy(providerId, strategy);
      this.providerStrategies.set(providerId, strategy);
      strategies += 1;
    }
    let keys = 0;
    if (payload.apiKeys && this.apiKeyStore?.importState) {
      const state = payload.apiKeys as { keys?: unknown[] };
      await this.apiKeyStore.importState(payload.apiKeys as never);
      keys = Array.isArray(state.keys) ? state.keys.length : 0;
    }
    return { connections: imported, strategies, apiKeys: keys, removed: previous.length };
  }

  /**
   * Guards the public LLM surface. Callers that are already trusted local administration
   * surfaces (the dashboard) must not call this.
   */
  authorizePublicRequest(presentedKey: string | undefined) {
    return this.apiKeys.authorize(presentedKey);
  }

  /**
   * Records who owns a connection and what it is for.
   *
   * Deliberately does not re-validate the credential or re-read the catalog: this is a note about the
   * connection, not a change to it, and making an owner edit spend a provider request would be a cost
   * nobody expects from typing a name.
   */
  async updateConnectionResponsibility(connectionId: string, responsibility: { owner?: string; purpose?: string }) {
    return this.connections.setResponsibility(connectionId, responsibility);
  }

  /** Pauses or resumes one account. Routing reads `enabled` per request, so this takes effect at once. */
  async setConnectionEnabled(connectionId: string, enabled: boolean) {
    const updated = await this.connections.setEnabled(connectionId, enabled);
    if (!updated) throw new ProviderError('NOT_FOUND', 'That connection no longer exists.', { publicMessage: 'That connection no longer exists.' });
    return updated;
  }

  async updateConnectionResilience(connectionId: string, resilience: Partial<ResilienceSettings>) {
    return this.connections.setResilience(connectionId, resilience);
  }

  /** The connection that serves a provider: the only one, or the first enabled. */


  /**
   * The conversation a provider receives. An unanswered tool call is answered first, so the provider can accept it,
   * then a long tool result is shortened unless the client opted this request out. The order matters: the empty
   * results added in the first step are short and are left alone by the second.
   */
  private preparedMessages(request: ChatRequest, scope: RequestScope | undefined): ChatRequest['messages'] {
    const complete = completeToolRounds(request.messages);
    if (scope?.tokenSaver === false) return complete;
    const compressed = compressToolResults(complete);
    const saved = toolResultBytes(complete) - toolResultBytes(compressed);
    if (saved > 0) console.log(`[token-saver] request ${scope?.id ?? 'unscoped'} saved ${saved} bytes of tool output`);
    return compressed;
  }

  /**
   * What a connection's account has left, for a provider that meters its accounts.
   *
   * Delegated to whichever adapter the connection resolves to. This used to name one provider and
   * narrow with `instanceof`, which put a single provider's quirk into shared code and meant a second
   * metered provider would need a second branch here. A provider that does not publish a balance is
   * refused by name rather than answered with an empty quota — "publishes nothing" and "has nothing
   * left" look identical from outside and mean opposite things.
   */
  async connectionQuota(connectionId: string, signal?: AbortSignal, scope?: RequestScope): Promise<ProviderQuota> {
    const connection = (await this.connections.list()).find((entry) => entry.id === connectionId);
    if (!connection) throw new ProviderError('NOT_FOUND', 'That connection no longer exists.', { publicMessage: 'That connection no longer exists.' });
    const adapter = await this.resolveAdapter(connection.providerId, undefined, connection.id);
    if (!adapter.quota) throw notSupported(adapter, 'quota');
    return adapter.quota(await this.credentials.contextForProvider(connectionId, signal, scope));
  }

  async chat(providerId: string, request: ChatRequest, signal?: AbortSignal, scope?: RequestScope, connectionId?: string): Promise<ChatResponse> {
    const adapter = await this.resolveAdapter(providerId, undefined, connectionId);
    if (!adapter.chat || adapter.capabilities.chat !== true) throw notSupported(adapter, 'chat');
    return adapter.chat({ ...request, model: bareModelFor(this.resolvedModel(request.model), providerId), messages: this.preparedMessages(request, scope) }, await this.contextForRequest(providerId, connectionId, signal, scope));
  }

  async *streamChat(providerId: string, request: ChatRequest, signal?: AbortSignal, scope?: RequestScope, connectionId?: string): AsyncIterable<ChatChunk> {
    const adapter = await this.resolveAdapter(providerId, undefined, connectionId);
    if (!adapter.streamChat || adapter.capabilities.streaming !== true) throw notSupported(adapter, 'streaming');
    yield* adapter.streamChat({ ...request, model: bareModelFor(this.resolvedModel(request.model), providerId), messages: this.preparedMessages(request, scope) }, await this.contextForRequest(providerId, connectionId, signal, scope));
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
  async embed(providerId: string, request: EmbeddingRequest, signal?: AbortSignal, scope?: RequestScope, connectionId?: string): Promise<EmbeddingResponse> {
    const adapter = await this.resolveAdapter(providerId, undefined, connectionId);
    if (adapter.capabilities.embeddings !== true || typeof adapter.embed !== 'function') throw notSupported(adapter, 'embeddings');
    return adapter.embed({ ...request, model: bareModelFor(this.resolvedModel(request.model), providerId) }, await this.contextForRequest(providerId, connectionId, signal, scope));
  }

  /**
   * The credential and policy for the account a route selected.
   *
   * A dispatched candidate carries a connection id; reading by provider id instead is how every
   * attempt for account B was authenticated with account A's key. `unmanaged:` candidates exist for a
   * registered provider with no saved connection, so they keep the provider-id fallback that
   * `contextForProvider` owns.
   */
  private async contextForRequest(providerId: string, connectionId: string | undefined, signal?: AbortSignal, scope?: RequestScope): Promise<ProviderRequestContext> {
    if (!connectionId || connectionId.startsWith('unmanaged:')) return this.credentials.contextForProvider(providerId, signal, scope);
    const canonical = providerAlias(providerId);
    if (canonical && canonical !== providerId) {
      // A shared card's routed connection is the alias record, which deliberately holds no token of
      // its own. The credential lives on the owner's connection, and this is the one lookup that
      // follows the alias.
      const owner = await this.connections.firstWithCredentialFor(canonical);
      const context = await this.credentials.context(owner?.id ?? connectionId, providerId, signal);
      return scope ? withRequestScope(context, scope) : context;
    }
    const context = await this.credentials.context(connectionId, providerId, signal);
    return scope ? withRequestScope(context, scope) : context;
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
  startScope(requestedModel: string, explicitProviderId?: string, tokenSaver?: boolean): RequestScope {
    return startRequestScope({
      requestedModel,
      ...(explicitProviderId === undefined ? {} : { explicitProviderId }),
      ...(tokenSaver === undefined ? {} : { tokenSaver }),
    });
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

  /**
   * Probes **one saved connection**, with its own stored credential.
   *
   * `/v1/health/:providerId` answers about a provider, and a provider with several accounts has no
   * single answer — the resolver picks the first connection, so "Test provider" on the second row
   * tested the first account. This reads the credential of the connection the caller named and asks
   * its adapter to validate it, so a row tests its own account.
   */
  async probeConnection(connectionId: string, signal?: AbortSignal): Promise<GatewayConnectionValidation> {
    const connection = (await this.connections.list()).find((entry) => entry.id === connectionId);
    if (!connection) throw new ProviderError('NOT_FOUND', 'That connection no longer exists.', { publicMessage: 'That connection no longer exists.' });
    const adapter = await this.resolveAdapter(connection.providerId, undefined, connection.id);
    const context = await this.credentials.context(connectionId, connection.providerId, signal);
    const startedAt = Date.now();
    // A provider with no `validateCredential` — every generic OpenAI-compatible endpoint — still has a
    // free, authenticated read: its model list. Asking that is a real check of this account's own
    // credential, which is what the row needs; refusing to check would leave half the catalog with a
    // dead Test button.
    if (adapter.validateCredential) {
      const result = await adapter.validateCredential(context.credential, context);
      return { providerId: connection.providerId, valid: true, checkedAt: result?.checkedAt ?? new Date().toISOString(), latencyMs: result?.latencyMs ?? Date.now() - startedAt };
    }
    if (adapter.listModels) {
      await adapter.listModels(context);
      return { providerId: connection.providerId, valid: true, checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt };
    }
    throw notSupported(adapter, 'credential validation');
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
  private async resolveAdapter(providerId: string, pendingEndpoint?: { endpoint: string; name: string }, connectionId?: string): Promise<ProviderAdapter> {
    return this.providers.resolve(providerId, pendingEndpoint, () => this.listConnections(), connectionId);
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

  /** Each finished request's record, as it is written, to a listener. Returns how to stop listening. */
  onUsageRecorded(listener: (record: UsageRecord) => void): () => void {
    this.usageListeners.add(listener);
    return () => { this.usageListeners.delete(listener); };
  }

  private readonly usageListeners = new Set<(record: UsageRecord) => void>();

  /** Wraps the store so every write is also delivered to the listeners. The store itself is unchanged. */
  private publishingUsage(store: UsageStore): UsageStore {
    const listeners = this.usageListeners;
    return new Proxy(store, {
      get(target, property) {
        if (property === 'record') {
          return async (entry: Parameters<UsageStore['record']>[0]) => {
            const record = await target.record(entry);
            for (const listener of listeners) {
              try { listener(record); } catch { /* a listener must not fail the request */ }
            }
            return record;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
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
  async modelPrices(
    requests: ReadonlyArray<{ connectionId?: string; model: string }>,
  ): Promise<Array<ModelPricing | undefined>> {
    const connections = await this.connections.list();
    const byId = new Map(connections.map((connection) => [connection.id, connection]));
    return requests.map((request) => pricingFromConnection(byId.get(request.connectionId ?? ''), request.model));
  }

  async modelPrice(connectionId: string | undefined, model: string): Promise<ModelPricing | undefined> {
    if (!connectionId) return undefined;
    const record = (await this.connections.list()).find((connection) => connection.id === connectionId);
    return pricingFromConnection(record, model);
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

