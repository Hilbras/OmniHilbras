import { createHash, randomUUID } from 'node:crypto';
import { executeLocalTool, localToolRootsFromEnv } from './local-tool-executor.js';
import { readStateEventsSince } from './state-document.js';
import type { AuditStore } from './audit.js';
import type { JobStore } from './jobs.js';
import { OWN_PROVIDER_ADAPTERS } from './own-provider-adapters.js';
import { ApmixAdapter } from '@omnihilbras/sdk-apmix';
import { BeatApiAdapter } from '@omnihilbras/sdk-beatapi';
import { NousAdapter } from '@omnihilbras/sdk-nous';
import { GATEWAY_TOOL_PROVIDERS, LOCAL_TOOL_NAMES, LOCAL_TOOL_PROMPT, ToolContractError, cloakClaudeTools, gatewayToolNameMap, guardToolStream, isLocalToolName, localToolDefinitions, normalizeToolsRequest, parseNativeToolCall, parsePromptToolCall, restoreClaudeToolName, shouldCloakTools, toolCaps, validateToolCalls, withGatewayTools } from '@omnihilbras/tools';
import { ZenAdapter } from '@omnihilbras/sdk-opencode-zen';
import { OpenCodeGoAdapter } from '@omnihilbras/sdk-opencode-go';
import { ZcodeAdapter, zcodeProviderId } from '@omnihilbras/sdk-zcode-start-plan';
import { readZcodeLocalCredential, type ZcodeLocalCredential } from './zcode-local.js';
import { pollZcodeOAuth, startZcodeOAuth, type ZcodeOAuthProvider } from './zcode-oauth.js';
import { createOpencodeLocalService } from './opencode-service.js';
import { removeChatGptWebProfile } from '../providers/chatgptWeb.js';
import { ensureOpencodeService } from './opencode-runtime.js';
import { CLINE_OAUTH } from '@omnihilbras/sdk-cline';
import { FetchHttpTransport, ProviderError, completeToolRounds, compressToolResults, isPrivateHostname, isLoopbackHostname, isProviderError, toolResultBytes, type AudioSpeechRequest, type AudioSpeechResponse, type AudioTranscriptionRequest, type AudioTranscriptionResponse, type ChatChunk, type ChatMessage, type ChatRequest, type ChatResponse, type EmbeddingRequest, type EmbeddingResponse, type HttpTransport, type ImageRequest, type ImageResponse, type Model, type ModelImportPolicy, type ModelPricing, type ProviderAdapter, type ProviderCredential, type ProviderHealth, type ProviderQuota, type ProviderRegistry, type ProviderRequestContext } from './index.js';
import { narrowedToolCaps } from './modelCapabilities.js';
import { ChatGptWebAdapter, chatGptWebCredential, chatGptWebModels, isFreeChatGptPlan, parseChatGptStorageState, chatGptWebProviderId, type ChatGptWebDriver } from '@omnihilbras/sdk-chatgpt-web';
import { CLAUDE_CODE, ClaudeCodeAdapter, claudeCodeProviderId } from '@omnihilbras/sdk-claude-code';
import { CLAUDE, ClaudeAdapter, claudeProviderId } from '@omnihilbras/sdk-claude';
import { ClinePassAdapter } from '@omnihilbras/sdk-clinepass';
import { deepSeekWebCredential, deepseekWebProviderId, deepseekWebV2ProviderId, DeepSeekWebAdapter } from '@omnihilbras/sdk-deepseek-web';
import { DuckDuckGoWebAdapter, duckduckgoWebProviderId, DUCKDUCKGO_WEB, normalizeDuckDuckGoWebCookie, freeDuckDuckGoWebModels, type DuckDuckGoWebDriver } from '@omnihilbras/sdk-duckduckgo-web';
import { GeminiWebAdapter, geminiWebProviderId, GEMINI_WEB_MODELS, normalizeGeminiWebCookie, geminiWebCookiePresent, type GeminiWebDriver } from '@omnihilbras/sdk-gemini-web';
import { GrokWebAdapter, grokWebCredential, grokWebProviderId } from '@omnihilbras/sdk-grok-web';
import { PerplexityWebAdapter, perplexityWebCredential, perplexityWebProviderId } from '@omnihilbras/sdk-perplexity-web';
import { createKiloCodeAdapter } from '@omnihilbras/sdk-kilocode';
import { KIMI_CODE, KimiCodeAdapter } from '@omnihilbras/sdk-kimi-code';
import { KiroAdapter, kiroCredentialFromApiKey, kiroProviderId } from '@omnihilbras/sdk-kiro';
import { createMinimaxCodeAdapter } from '@omnihilbras/sdk-minimax-code';
import { OpencodeConsoleAdapter } from '@omnihilbras/sdk-opencode-console';
import { createQoderAdapter } from '@omnihilbras/sdk-qoder';
import { probeQwenWeb } from '@omnihilbras/sdk-qwen-web';
import { TokenHarborWebAdapter, tokenHarborWebCredential, tokenHarborWebProviderId } from '@omnihilbras/sdk-tokenharbor-web';
import { parseApiKeyState, type ApiKeyLimits, type ApiKeyRecord, type ApiKeyStore } from './api-keys.js';
import { defaultResilienceSettings, parseConnectionsBackupState, type ConnectionInput, type ConnectionRecord, type ConnectionStore, type ConnectionsBackupState, type ResilienceSettings } from './connections.js';
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
import { ClaudeSessionStore, beginClaudeSignIn, completeClaudeSignIn, type ClaudeSessionStatus } from '../providers/claude.js';
import { CodexAdapter, codexProviderId } from '@omnihilbras/sdk-codex';
import { beginCodexSignIn, CodexSessionStore, completeCodexSignIn, resolveCodexConfig, type CodexSignInStatus } from '../providers/codexOAuth.js';
import { CodexCallbackListener } from './codexCallbackListener.js';
import { OpencodeConsoleSessionStore, beginOpencodeConsoleSignIn, opencodeConsoleProviderId, pollOpencodeConsoleSignIn, withConsoleWorkspace, type OpencodeConsoleSessionStatus } from './opencodeConsole.js';
import { KiroSessionStore, importKiroRefreshToken, pollKiroSignInWithClaim, startKiroSignIn, startKiroSocialDeviceFlow, type KiroSignInStatus } from '../providers/kiro.js';
import { createChatGptWebDriver } from '../providers/chatgptWeb.js';
import { createGeminiWebDriver } from '../providers/geminiWeb.js';
import { createDuckDuckGoWebDriver } from '../providers/duckduckgoWeb.js';
import { SlidingWindowRateLimiter, bareModelFor, lookupModelId, modelCapacityCapabilities, noCandidateMessage, requiredCapabilitiesFromRequest, type CapacityAdapterConfig, type RouteCandidate, type RouteDecision } from './routing.js';
import { HealthManager } from './health.js';
import { ConnectionLatencyLedger } from './connection-latency.js';
import { ResponseCache } from './response-cache.js';
import { SemanticCache } from './semantic-cache.js';
import { WebhookDispatcher, type LocalWebhookStore, type WebhookDelivery, type WebhookEvent } from './webhooks.js';
import { batchChatRequest, type BatchItem, type BatchRecord, type BatchResult, type BatchStore } from './batches.js';
import { currentPrincipal, principalUsageFields, runWithPrincipal } from './principal.js';
import { SpendLedger } from './spend-ledger.js';
import { evaluateBudget, type Budget } from './budgets.js';
import { requestCostUsd } from './usage-pricing.js';
import { estimatePromptTokens } from './token-estimate.js';
import type { LocalGuardrailStore } from './guardrails.js';
import { parsePromptState, type LocalPromptStore } from './prompts.js';
import { spanFromUsage, type OtelExporter } from './otel.js';
import { TokenRenewal, classifyRenewalFailure } from './token-renewal.js';
import { ProviderResolver } from './provider-resolver.js';
import { completeSignIn, describeSignInFailure } from './sign-in-coordinator.js';
import { assertPublicDestination } from './destination-check.js';
import { providerHttpFetchFor, providerHttpStats as currentProviderHttpStats, type ProviderHttpStats } from './provider-http.js';
import { CredentialManager } from './credential-manager.js';
import { CredentialLifecycle } from './credential-lifecycle.js';
import { AdapterCredentialProvisioner } from './credential-provisioner.js';
import { CircuitBreaker, type BreakerConfig } from './circuit-breaker.js';
import { localDeployment, type ConnectionSecretStore, type DeploymentConfig } from './runtime.js';
import { RoutingEngine } from './routing-engine.js';
import { ModelCatalog } from './model-catalog.js';
import { TimeoutPolicy } from './timeout-policy.js';
import { parseVirtualModelState, type VirtualModel, type VirtualModelTarget, type VirtualModelStore } from './virtual-models.js';
import { parseSkillState, type SkillStore } from './skills.js';
import { parseWorkspaceState, type WorkspaceStore } from './workspaces.js';
import { parseTunnelState, type TunnelStore } from './tunnels.js';
import { parseMitmState, type MitmStore } from './mitm.js';
import { parseProxyPoolState, type ProxyPoolStore } from './proxy-pools.js';
import { parseProviderNodeState, type ProviderNodeStore } from './provider-nodes.js';
import {
  compressMessages,
  headroomCompress,
  injectCaveman,
  injectPonytail,
  MemoryCcrStore,
  pxpipeCompress,
  trimHistory,
  type CavemanLevel,
  type PonytailLevel,
  type SavableMessage,
} from '@omnihilbras/token-saver';
import { startRequestScope, withRequestScope, type RequestScope } from './request-context.js';
import { decryptBackup, encryptBackup } from './backup.js';
import { exportWebProfiles, importWebProfiles, parseWebProfilesState } from './web-profiles.js';
import { removeGeminiWebProfile } from '../providers/geminiWeb.js';
import { notSupported } from './capability.js';
import { RequestExecutor, type GatewayChatOutcome, type GatewayEmbedOutcome, type GatewayImageOutcome, type GatewayAudioOutcome, type GatewayTranscriptionOutcome, type GatewayStreamOutcome, type GatewayFailoverAttempt, type PlanRouteContext } from './request-executor.js';
import { providerAlias } from './provider-alias.js';
import { ConnectionManager } from './connection-manager.js';
import { ApiKeyManager } from './api-key-manager.js';
import { parseUsageState, type UsageRecord, type UsageStore } from './usage-store.js';
import { parseRequestDetailState, type RequestDetailInput, type RequestDetailStore } from './request-details.js';
import { modelMetaPriceOrder } from './connections.js';

/**
 * The backup format this build writes, and the versions its reader understands.
 *
 * Version 1 carried three sections — the connections, their provider strategies and the API keys. Everything
 * else an installation holds stayed behind: usage history, virtual models, skills, workspaces, tunnels,
 * proxy pools, provider nodes and the MITM policy were all absent from the file, so a restore rebuilt the
 * connections and left the rest on the machine it came from while the UI called it a success.
 *
 * Version 2 carries every file-backed store as a section named after it. Version 1 still imports: it is
 * translated into that same shape rather than served by a second apply path, because two importers are two
 * places for the question "what is a credential" to be answered differently.
 */
const backupFormat = 'omnihilbras-gateway-backup';
const backupVersion = 2;

/** A JSON object, which is the only thing an envelope's payload can be. */
function isBackupRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The one refusal every malformed payload gets, so the reader has a single answer for "not a backup". */
function notAGatewayBackup() {
  return new ProviderError('INVALID_REQUEST', 'The backup payload is not a gateway backup.', { publicMessage: 'The backup payload is not a gateway backup.' });
}

/**
 * A version-1 payload rewritten in version-2 shape.
 *
 * Version 1 held `connections` as a bare array with `strategies` beside it, and an entry's credential was
 * mandatory — which is why a keyless connection vanished on import, Ollama being the canonical one. The
 * translation carries such a connection with no credential rather than dropping the record, and the
 * `aliases` map version 1 never had arrives empty.
 */
function legacyBackupSections(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.connections)) throw notAGatewayBackup();
  return {
    connections: { connections: payload.connections, strategies: isBackupRecord(payload.strategies) ? payload.strategies : {}, aliases: {} },
    ...(payload.apiKeys === undefined ? {} : { apiKeys: payload.apiKeys }),
  };
}

/**
 * How many records a validated section holds.
 *
 * A section's records are its arrays: every backup state is one array of records beside scalar settings and
 * lookup maps. A counter written per store would be ten more places to forget when a store's shape changes,
 * and the number is only ever a sentence in the UI.
 */
function countSectionRecords(state: unknown): number {
  if (!isBackupRecord(state)) return 0;
  return Object.values(state).reduce<number>((total, value) => total + (Array.isArray(value) ? value.length : 0), 0);
}

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

/** A model allowlist entry: `*` and `?` are wildcards, everything else is literal. */
function globMatches(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
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
export type { GatewayFailoverAttempt, GatewayChatOutcome, GatewayStreamOutcome, GatewayEmbedOutcome, GatewayImageOutcome } from './request-executor.js';

/** The two video operations the gateway can ask a video-capable adapter to perform. */
export type GatewayVideoRequest =
  | { kind: 'create'; action: string; body: Record<string, unknown> }
  | { kind: 'poll'; id: string };

/** Only what the upstream actually stated: an id, an optional status, an optional completed URL. */
export type GatewayVideoJob = { id: string; status?: string; videoUrl?: string };

type VideoCapableAdapter = ProviderAdapter & {
  video?: (request: GatewayVideoRequest, context?: ProviderRequestContext) => Promise<GatewayVideoJob>;
};

/**
 * The credential surface the service needs, keyed by connection id.
 *
 * Now an alias for the named `SecretStore` rather than a `Pick` of the local connection store. The
 * `Pick` admitted only an implementation of *that* store and described its origin rather than its
 * purpose, so "could this be remote" had to be answered by reading the constructor.
 */
export type CredentialSource = ConnectionSecretStore;

export type SaverTelemetry = {
  totalTokensSaved: number;
  totalBytesSaved: number;
  savers: Record<string, {
    kind: string;
    requests: number;
    tokensSaved: number;
    bytesBefore: number;
    bytesAfter: number;
    /** Whether the saver ran or was skipped, and why. A skipped saver is still reported. */
    state?: 'ran' | 'skipped';
    detail?: string;
  }>;
};

/**
 * What the gateway did with a request's tool definitions. Counts only — no names, no schemas — so a
 * record can say "your tools were removed here" without holding any prompt content.
 */
export type ToolContractTelemetry = {
  declared: number;
  forwarded: number;
  stripped: number;
  dropped: number;
};

export type GatewayServiceOptions = {
  /** 0/undefined means no cap. Applied to every chat request before routing. */
  maxOutputTokensCap?: number;
  /** 0/undefined means no cap. Applied to adapters that take a thinking budget. */
  thinkingBudgetCap?: number;
  /** Total bytes the tool definitions of one request may occupy. Absent means the Tools package default. */
  toolSchemaBytes?: number;
  /** Threshold history trimming. Runs after content compression, before dispatch. */
  historyTrim?: { maxInputTokens: number; keepRecent: number };
  /** Re-anchor provider cache breakpoints on the final body. Anthropic-shaped adapters honour it. */
  cacheAnchor?: boolean;
  /** Output-shaping prompt, appended to the system message. */
  caveman?: { level: CavemanLevel };
  ponytail?: { level: PonytailLevel };
  /** Optional external compressor. Failures leave the conversation untouched. */
  headroom?: { url: string; timeoutMs?: number; compressUserMessages?: boolean };
  /** Optional Anthropic-only image-context hook. Failures leave the conversation untouched. */
  pxpipe?: { url: string; timeoutMs?: number; minChars?: number };
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
  /** Optional durable audit trail. Absent means the gateway records no management-write audit. */
  auditStore?: AuditStore;
  /** Optional durable history of background passes. */
  jobStore?: JobStore;
  /**
   * Where per-request records go. **Optional, and absent by default.**
   *
   * A caller that wants usage passes a store; a caller that does not, gets nothing written. That is
   * deliberate: a default store would mean every existing test and every embedding silently started
   * accumulating records, and "records nothing" would stop being a state anyone chose.
   */
  usageStore?: UsageStore;
  /**
   * Durable spend, when wired. Absent means budgets have nothing to read, and a key that carries a
   * budget is refused rather than being treated as unlimited — a guardrail that silently does
   * nothing is the failure this field exists to prevent.
   */
  spendLedger?: SpendLedger;
  /** Opt-in guardrail policy. Absent means no policy is evaluated. */
  guardrails?: LocalGuardrailStore;
  /** Opt-in OTLP exporter. Absent means no spans are exported. */
  otel?: OtelExporter;
  /** Replaces the default 30-second exact cache (direct service calls only; client requests are never deduplicated). */
  responseCache?: ResponseCache;
  /** Opt-in similarity cache for direct service calls. */
  semanticCache?: SemanticCache;
  /** Opt-in webhook registry. */
  webhooks?: LocalWebhookStore;
  /** Allow a deliberately local webhook receiver. Off by default because a webhook is an SSRF surface. */
  webhookAllowLocal?: boolean;
  /** Opt-in batch store. */
  batches?: BatchStore;
  /** Opt-in prompt registry. */
  prompts?: LocalPromptStore;
  /**
   * Optional request-detail store. **Off by default**: usage records deliberately hold no content,
   * and a detail store is a separate, opt-in trade of disk for diagnostics. See `request-details.ts`.
   */
  requestDetails?: RequestDetailStore;
  /**
   * Per-connection breaker policy. Absent means `defaultBreakerConfig` — four consecutive failures, then fifteen
   * seconds, doubling to five minutes.
   */
  breaker?: BreakerConfig;
  /** Virtual models, when this gateway is wired with persistence. Absent means concrete routing only. */
  virtualModels?: VirtualModelStore;
  /**
   * Explicit fallback pools for hard input capabilities. Absent means no substitution: a request that
   * needs a capability no planned model declares is refused rather than sent to a guessed one.
   */
  capacityAdapter?: CapacityAdapterConfig;
  /** Explicit System One endpoints by connection id (or provider id as a fallback). */
  systemOne?: { endpoints: Record<string, string>; headers?: Record<string, string> };
  /** Workspaces, when wired. */
  workspaces?: WorkspaceStore;
  /** Tunnels, when wired. */
  tunnels?: TunnelStore;
  /** MITM, when wired. */
  mitm?: MitmStore;
  /** Proxy pools, when wired. */
  proxyPools?: ProxyPoolStore;
  /** Provider nodes, when wired. */
  providerNodes?: ProviderNodeStore;
  /** Skills, when this gateway is wired with persistence. Absent means no skills surface. */
  skills?: SkillStore;
  /** Consecutive failures before a connection stops receiving traffic. */
  failureThreshold?: number;
  /** How long an ejected connection waits before one probe request. */
  recoveryCooldownMs?: number;
  /** Injectable clock for the rate limiter and recovery cooldown. */
  now?: () => number;
  /** Opt-in standalone context compression. Absent means the legacy tool-result shortener only. */
  tokenSaver?: {
    enabled: boolean;
    targetRatio: number;
    protectRecent: number;
    compressUsers: boolean;
    compressCode: boolean;
    reversible: boolean;
    ccrLimit: number;
  };
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
  /**
   * Tool-contract decisions by request id, read by the route when it writes a usage record. Kept here
   * rather than on `RequestScope`, which is deliberately frozen; bounded because a process may serve
   * far more requests than it keeps records.
   */
  private readonly toolContractNotes = new Map<string, ToolContractTelemetry>();
  /** Tokens dispatched in the current minute, per key. Fixed window, reset lazily on read. */
  private readonly tokenWindows = new Map<string, { start: number; tokens: number }>();
  /** Returned calls the gateway refused to forward, keyed by the same request scope as the tool contract. */
  private readonly blockedCallNotes = new Map<string, number>();
  /** Absent means the gateway records nothing; see `GatewayServiceOptions.usageStore`. */
  private readonly usageStore?: UsageStore;
  private readonly spendLedger?: SpendLedger;
  private readonly guardrailStore?: LocalGuardrailStore;
  private readonly otelExporter?: OtelExporter;
  private readonly responseCache: ResponseCache;
  private readonly semanticCache?: SemanticCache;
  private readonly webhookStore?: LocalWebhookStore;
  private readonly webhookDispatcher?: WebhookDispatcher;
  private readonly batchStore?: BatchStore;
  private readonly promptStore?: LocalPromptStore;
  private readonly batchControllers = new Map<string, AbortController>();
  /** Budget alerts already sent, so a refused request does not send one per retry. */
  private readonly budgetAlerts = new Set<string>();
  /** Budget gate outcomes, for /metrics. Counters only; per-key labels would be unbounded. */
  private readonly budgetCounters = { checks: 0, usdRefusals: 0, tokenRefusals: 0, policyRefusals: 0 };
  private readonly requestDetails?: RequestDetailStore;
  private readonly virtualModelStore?: VirtualModelStore;
  private readonly workspaceStore?: WorkspaceStore;
  private readonly tunnelStore?: TunnelStore;
  private readonly mitmStore?: MitmStore;
  private readonly proxyPoolStore?: ProxyPoolStore;
  private readonly providerNodeStore?: ProviderNodeStore;
  private readonly skillStore?: SkillStore;
  /** Round-robin position per virtual model; incremented only when a virtual model is routed. */
  private readonly virtualRotation = new Map<string, number>();
  /** Smart-router choice per (virtual id, conversation), so a sticky answer costs one router turn. */
  private readonly smartStickyChoices = new Map<string, string>();
  /** The fingerprints of the last 500 conversations, bounded so a long-lived gateway cannot grow forever. */
  private readonly smartStickyOrder: string[] = [];
  private readonly gatewayConfig: GatewayConfig | undefined;
  private readonly auditStore?: AuditStore;
  private readonly jobStore?: JobStore;
  private readonly tokenSaverConfig?: NonNullable<GatewayServiceOptions['tokenSaver']>;
  private readonly tokenSaverStore?: MemoryCcrStore;
  private readonly maxOutputTokensCap?: number;
  private readonly thinkingBudgetCap?: number;
  private readonly toolSchemaBytes?: number;
  private readonly historyTrim?: { maxInputTokens: number; keepRecent: number };
  private readonly cacheAnchor?: boolean;
  private readonly caveman?: { level: CavemanLevel };
  private readonly ponytail?: { level: PonytailLevel };
  private readonly headroom?: { url: string; timeoutMs?: number; compressUserMessages?: boolean };
  private readonly pxpipe?: { url: string; timeoutMs?: number; minChars?: number };
  private readonly compressionTelemetry = new Map<string, SaverTelemetry>();
  private readonly compressionCache = new Map<string, { messages: ChatRequest['messages']; telemetry?: SaverTelemetry; signature: string }>();
  /** In-flight requests by saved account, for `maxConcurrentRequests`. */
  private readonly inFlight = new Map<string, number>();
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
  private readonly claudeSessions = new ClaudeSessionStore();
  /** Built on demand per connection, so signing in is what constructs it. */
  private readonly claudeAdapters = new Map<string, ClaudeAdapter>();
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
  private deepSeekV2?: DeepSeekWebAdapter;
  private tokenHarborWeb?: TokenHarborWebAdapter;
  private grokWeb?: GrokWebAdapter;
  private perplexityWeb?: PerplexityWebAdapter;
  /**
   * ZCode Start Plan adapters, **one per connection**.
   *
   * This was a single adapter for the whole provider, built once and reused, on the reasoning that its
   * device id and transport should be shared. But the adapter holds per-**account** state — `deviceId`
   * and `accountUuid`, which `setLocalIdentity` overwrites — so with two accounts of the provider the
   * last sign-in silently replaced the identity for both. A request routed to account A then carried
   * account B's ids, and Start Plan meter quota per account: the refusal was account B's balance
   * reported against account A, and the second account was never reached. Every other multi-account
   * provider here is memoised by connection id for exactly this reason.
   */
  private readonly zcodeAdapters = new Map<string, ZcodeAdapter>();
  /** The local ZCode store, read once. Its token is never returned to a browser. */
  private zcodeLocal?: ZcodeLocalCredential;
  /**
   * In-flight standalone sign-ins, keyed by the server's flow id. The poll token never leaves the gateway.
   *
   * `completion` and `connection` exist for the poll race: the dialog polls every second, and a second
   * poll arriving while the first is still proving its turn must wait for that same completion rather
   * than see a missing flow. `connection` also keeps a late poll answering `ready` after the flow is done.
   */
  private readonly zcodeFlows = new Map<string, {
    provider: ZcodeOAuthProvider;
    /** Whether this sign-in is adding a second account rather than repairing the first. */
    addAccount: boolean;
    /**
     * The row this sign-in repairs, when the dashboard asked to reconnect one.
     *
     * Absent means the flow decides — the provider's own connection, or a fresh id for a second account. ZCode
     * was the last sign-in without this, so reconnecting an account saved a duplicate beside it.
     */
    targetConnectionId?: string;
    pollToken: string;
    expiresAt: number;
    pollIntervalSec: number;
    completion?: Promise<{ status: 'ready'; connection: ConnectionRecord } | { status: 'failed'; message: string }>;
    connection?: ConnectionRecord;
  }>();
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
  private readonly breakers: CircuitBreaker;
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
  private readonly stickyConnections = new Map<string, { connectionId: string; until: number }>();
  private readonly stickyTtlMs = 5 * 60 * 1000;
  /**
   * Identical requests already in flight, keyed the same way as the response cache.
   *
   * The cache only helps a request that arrives *after* the first one finished; a burst of identical
   * requests all miss it, all reach the provider, and all pay the same latency (and the same bill).
   * This makes the later ones wait for the first instead of duplicating it. Only requests that are
   * cacheable in the first place are coalesced, so a streaming or pinned request is never shared.
   */
  private readonly inflightChats = new Map<string, Promise<GatewayChatOutcome>>();
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
  /** Opt-in roots for gateway-local read-only tools; empty by default, so no provider sees one. */
  private readonly localToolRoots = localToolRootsFromEnv();
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
    this.spendLedger = options.spendLedger;
    this.guardrailStore = options.guardrails;
    this.otelExporter = options.otel;
    this.responseCache = options.responseCache ?? new ResponseCache({ ttlMs: 30_000 });
    this.semanticCache = options.semanticCache;
    this.webhookStore = options.webhooks;
    this.webhookDispatcher = options.webhooks ? new WebhookDispatcher({ store: options.webhooks, allowLocal: options.webhookAllowLocal === true }) : undefined;
    this.batchStore = options.batches;
    this.promptStore = options.prompts;
    this.usageStore = options.usageStore ? this.publishingUsage(options.usageStore) : undefined;
    this.requestDetails = options.requestDetails;
    this.virtualModelStore = options.virtualModels;
    this.workspaceStore = options.workspaces;
    this.tunnelStore = options.tunnels;
    this.mitmStore = options.mitm;
    this.proxyPoolStore = options.proxyPools;
    this.providerNodeStore = options.providerNodes;
    this.skillStore = options.skills;
    this.gatewayConfig = options.config;
    this.auditStore = options.auditStore;
    this.jobStore = options.jobStore;
    this.tokenSaverConfig = options.tokenSaver?.enabled ? options.tokenSaver : undefined;
    this.historyTrim = options.historyTrim && options.historyTrim.maxInputTokens > 0 ? options.historyTrim : undefined;
    // History trimming needs the retrieval store even when content compression is off: a trimmed turn
    // that cannot be recovered is a dropped turn.
    this.tokenSaverStore = this.tokenSaverConfig
      ? new MemoryCcrStore(this.tokenSaverConfig.ccrLimit)
      : this.historyTrim
        ? new MemoryCcrStore(500)
        : undefined;
    this.maxOutputTokensCap = options.maxOutputTokensCap && options.maxOutputTokensCap > 0 ? options.maxOutputTokensCap : undefined;
    this.thinkingBudgetCap = options.thinkingBudgetCap && options.thinkingBudgetCap > 0 ? options.thinkingBudgetCap : undefined;
    this.toolSchemaBytes = options.toolSchemaBytes ?? options.config?.toolSchemaBytes;
    this.cacheAnchor = options.cacheAnchor === true;
    this.caveman = options.caveman;
    this.ponytail = options.ponytail;
    this.headroom = options.headroom;
    this.pxpipe = options.pxpipe;
    // Kept, not just read: the ChatGPT Web driver is built lazily on first use, long after
    // the constructor has returned, so the override has to outlive this call.
    this.options = options;
    /**
     * One transport, carrying the configured timeouts.
     *
     * It used to be built with neither `timeoutMs` nor `streamIdleTimeoutMs`, so it fell back to the
     * SDK's 30 s default for both — while the request executor's own deadline came from the
     * connection (120 s by default). The transport therefore aborted a slow reasoning turn at 30 s
     * with `CANCELLED`, before the executor's deadline was anywhere near. This is the transport the
     * on-demand adapters use, and the resolver hands it to the generic OpenAI-compatible adapter too,
     * which is the one a plain `provider/model` call reaches.
     */
    this.transport = options.transport ?? new FetchHttpTransport({
      ...(options.config ? {
        timeoutMs: options.config.timeoutMs,
        streamIdleTimeoutMs: options.config.streamIdleTimeoutMs,
        maxStreamDurationMs: options.config.maxStreamDurationMs,
      } : {}),
      checkDestination: assertPublicDestination,
      // The gateway owns one connection pool, shared by every adapter on this transport. The SDK's
      // own default stays fetch-based, because it is also bundled into a browser.
      fetch: providerHttpFetchFor(),
    });
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
      noteDiscoveryFailure: (error) => { this.lastDiscoveryNote = isProviderError(error) ? providerSaid(error) : error instanceof Error ? error.message : undefined; },
      // A service built without a store has nothing to fingerprint against, and no save will reach
      // here; the empty string simply never matches a stored fingerprint.
      credentialFingerprint: (providerId, credential) => this.connectionStore?.credentialFingerprint(providerId, credential) ?? Promise.resolve(''),
      canonicalProviderId: (providerId) => providerAlias(providerId) ?? providerId,
    });
    /**
     * The one place an expired credential is handled before it is sent.
     *
     * Without this the flow was: send a token the credential itself said had ended, have the provider refuse it, and
     * report the provider's words as a provider error — which is the one message that does not tell the operator they
     * have to sign in again. `CredentialLifecycle.expiredRefusal` existed for exactly this and was called from nowhere.
     *
     * Three outcomes, and the middle one is the point:
     *
     * - not expired, or the adapter cannot say → hand it over unchanged and let the provider answer;
     * - expired and the adapter can renew → renew, store what it returned, and use that;
     * - expired and renewal did not produce a credential → refuse with the date, in the words that name the fix.
     *
     * `renew` is tried once per request, not in a loop: a refresh the provider has already refused is not made more
     * likely to work by asking again, and an expired token retried is a request the user waits for twice.
     */
    /**
     * The per-connection breaker. Configurable because the useful threshold depends on the app: a gateway whose routes
     * have four retries each wants to stop before the fourth, and a test proving that needs two.
     */
    this.breakers = new CircuitBreaker(options.breaker);
    this.credentials = new CredentialManager(this.secretStore, this.connections, async (connectionId, providerId, credential, { refuseWhenExpired }) => {
      if (credential.type !== 'oauth' || typeof credential.expiresAt !== 'string') return credential;
      const expiry = Date.parse(credential.expiresAt);
      if (!Number.isFinite(expiry)) return credential;
      const adapter = await this.resolveAdapter(providerId, undefined, connectionId).catch(() => undefined);
      // An adapter that can answer precisely is believed over the raw date, because it knows its own lead time.
      const expired = adapter?.isCredentialExpired ? adapter.isCredentialExpired(credential, now()) : expiry <= now();
      if (expired !== true) return credential;
      if (adapter?.renewCredential) {
        try {
          const renewed = await adapter.renewCredential(credential);
          if (renewed) {
            await this.connectionStore?.set(connectionId, renewed).catch(() => undefined);
            return renewed;
          }
        } catch {
          // Swallowed on purpose: the refusal below is what the operator needs, and it names the expiry.
        }
      }
      if (refuseWhenExpired) throw this.credentialLifecycle.expiredRefusal(providerId, { state: 'expired', expiresAt: credential.expiresAt });
      // A probe asks "what is this credential", not "give me a usable one": the stale value is the answer it needs.
      return credential;
    });
    this.routing = new RoutingEngine({
      health: { getFailureThreshold: () => this.healthManager.getFailureThreshold(), registry: () => this.healthManager.snapshotRegistry() },
      rateLimiter: this.rateLimiter,
      defaultProviderId,
      requireAdapter: (providerId) => { this.requireAdapter(providerId); },
      aliasFor: (name) => this.aliasSnapshot.get(name),
      familyOf: (providerId) => this.registry.get(providerId)?.modelFamily,
      strategyFor: (providerId) => this.providerStrategies.get(providerId) ?? 'priority',
      latencyFor: (connectionId) => this.connectionLatency.get(connectionId),
      stickyFor: (model) => {
        const entry = this.stickyConnections.get(model);
        if (!entry) return undefined;
        if (Date.now() > entry.until) { this.stickyConnections.delete(model); return undefined; }
        return entry.connectionId;
      },
      ...(this.options.capacityAdapter ? { capacityAdapter: this.options.capacityAdapter } : {}),
      // The catalog is the only source of per-model capability facts; the engine asks rather than
      // reading the connection store itself, so it stays a pureRouting decision over given records.
      capabilitiesFor: (connection, modelId) => modelCapacityCapabilities(connection, modelId),
    });
    this.models = new ModelCatalog({
      connections: this.connections,
      credentials: this.credentials,
      resolveAdapter: (providerId, pendingEndpoint) => this.resolveAdapter(providerId, pendingEndpoint),
      activeAdapters: () => this.activeAdapters(),
      defaultProviderId,
      ...(this.virtualModelStore === undefined ? {} : { virtualModels: this.virtualModelStore }),
    });
    this.timeouts = new TimeoutPolicy();
    this.requests = new RequestExecutor({
      planRoute: (model, explicitProviderId, explicitConnectionId, context) => this.planRoute(model, explicitProviderId, explicitConnectionId, context),
      afterPlan: () => this.testAfterPlan?.(),
      chat: (providerId, request, signal, scope, connectionId) => this.chat(providerId, request, signal, scope, connectionId),
      streamChat: (providerId, request, signal, scope, connectionId) => this.streamChat(providerId, request, signal, scope, connectionId),
      embed: (providerId, request, signal, scope, connectionId) => this.embed(providerId, request, signal, scope, connectionId),
      image: (providerId, request, signal, scope, connectionId) => this.image(providerId, request, signal, scope, connectionId),
      audio: (providerId, request, signal, scope, connectionId) => this.audio(providerId, request, signal, scope, connectionId),
      transcribe: (providerId, request, signal, scope, connectionId) => this.transcribe(providerId, request, signal, scope, connectionId),
      withDeadline: (signal, timeoutMs, providerId, run) => this.withDeadline(signal, timeoutMs, providerId, run),
      enforceRateLimit: (candidate) => this.enforceRateLimit(candidate),
      breaker: {
        allows: (connectionId) => this.breakers.allows(connectionId),
        recordSuccess: (connectionId) => this.breakers.recordSuccess(connectionId),
        recordFailure: (connectionId) => { this.breakers.recordFailure(connectionId); },
        recordAbandoned: (connectionId) => { this.breakers.recordAbandoned(connectionId); },
      },
      recordSuccess: (providerId, latencyMs, at, connectionId) => {
        this.healthManager.recordSuccess(providerId, latencyMs, at, connectionId);
        if (connectionId && !connectionId.startsWith('unmanaged:')) this.connectionLatency.record(connectionId, latencyMs);
      },
      recordSticky: (model, connectionId) => {
        this.stickyConnections.set(model, { connectionId, until: Date.now() + this.stickyTtlMs });
      },
      recordFailure: (providerId, code, reason, connectionId) => this.healthManager.recordFailure(providerId, code, reason, connectionId),
      recordModelRateLimit: (providerId, modelId, input, connectionId) => this.healthManager.recordModelRateLimit(providerId, modelId, input, connectionId),
      clearModelCooldown: (providerId, modelId, connectionId) => this.healthManager.clearModelCooldown(providerId, modelId, connectionId),
      recordRateLimitUse: (connectionId) => this.rateLimiter.record(connectionId),
      recordUsage: (connectionId) => { void this.connectionStore?.recordUsage(connectionId).catch(() => undefined); },
    });
    // `validation` answers one question: what may the Check button prove about a *candidate* key.
    // A browser-based or device-flow sign-in is its own proof and declares `none` — running its
    // validator here would open a browser or re-check a grant the provider already approved.
    let resolver = new ProviderResolver(registry, this.transport)
      .onDemand('cline', ({ connection }) => this.clineAdapter(connection?.id ?? 'cline'), { validateOnSave: true, validation: 'credential' })
      // No `validateOnSave`. The exchange has already proved the grant, and the inherited check reads
      // the account endpoint — which says nothing about the tier and is one more way for a completed
      // sign-in to be reported as a failure. Discovery imports the tier with a tolerated failure, as
      // every other OAuth flow does.
      .onDemand('clinepass', ({ connection }) => this.clinepassAdapter(connection?.id ?? 'clinepass'), { validation: 'none' })
      .onDemand('apmix', () => this.apmixAdapter(), { validation: 'none' })
      .onDemand('beatapi', () => this.beatapiAdapter(), { validation: 'none' })
      // `validateOnSave`: Nous publishes its model catalog unauthenticated, so a save that only read
      // the catalog would accept any string as a key. The adapter proves it with one 1-token inference.
      .onDemand('nous', ({ providerId, connection }) => this.nousAdapter(connection?.id ?? providerId), { validateOnSave: true, validation: 'credential' })
      .onDemand('opencode', () => this.zenAdapter(), { validation: 'credential' })
      // OpenCode Go is the same wire on the subscription lane (`/zen/go`), so it is the same adapter with
      // a different base and id. `validateOnSave`: both lanes judge a key — measured on Zen, where the
      // listing answers 401 for a bad one — so a save proves it rather than trusting it.
      .onDemand('opencode-go', () => this.opencodeGoAdapter(), { validateOnSave: true, validation: 'credential' })
      .onDemand(opencodeConsoleProviderId, ({ providerId, connection }) => this.opencodeConsoleAdapter(connection?.id ?? providerId), { validation: 'credential' })
      .onDemand(kimiCodeProviderId, ({ providerId, connection }) => this.kimiCodeAdapter(connection?.id ?? providerId), { validation: 'none' })
      .onDemand(claudeCodeProviderId, ({ providerId, connection }) => this.claudeCodeAdapter(connection?.id ?? providerId), { validation: 'none' })
      .onDemand(claudeProviderId, ({ providerId, connection }) => this.claudeAdapter(connection?.id ?? providerId), { validation: 'none' })
      .onDemand(codexProviderId, ({ providerId, connection }) => this.codexAdapter(connection?.id ?? providerId), { validation: 'credential' })
      .onDemand(kiroProviderId, ({ providerId, connection }) => this.kiroAdapter(connection?.id ?? providerId), { validation: 'credential' })
      .onDemand(kilocodeProviderId, ({ providerId, connection }) => this.kilocodeAdapter(connection?.id ?? providerId), { validation: 'none' })
      // **No `validateOnSave`.** It was added in 3.70.0 and is the reason both MiniMax sign-ins ended
      // at "Sign-in did not finish": the device flow completed, then the pre-flight probe read the
      // agent host's catalog — which is not what the sign-in proved — and any refusal there discarded
      // a grant the provider had just approved. The token exchange is the proof. Discovery still reads
      // the catalog afterwards, with a tolerated failure, so a slow catalog cannot lose a real session.
      .onDemand(minimaxCodeProviderId, ({ providerId, connection }) => this.minimaxCodeAdapter(connection?.id ?? providerId), { validation: 'none' })
      .onDemand(minimaxCodeGlobalProviderId, ({ providerId, connection }) => this.minimaxCodeAdapter(connection?.id ?? providerId), { validation: 'none' })
      .onDemand(codebuddyCnProviderId, ({ providerId, connection }) => this.codebuddyAdapter(connection?.id ?? providerId), { validation: 'none' })
      .onDemand(codebuddyIntlProviderId, ({ providerId, connection }) => this.codebuddyAdapter(connection?.id ?? providerId), { validation: 'none' })
      .onDemand(qoderProviderId, ({ providerId, connection }) => this.qoderAdapter(connection?.id ?? providerId), { validation: 'none' })
      // Browser-backed sessions declare `none`: their validators open a browser, so a Check on an
      // unsaved cookie would launch one and report an unrelated network result as a key verdict.
      .onDemand(chatGptWebProviderId, ({ providerId, connection }) => this.chatGptWebAdapter(connection?.id ?? providerId), { validation: 'none' })
      .onDemand(geminiWebProviderId, ({ providerId, connection }) => this.geminiWebAdapter(connection?.id ?? providerId), { validation: 'none' })
      .onDemand(duckduckgoWebProviderId, () => this.duckDuckGoWebAdapter(), { validation: 'none' })
      .onDemand(deepseekWebProviderId, () => this.deepSeekAdapter(), { validation: 'none' })
      .onDemand(deepseekWebV2ProviderId, () => this.deepSeekV2Adapter(), { validation: 'none' })
      .onDemand(tokenHarborWebProviderId, () => this.tokenHarborWebAdapter(), { validation: 'credential' })
      .onDemand(grokWebProviderId, () => this.grokWebAdapter(), { validation: 'none' })
      .onDemand(perplexityWebProviderId, () => this.perplexityWebAdapter(), { validation: 'none' })
      .onDemand(zcodeProviderId, ({ providerId, connection }) => this.zcodeAdapter(connection?.id ?? providerId), { validation: 'credential' });
    // Every provider id owns its adapter. These rows are the 24 ids that previously existed only as a
    // dashboard card plus a shared OpenAI-compatible endpoint; their base URL and id now live in their own package.
    // Each row names its adapter literal because the provider-card guards read registrations from
    // source. What changed is that every row now passes `this.transport`: 24 of them used to fall
    // back to the SDK's 30 s default and lose a slow reasoning turn before the gateway's deadline.
    // The validation strategy comes from the same table as the factory, so it cannot disagree.
    const own = (id: string) => {
      const entry = OWN_PROVIDER_ADAPTERS[id]!;
      return {
        factory: ({ connection }: { connection?: { id: string; endpoint?: string; name?: string } }) => entry.create({
          transport: this.transport,
          ...(connection?.endpoint ? { endpoint: connection.endpoint } : {}),
        }),
        validation: entry.validation,
      };
    };
    resolver = resolver.onDemand('agnes-ai', own('agnes-ai').factory, { validation: own('agnes-ai').validation });
    resolver = resolver.onDemand('agentrouter', own('agentrouter').factory, { validation: own('agentrouter').validation });
    resolver = resolver.onDemand('aion-labs', own('aion-labs').factory, { validateOnSave: true, validation: own('aion-labs').validation });
    resolver = resolver.onDemand('100milionseek', own('100milionseek').factory, { validation: own('100milionseek').validation });
    resolver = resolver.onDemand('numes', own('numes').factory, { validation: own('numes').validation });
    resolver = resolver.onDemand('kiraai', own('kiraai').factory, { validation: own('kiraai').validation });
    resolver = resolver.onDemand('vengetic', own('vengetic').factory, { validation: own('vengetic').validation });
    resolver = resolver.onDemand('anyrouter', own('anyrouter').factory, { validation: own('anyrouter').validation });
    resolver = resolver.onDemand('zro', own('zro').factory, { validation: own('zro').validation });
    resolver = resolver.onDemand('unorouter', own('unorouter').factory, { validation: own('unorouter').validation });
    resolver = resolver.onDemand('ollama', own('ollama').factory, { validation: own('ollama').validation });
    resolver = resolver.onDemand('mistral', own('mistral').factory, { validation: own('mistral').validation });
    resolver = resolver.onDemand('nara-router', own('nara-router').factory, { validation: own('nara-router').validation });
    resolver = resolver.onDemand('tokenharbor', own('tokenharbor').factory, { validation: own('tokenharbor').validation });
    resolver = resolver.onDemand('tokenrouter', own('tokenrouter').factory, { validation: own('tokenrouter').validation });
    resolver = resolver.onDemand('apinex', own('apinex').factory, { validation: own('apinex').validation });
    resolver = resolver.onDemand('tiarina', own('tiarina').factory, { validation: own('tiarina').validation });
    resolver = resolver.onDemand('xkiro', own('xkiro').factory, { validation: own('xkiro').validation });
    resolver = resolver.onDemand('kimi', own('kimi').factory, { validation: own('kimi').validation });
    resolver = resolver.onDemand('deepseek', own('deepseek').factory, { validation: own('deepseek').validation });
    resolver = resolver.onDemand('qwen', own('qwen').factory, { validation: own('qwen').validation });
    resolver = resolver.onDemand('qwen-token-plan', own('qwen-token-plan').factory, { validation: own('qwen-token-plan').validation });
    resolver = resolver.onDemand('groq', own('groq').factory, { validation: own('groq').validation });
    resolver = resolver.onDemand('grok', own('grok').factory, { validation: own('grok').validation });
    resolver = resolver.onDemand('nvidia', own('nvidia').factory, { validateOnSave: true, validation: own('nvidia').validation });
    resolver = resolver.onDemand('coarena', own('coarena').factory, { validation: own('coarena').validation });
    // Keyed routers served by the shared OpenAI-compatible adapter, with no dedicated SDK package.
    resolver = resolver.onDemand('together', own('together').factory, { validation: own('together').validation });
    resolver = resolver.onDemand('fireworks', own('fireworks').factory, { validation: own('fireworks').validation });
    // Cycle-4's five API-key routers: each id resolves to its own base URL and its own `none`
    // validation decision from OWN_PROVIDER_ADAPTERS. No key is checked against a public catalog and
    // no OAuth or client-identity lane is claimed for any of them. Written as five literal rows because
    // the provider-card guards read registrations from source; a loop would hide every id from them.
    resolver = resolver.onDemand('sambanova', own('sambanova').factory, { validation: own('sambanova').validation });
    resolver = resolver.onDemand('cerebras', own('cerebras').factory, { validation: own('cerebras').validation });
    resolver = resolver.onDemand('siliconflow', own('siliconflow').factory, { validation: own('siliconflow').validation });
    resolver = resolver.onDemand('nebius', own('nebius').factory, { validation: own('nebius').validation });
    resolver = resolver.onDemand('perplexity', own('perplexity').factory, { validation: own('perplexity').validation });
    // Cycle 5 adds one keyed router: glm. Its own paid Z.ai coding-plan key and base URL, with the
    // `none` validation decision read from OWN_PROVIDER_ADAPTERS; no CLI identity or OAuth flow.
    resolver = resolver.onDemand('glm', own('glm').factory, { validation: own('glm').validation });
    // Cycle 6 adds the mainland sibling: a second keyed router, not a second name for glm's Z.ai key.
    // The `none` decision is read from OWN_PROVIDER_ADAPTERS beside the BigModel factory.
    resolver = resolver.onDemand('glm-cn', own('glm-cn').factory, { validation: own('glm-cn').validation });
    // Cycle 7's keyed router: its chat path is the published endpoint itself, and the `none`
    // validation decision is read from OWN_PROVIDER_ADAPTERS beside the mimo-free factory.
    resolver = resolver.onDemand('mimo-free', own('mimo-free').factory, { validation: own('mimo-free').validation });
    // xAI is its own connection, not a second name for Grok's saved key. Its chat surface is the
    // OpenAI wire; video generation is a real adapter on the v1 video routes, not a simulated lane.
    // ("v1 video routes" is spelled out rather than as a path ending in slash-star: a source-text guard
    // strips block comments first, and a literal slash-star in a comment would swallow code below it.)
    resolver = resolver.onDemand('xai', own('xai').factory, { validation: own('xai').validation });
    this.providers = resolver;
    this.credentialLifecycle = new CredentialLifecycle({
      adapterFor: (providerId) => { try { return this.registry.get(providerId); } catch { return undefined; } },
      now,
    });
    this.healthManager = new HealthManager(
      {
        adapters: () => this.activeAdapters(),
        contextFor: (adapterId, signal) => this.contextForAdapter(adapterId, signal, undefined, { refuseWhenExpired: false }),
        // The third question the health probe can ask, and the only one that costs nothing. Asked
        // before the adapter's own check so an expired session is not discovered by launching a
        // browser to be told what the credential already said.
        credentialStanding: async (adapterId) => {
          const context = await this.contextForAdapter(adapterId, undefined, undefined, { refuseWhenExpired: false });
          return this.credentialLifecycle.standing(adapterId, context.credential);
        },
      },
      {
        now,
        ...(options.recoveryCooldownMs === undefined ? {} : { recoveryCooldownMs: options.recoveryCooldownMs }),
        ...(options.failureThreshold === undefined ? {} : { failureThreshold: options.failureThreshold }),
        onPass: (report) => {
          void this.recordJob({
            name: 'health',
            durationMs: report.durationMs ?? 0,
            outcome: report.status === 'ok' ? 'ok' : 'error',
            detail: `${report.providers.length} provider(s), status ${report.status}`,
          }).catch(() => undefined);
        },
        /**
         * Cooldowns are written through to the vault, not kept in memory.
         *
         * In memory they lasted exactly as long as the process, and this process is restarted on every
         * release — so an account that had just been told to wait was immediately eligible again and the
         * first request after each restart re-hammered it. The reference implementation keeps its
         * `modelLock_*` fields in the database for this reason.
         *
         * Fire-and-forget on purpose: the write is bookkeeping for the *next* request, and failing the
         * request in hand because a file could not be appended would trade a real answer for a note.
         */
        persistCooldown: (key, cooldown) => { void this.connectionStore?.setCooldown(key, cooldown).catch(() => undefined); },
        // Accepted from the same options bag, so a test can drive the clock the cooldowns are measured on.
      },
    );
    /**
     * Read back what the previous process left behind.
     *
     * Not awaited, and it cannot be: the constructor is synchronous and the vault is not. A request that
     * arrives in the few milliseconds before this resolves sees an empty cooldown list, which is exactly
     * the behaviour of the version before this existed.
     */
    void this.connectionStore?.listCooldowns()
      .then((cooldowns) => this.healthManager.seedModelCooldowns(cooldowns))
      .catch(() => undefined);
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
          // `renew: false` because this pass is the thing that decides renewal: a read that renewed here would
        // be the pass calling itself, once per connection, before it had even looked at the expiry.
        const context = await this.credentials.context(connection.id, connection.providerId, undefined, { renew: false, refuseWhenExpired: false });
          const credential = context.credential;
          if (!credential || credential.type !== 'oauth' || typeof credential.expiresAt !== 'string') continue;
          due.push({ id: connection.id, providerId: connection.providerId, expiresAt: credential.expiresAt });
        }
        return due;
      },
      renew: async (connection) => {
        const adapter = await this.resolveAdapter(connection.providerId, undefined, connection.id);
        // `renew: false` because this pass is the thing that decides renewal: a read that renewed here would
        // be the pass calling itself, once per connection, before it had even looked at the expiry.
        const context = await this.credentials.context(connection.id, connection.providerId, undefined, { renew: false, refuseWhenExpired: false });
        const credential = context.credential;
        if (!credential || credential.type !== 'oauth' || typeof credential.expiresAt !== 'string') return;
        /**
         * Due-ness is read from the credential when the adapter cannot answer, instead of from the adapter alone.
         *
         * This returned early unless `adapter.isCredentialExpired` existed, and four adapters do not implement
         * it — claude-code, codex, kimi-code and opencode-console — so **no renewal pass ever touched them**,
         * whatever their `expiresAt` said. claude-code's own comment calls its tokens short-lived, which is what
         * "the sign-in lasts about an hour" was for those providers. The credential states when it ends, and the
         * pass already filtered on that field a few lines above; an adapter that can answer precisely is still
         * believed over the raw date.
         */
        const horizon = Date.now() + renewalWindowMs;
        const due = typeof adapter.isCredentialExpired === 'function'
          ? adapter.isCredentialExpired(credential, horizon)
          : Date.parse(credential.expiresAt) <= horizon;
        if (due !== true) return;
        /**
         * Renew when the adapter can, probe when it cannot — and **store what the renewal returned**.
         *
         * Calling only `validateCredential` was a silent no-op for renewal: it asks the provider whether a
         * token works, and never replaces one that is about to expire. An idle connection therefore drifted
         * past its expiry and the next request paid for it — which is what "the session only lasts a few
         * hours" actually was. `renewCredential` is optional, so a provider that cannot renew still gets the
         * probe and behaves exactly as before.
         *
         * The return value goes to the connection that owns the credential, because a provider that rotates its
         * refresh token leaves the stored one dead the moment it hands a new one out. An adapter may also write
         * through its own `onTokensRefreshed`; writing the same value twice is harmless, and losing it is not.
         */
        // The provisioner is the contract; today it delegates to the adapter's own renewal method.
        // A lifecycle provider that implements the contract later changes this call, not the pass.
        const provisioner = new AdapterCredentialProvisioner(adapter, this.secretStore);
        const renewed = await provisioner.refresh(credential, context);
        if (renewed) {
          await this.connectionStore?.set(connection.id, renewed);
          return;
        }
        await adapter.validateCredential?.(credential, context);
      },
    }, {
      windowMs: renewalWindowMs,
      ...(intervalMs === undefined ? {} : { intervalMs }),
      onError: (connection, error) => {
        if (classifyRenewalFailure(error) !== 'needs-sign-in') return;
        this.healthManager.noteLoginRefused(connection.providerId, 'The login needs sign-in again: refresh was refused.', connection.id);
      },
      onPass: (result) => {
        void this.recordJob({
          name: 'token-renewal',
          durationMs: result.durationMs,
          outcome: result.failed > 0 ? 'error' : 'ok',
          detail: `${result.ran} due, ${result.failed} failed`,
        }).catch(() => undefined);
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

  /**
   * The id a provider must receive, including a catalog-recorded upstream id when one was stated.
   *
   * A public id can differ from the wire id (an adapter strips a vendor tier prefix, or a provider
   * rotates a `:free` suffix). The catalog records that difference as `u`. Only an explicit value
   * overrides the normal prefix strip — an absent one means the bare id is the wire id, and guessing
   * otherwise would double-prefix adapters that already restore their own tier.
   */
  private async upstreamModelFor(providerId: string, connectionId: string | undefined, requested: string): Promise<string> {
    const resolved = this.resolvedModel(requested);
    const bare = bareModelFor(resolved, providerId);
    if (!connectionId) return bare;
    const connection = (await this.connections.list()).find((entry) => entry.id === connectionId);
    if (!connection?.modelMeta) return bare;
    // NVIDIA's own ids begin with `nvidia/`, which is also its provider id. Stripping that prefix sent
    // `nemotron-3.5-super-vl-120b-a12b` upstream and got a 404; the catalog lists the whole id, so the
    // catalog decides what the provider is called.
    const whole = lookupModelId(resolved);
    const catalogued = (connection.modelIds ?? []).some((id) => lookupModelId(id) === whole);
    const wire = catalogued ? resolved : bare;
    const meta = connection.modelMeta[resolved] ?? connection.modelMeta[bare] ?? connection.modelMeta[requested];
    return meta?.u ?? wire;
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
      throw new ProviderError('INVALID_REQUEST', 'The provider strategy must be one of priority, round-robin, fastest.', { publicMessage: 'The provider strategy must be one of priority, round-robin, fastest.' });
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
    // Persist the coalesced counters before the process exits. A failed flush is reported by the
    // store, not allowed to keep the gateway alive.
    await this.connectionStore?.flushUsage?.().catch(() => undefined);
    await this.usageStore?.flush?.().catch(() => undefined);
    await this.spendLedger?.flush().catch(() => undefined);
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
      // The explicit pools, as configured. No models are invented here: an operator sees exactly the
      // ids that routing would substitute, and an unconfigured capability is simply absent.
      ...(this.options.capacityAdapter
        ? { capacityAdapter: Object.fromEntries(Object.entries(this.options.capacityAdapter).map(([capability, pool]) => [capability, {
          ...(pool.enabled === false ? { enabled: false } : {}),
          ...(pool.roundRobin === true ? { roundRobin: true } : {}),
          models: [...pool.models],
        }])) }
        : {}),
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
    // **No catalog reconciliation and no alias lookup.** A save belongs to exactly one provider: the
    // record is written under its own id, the credential is stored under it, and its own adapter
    // imports its own catalog. Cline and ClinePass used to be the exception — one record borrowing the
    // other's credential and a live tier read — and the consequence was a second card that showed the
    // first card's models. They are separate accounts now, so the store is the whole save path.
    return this.connections.save(input, credential, signal, options);
  }

  /**
   * Completes a Cline sign-in: exchanges the code for tokens, then stores the connection under the
   * provider that started it.
   *
   * The exchange is the proof: a code that Cline refuses never becomes a credential. Cline also asks
   * its account endpoint at save time (`validateOnSave`), while ClinePass does not — its tier catalog
   * is not an entitlement check, and a failure there must not discard a grant WorkOS just approved.
   * Catalog discovery is tolerated for both, so an unreadable feed leaves a connected account with an
   * empty model list, which "Update models" can fill later.
   */
  async connectCline(input: { code: string; callback?: string; redirectUri: string; connectionId?: string; name?: string; priority?: number; providerId?: 'cline' | 'clinepass' }, signal?: AbortSignal): Promise<ConnectionRecord> {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'Local connection storage is not configured.');
    const tokens = await exchangeClineCode(input, this.transport, signal);
    const credential = toClineCredential(tokens);
    const providerId = input.providerId ?? 'cline';
    const fallbackName = providerId === 'clinepass' ? 'ClinePass' : 'Cline';
    return this.saveConnection({
      id: input.connectionId ?? providerId,
      providerId,
      name: input.name?.trim() || (tokens.email ? `${fallbackName} (${tokens.email})` : fallbackName),
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
      save: (input, credential, pollSignal) => this.saveConnection(input, credential, pollSignal, { tolerateDiscoveryFailure: true }),
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

  /** Start a `claude` sign-in. Its verifier and state live on its own session, never in a URL. */
  startClaudeSignIn(publicBaseUrl: string, addAccount = false, targetConnectionId?: string) {
    return beginClaudeSignIn({
      store: this.claudeSessions,
      publicBaseUrl,
      connectionId: targetConnectionId ?? (addAccount ? `claude-${randomUUID().replace(/-/g, '').slice(0, 12)}` : claudeProviderId),
    });
  }

  claudeSignInStatus(sessionId: string) {
    const session = this.claudeSessions.get(sessionId);
    return session ? this.claudeSessions.publicStatus(session) : undefined;
  }

  /**
   * Finish a `claude` sign-in from either the browser callback or the exchange route.
   *
   * `redirectUri` and `codeVerifier` are optional because a browser navigation cannot supply them;
   * when the exchange route supplies them they are checked exactly against the session before a code
   * is spent. The verifier sent upstream is always the session's own.
   */
  completeClaudeCallback(input: { sessionId: string; raw: string; redirectUri?: string; codeVerifier?: string }, signal?: AbortSignal): Promise<ClaudeSessionStatus | undefined> {
    const sessionId = input.sessionId;
    return completeClaudeSignIn({
      store: this.claudeSessions,
      sessionId,
      raw: input.raw,
      ...(input.redirectUri !== undefined ? { redirectUri: input.redirectUri } : {}),
      ...(input.codeVerifier !== undefined ? { codeVerifier: input.codeVerifier } : {}),
      transport: this.transport,
      ...(signal ? { signal } : {}),
      saveConnection: async ({ credential }) => this.saveConnection({
        id: this.claudeSessions.get(sessionId)?.connectionId ?? claudeProviderId,
        providerId: claudeProviderId,
        name: 'Claude',
        endpoint: CLAUDE.server,
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
  startClineSignIn(providerId: 'cline' | 'clinepass', redirectUri: string, addAccount = false, targetConnectionId?: string) {
    // The session id goes in the redirect path, because the path is the one
    // part of the callback Cline has to honour verbatim.
    // The same redirect is what gets sent to the token endpoint later.
    const defaultId = providerId === 'clinepass' ? 'clinepass' : 'cline';
    const { sessionId, state, redirectUri: callback } = this.clineSessions.start(
      (id) => redirectUri.replace(/\/v1\/oauth\/cline\/callback\/?$/, clineCallbackPathFor(id)),
      targetConnectionId ?? (addAccount ? `${defaultId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : defaultId),
      providerId,
    );
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
      const connection = await this.connectCline({
        code: input.code,
        redirectUri: session.redirectUri,
        connectionId: session.connectionId,
        providerId: session.providerId ?? 'cline',
      }, signal);
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

  /**
   * OpenCode Go is its own package, not this adapter with a different base.
   *
   * It used to be `new ZenAdapter({ base: ZEN_GO_BASE_URL })`, which is how Go's paid models went out without the
   * `x-opencode-session` the lane routes by: the class only applied those headers on the free-tier path.
   */
  opencodeGoAdapter(): ProviderAdapter {
    if (!this.opencodeGo) {
      this.opencodeGo = new OpenCodeGoAdapter({ transport: this.transport });
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

  /**
   * DeepSeek Web V2, built once.
   *
   * The same SDK with `variant: 'v2'`: the modern fingerprint headers and the server-delivered model
   * catalogue. It is a separate provider because it is a separate credential and a separate card — the
   * sign-in window writes this one, and the paste path writes the other.
   */
  deepSeekV2Adapter(): DeepSeekWebAdapter {
    this.deepSeekV2 ??= new DeepSeekWebAdapter({ variant: 'v2' });
    return this.deepSeekV2;
  }

  /**
   * The ZCode (Start Plan) adapter for **one connection**, built once per connection.
   *
   * Per connection, not per provider: the adapter carries the device id and account uuid that Start
   * Plan meters quota against, so a shared instance served every account as whichever one signed in
   * last. It takes the gateway's own transport so the request carries the configured deadlines and the
   * destination check, which a fresh transport inside the adapter would not.
   *
   * `connectionId` defaults to the provider id only for callers that genuinely have no connection in
   * hand (a save-time validation of a credential that is not stored yet); routing always names one.
   */
  zcodeAdapter(connectionId: string = zcodeProviderId): ZcodeAdapter {
    const memo = this.zcodeAdapters.get(connectionId);
    if (memo) return memo;
    const adapter = new ZcodeAdapter({ transport: this.transport, workingDirectory: process.cwd() });
    this.zcodeAdapters.set(connectionId, adapter);
    return adapter;
  }

  /**
   * The token to use: a pasted one, else the one the ZCode app already stored on this machine.
   *
   * Reading the local store is what makes this provider connect the way the app does — the token is
   * the app's own session, so there is no "API key" to paste. A pasted token still wins, so the
   * dialog keeps working on a machine without the app. Device and account ids are adopted for
   * request attribution whenever they can be read; failing to read them never blocks a pasted token.
   */
  private async zcodeToken(pasted: string | undefined, connectionId: string = zcodeProviderId): Promise<string> {
    let local: ZcodeLocalCredential | undefined;
    try {
      this.zcodeLocal ??= await readZcodeLocalCredential();
      local = this.zcodeLocal;
      // Written to the adapter for **this connection**, never to a provider-wide one: the device and
      // account ids belong to the account the request is about.
      this.zcodeAdapter(connectionId).setLocalIdentity({
        ...(local.deviceMid ? { deviceMid: local.deviceMid } : {}),
        ...(local.accountUuid ? { accountUuid: local.accountUuid } : {}),
      });
    } catch {
      // No ZCode app here, or a secret this machine cannot derive. Only fatal when nothing was pasted.
    }
    const token = pasted?.trim() || local?.token;
    if (!token) {
      throw new ProviderError('CONFIGURATION_ERROR', 'No ZCode token: sign in to the ZCode app on this machine, or paste a token.', {
        providerId: zcodeProviderId,
        publicMessage: 'No ZCode credential was found on this machine. Sign in to the ZCode app, or paste the token.',
      });
    }
    return token;
  }

  /**
   * Proves the Start Plan token with one 1-token turn, and stores nothing.
   *
   * A catalog read would prove nothing here: the model list is static. Only a served turn establishes
   * that the token is accepted and the entitlement can infer. Answers with the plan and models the
   * dialog shows before saving.
   */
  async checkZcode(token: string | undefined, signal?: AbortSignal) {
    const value = await this.zcodeToken(token);
    const models = await this.zcodeAdapter().listModels();
    await this.zcodeAdapter().validateCredential({ type: 'api-key', value }, { signal });
    const planType = this.zcodeLocal?.activeProvider === 'bigmodel' ? 'ZCode BigModel' : 'ZCode Start Plan';
    return { verified: true, planType, isFreePlan: false, models: models.map((model) => ({ id: model.id, name: model.displayName ?? model.id })) };
  }

  /** Saves the token only after a turn succeeds, so a refused session never becomes a connection. */
  async connectZcode(token: string | undefined, signal?: AbortSignal, addAccount = false) {
    const value = await this.zcodeToken(token);
    await this.zcodeAdapter().validateCredential({ type: 'api-key', value }, { signal });
    return this.saveConnection(
      {
        id: addAccount ? `${zcodeProviderId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : zcodeProviderId,
        providerId: zcodeProviderId,
        name: 'ZCode (Start Plan)',
        endpoint: 'https://zcode.z.ai',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      },
      { type: 'api-key', value },
      signal,
    );
  }

  /**
   * Starts a standalone ZCode sign-in and returns the URL to open.
   *
   * This is ZCode's own OAuth server, not the installed app: `init` mints a flow, the user signs in
   * in any browser, and the gateway polls ZCode for the resulting token. The poll token stays here;
   * the browser only ever sees the flow id and the authorize URL.
   */
  async startZcodeSignIn(provider: ZcodeOAuthProvider = 'zai', addAccount = false, targetConnectionId?: string) {
    const start = await startZcodeOAuth(provider);
    /**
     * `addAccount` is remembered on the flow, not just at the paste route.
     *
     * The poll is what saves the connection, and it used the fixed provider id — so a second sign-in
     * silently overwrote the first. The paste route already minted `<id>-<12 hex>` for a second
     * account; the sign-in route never did, and the two paths disagreed about what "another account"
     * means.
     *
     * `targetConnectionId` is remembered for the same reason, from the other direction: a reconnect names the
     * row it repairs, and the poll has to save to *that* id rather than decide for itself.
     */
    this.zcodeFlows.set(start.flowId, { provider, addAccount, ...(targetConnectionId ? { targetConnectionId } : {}), pollToken: start.pollToken, expiresAt: start.expiresAt, pollIntervalSec: start.pollIntervalSec });
    return { authorizeUrl: start.authorizeUrl, flowId: start.flowId, expiresAt: start.expiresAt, pollIntervalSec: start.pollIntervalSec };
  }

  /**
   * One poll of a sign-in. `pending` is normal; `ready` stores the connection after proving a turn.
   *
   * The token is the account's own JWT from the OAuth server, so there is no dependency on the ZCode
   * desktop app. A turn is sent before the save: an account that cannot infer on the Start Plan lane
   * is reported here rather than stored as a connection that fails later.
   */
  async pollZcodeSignIn(flowId: string, signal?: AbortSignal) {
    const flow = this.zcodeFlows.get(flowId);
    // Not a thrown 404: a restart, an expired flow or a second poll after `ready` all land here, and
    // the dialog must say which it is instead of showing the provider-error fallback ("The requested
    // resource was not found") for a sign-in the user just started.
    if (!flow) return { status: 'failed' as const, message: 'This ZCode sign-in is unknown or already finished. Start again.' };
    // The dialog polls every second. A poll that arrives while the first is still proving its turn
    // waits for the same result; otherwise it would see no flow and report a failure for a sign-in
    // that is seconds away from succeeding, which is what the first live attempt did.
    if (flow.completion) return flow.completion;
    if (flow.connection) return { status: 'ready' as const, connection: flow.connection };
    if (Date.now() > flow.expiresAt * 1000) {
      this.zcodeFlows.delete(flowId);
      return { status: 'expired' as const };
    }
    const result = await pollZcodeOAuth(flowId, flow.pollToken, signal ? { signal } : {});
    if (result.status !== 'ready') {
      if (result.status === 'failed') this.zcodeFlows.delete(flowId);
      return result;
    }

    const completion = (async () => {
      try {
        // The id of the connection this sign-in is about, decided **here** and reused for both the
        // identity write and the save — the same rule the rest of the gateway follows, that the
        // account is chosen when the sign-in starts rather than guessed afterwards. Writing it to a
        // provider-wide adapter is what let the last sign-in relabel every other account.
        //
        // A target wins over the add flag: a reconnect names the row it repairs, and a flow that was started
        // to repair one must not mint a fresh id beside it. The dashboard cannot send both — `openEditConnection`
        // sets the target and turns `addAccount` off — but the id is what the user pointed at, so it decides.
        const connectionId = flow.targetConnectionId
          ?? (flow.addAccount ? `${zcodeProviderId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : zcodeProviderId);
        if (result.accountUuid) this.zcodeAdapter(connectionId).setLocalIdentity({ accountUuid: result.accountUuid });
        // Not gated on a test turn. The OAuth server has already authenticated the account, and the
        // desktop app saves the session without a probe too; gating it here is what made a successful
        // sign-in report "did not finish" whenever the plan lane replied slowly or with reasoning only.
        // The first real chat reports any plan/CAPTCHA problem with the client's own context.
        const connection = await this.saveConnection(
          {
            id: connectionId,
            providerId: zcodeProviderId,
            name: 'ZCode (Start Plan)',
            endpoint: 'https://zcode.z.ai',
            priority: 1,
            proxyPool: 'none',
            modelPolicy: 'all',
          },
          { type: 'api-key', value: result.token },
          signal,
        );
        // Keep the flow for a minute so a poll already in flight answers `ready`, not "unknown".
        flow.connection = connection;
        const timer = setTimeout(() => { this.zcodeFlows.delete(flowId); }, 60_000);
        timer.unref?.();
        return { status: 'ready' as const, connection };
      } catch (error) {
        this.zcodeFlows.delete(flowId);
        return { status: 'failed' as const, message: error instanceof Error ? error.message : 'The ZCode sign-in could not be completed.' };
      }
    })();
    flow.completion = completion;
    return completion;
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
   * Stores a DeepSeek Web V2 userToken, after checking DeepSeek accepts it.
   *
   * The token arrives from the sign-in window, which ran on the operator's machine because DeepSeek's
   * credential POST is an opaque blob and its emailed-code step needs an hCaptcha token minted on
   * DeepSeek's own origin. It is checked here before it is stored, so a session DeepSeek has already
   * invalidated never becomes a connection that reads as connected.
   */
  async connectDeepSeekWebV2(
    userToken: string,
    signal?: AbortSignal,
    addAccount = false,
    fingerprints: { deviceId?: string; shumeiDeviceId?: string; did?: string } = {},
  ) {
    /**
     * The web client's own device fingerprints ride on the credential.
     *
     * They come from the page that signed in, and they are what makes the requests it sends
     * indistinguishable from the app's: the same `x-device-id`, the Shumei value in the completion
     * body, `did` on settings calls. Absent is not fatal — the adapter falls back — but present is
     * the point of the sign-in window.
     */
    const credential = {
      ...deepSeekWebCredential(userToken),
      ...(fingerprints.deviceId ? { deviceId: fingerprints.deviceId } : {}),
      ...(fingerprints.shumeiDeviceId ? { shumeiDeviceId: fingerprints.shumeiDeviceId } : {}),
      ...(fingerprints.did ? { did: fingerprints.did } : {}),
    } as ProviderCredential;
    await this.deepSeekV2Adapter().validateCredential(credential);
    return this.saveConnection(
      {
        id: addAccount ? `${deepseekWebV2ProviderId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : deepseekWebV2ProviderId,
        providerId: deepseekWebV2ProviderId,
        name: 'DeepSeek Web V2',
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

  grokWebAdapter(): GrokWebAdapter {
    this.grokWeb ??= new GrokWebAdapter();
    return this.grokWeb;
  }

  /** Checks the sso cookie without storing it; 401/403 is a dead session, not a bad probe. */
  async checkGrokWeb(cookie: string, signal?: AbortSignal) {
    await this.grokWebAdapter().validateCredential(grokWebCredential(cookie), { signal });
    return { verified: true };
  }

  /** Saves a Grok Web subscription only after the cookie was accepted. */
  async connectGrokWeb(cookie: string, signal?: AbortSignal, addAccount = false) {
    const credential = grokWebCredential(cookie);
    await this.grokWebAdapter().validateCredential(credential, { signal });
    return this.saveConnection(
      {
        id: addAccount ? `${grokWebProviderId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : grokWebProviderId,
        providerId: grokWebProviderId,
        name: 'Grok Web',
        endpoint: 'https://grok.com',
        priority: 1,
        proxyPool: 'none',
        modelPolicy: 'all',
      },
      credential,
      signal,
    );
  }

  perplexityWebAdapter(): PerplexityWebAdapter {
    this.perplexityWeb ??= new PerplexityWebAdapter();
    return this.perplexityWeb;
  }

  /** Checks the Perplexity session without storing it; a 400 from the tiny probe still proves the cookie. */
  async checkPerplexityWeb(cookie: string, signal?: AbortSignal) {
    await this.perplexityWebAdapter().validateCredential(perplexityWebCredential(cookie), { signal });
    return { verified: true };
  }

  /** Saves a Perplexity Web session only after the cookie was accepted. */
  async connectPerplexityWeb(cookie: string, signal?: AbortSignal, addAccount = false) {
    const credential = perplexityWebCredential(cookie);
    await this.perplexityWebAdapter().validateCredential(credential, { signal });
    return this.saveConnection(
      {
        id: addAccount ? `${perplexityWebProviderId}-${randomUUID().replace(/-/g, '').slice(0, 12)}` : perplexityWebProviderId,
        providerId: perplexityWebProviderId,
        name: 'Perplexity Web',
        endpoint: 'https://www.perplexity.ai',
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

  /** The `claude` card's own adapter and renewal memo; it never borrows Claude Code's connection. */
  claudeAdapter(connectionId: string): ClaudeAdapter {
    const memo = this.claudeAdapters.get(connectionId);
    if (memo) return memo;
    const adapter = new ClaudeAdapter({
      transport: this.transport,
      onTokensRefreshed: async (credential) => {
        if (!this.connectionStore) return;
        await this.connectionStore.set(connectionId, credential).catch(() => undefined);
      },
    });
    this.claudeAdapters.set(connectionId, adapter);
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
      /**
       * The OpenCode app's own transport, when it is running.
       *
       * A direct request from this machine is refused with `429 FreeUsageLimitError` — from Node and
       * from Bun alike, with the account's credential and the client's headers — while the app serves
       * the same model seconds later. Turns therefore go through the local service. When it is not
       * running the adapter falls back to the direct lane, which reports the Console's own refusal.
       */
      localService: createOpencodeLocalService({
        // The session's root, which is also the answer to "inside which directory?" for the `project`
        // ruleset. `process.cwd()` is the gateway's own directory and has nothing to do with the caller's
        // project, so an operator can name it instead.
        directory: process.env.OMNIHILBRAS_OPENCODE_DIRECTORY?.trim() || process.cwd(),
        // Discovery, then the client's own server started on demand: a device with the OpenCode binary
        // but nothing running needs no manual step, and a device with neither reports the Console's
        // refusal instead of silence. The runtime is injected because it imports this module's sibling.
        //
        // The runtime's directory is **not** the connection store's. Passing `this.config().dataDir` here is
        // what split the runtime across two roots: this path recorded a pid under
        // `~/.config/omnihilbras/runtime/opencode/service/service.pid` while the gateway's own boot, supervisor
        // and shutdown used `~/.omnihilbras/runtime/opencode/service/service.pid`. Two instances were started,
        // only one was ever stopped, and `owned` was true in one place and false in the other. The runtime
        // resolves its own root; nothing here needs to name it.
        ensure: (o) => ensureOpencodeService({ ...(o.env ? { env: o.env } : {}) }),
      }),
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
   * ClinePass is its own card, connection and grant, so a renewed token is written back to **this**
   * connection's vault entry. The `credentialConnectionId` fallback remains for a record that
   * deliberately reads another account's credential — no card does that today — and writing the renewed
   * token to the owner is the only correct target when it does.
   */
  clinepassAdapter(connectionId = 'clinepass'): ProviderAdapter {
    const memo = this.clinepassAdapters.get(connectionId);
    if (memo) return memo;
    const adapter = new ClinePassAdapter({
      transport: this.transport,
      onTokensRefreshed: async (tokens) => {
        const record = (await this.connections.list()).find((connection) => connection.id === connectionId);
        await this.connectionStore?.set(record?.credentialConnectionId ?? connectionId, toClineCredential(tokens));
      },
    });
    this.clinepassAdapters.set(connectionId, adapter);
    return adapter;
  }

  async listConnections() {
    return this.connections.list();
  }

  /**
   * Connections visible to one workspace (multi-user isolation, Phase 9).
   *
   * A connection with no `workspaceId` is unscoped and visible to every caller; a scoped connection is only
   * returned to the matching workspace. Pass `undefined` for an unscoped caller (the operator's dashboard),
   * which sees everything — this is a *listing filter*, not yet a per-request authorization boundary on every
   * route; that larger threading is deliberately out of scope here.
   */
  async listConnectionsForWorkspace(workspaceId?: string) {
    const all = await this.connections.list();
    return workspaceId === undefined ? all : all.filter((connection) => connection.workspaceId === undefined || connection.workspaceId === workspaceId);
  }

  /**
   * A cheap, **secret-free** fingerprint of the state the dashboard displays, for change detection (Phase 4).
   *
   * The real-time channel polls this every second rather than probing providers or decrypting credentials.
   * It covers connection membership/settings and stored health counters — the two things a page shows —
   * and deliberately includes no credential, endpoint secret or usage content. Sorting by id makes map order
   * irrelevant, so two identical states always produce the same string.
   */
  /**
   * Durable change events after a sequence, for an SSE client reconnecting with `Last-Event-ID`.
   *
   * Only the SQLite state backend journals writes; the JSON backend returns nothing and the live
   * fingerprint still delivers the next change. The payload is a document name, size and digest — never
   * a document's bytes, and never a credential.
   */
  stateEventsSince(afterSeq: number, limit = 100) {
    const dataDir = this.config()?.dataDir;
    if (!dataDir) return [];
    return readStateEventsSince(dataDir, afterSeq, limit);
  }

  async recordAudit(input: { actor: string; action: string; target: string; outcome: number; requestId?: string }) {
    await this.auditStore?.record(input);
  }

  async listAudit(limit = 100) {
    return this.auditStore?.list(limit) ?? [];
  }

  async recordJob(input: { name: string; durationMs: number; outcome: 'ok' | 'error'; detail?: string }) {
    await this.jobStore?.record(input);
  }

  async listJobs(limit = 50) {
    return this.jobStore?.list(limit) ?? [];
  }

  async stateFingerprint(): Promise<string> {
    const connections = (await this.connections.list())
      .map((connection) => [
        connection.id,
        connection.providerId,
        connection.name,
        connection.enabled,
        connection.priority,
        connection.quotaTier ?? '',
        connection.hasCredential,
        connection.credentialType ?? '',
        // Model *ids*, not just their count: swapping which models are imported must notify the page.
        connection.modelIds ?? [],
        connection.customModelIds ?? [],
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return JSON.stringify({ connections, health: this.healthManager.healthFingerprint() });
  }

  /**
   * The connection list plus the one fact the dashboard cannot otherwise know: when each credential ends.
   *
   * Reported as *"the sign-in lasts about an hour and then I have to sign in again"* — and from the outside
   * there was no way to tell an expiring credential from a revoked one, or from a working one, until a request
   * failed an hour later. The information was already stored: every OAuth credential carries `expiresAt`, the
   * same field the renewal pass filters on. So this exposes it rather than inventing a second guess.
   *
   * Five states, and the two that matter are `expiring` (the pass will renew it within `renewalWindowMs`) and
   * `expired` (it should already have been renewed or refused). `unknown` is honest for a credential whose
   * expiry cannot be read, and `none` is a keyless connection — not the same thing as an expired one.
   *
   * A separate method from `listConnections()` on purpose: this decrypts every credential, and the routing and
   * renewal paths ask for the list far more often than a dashboard asks for this.
   */
  async listConnectionsWithExpiry() {
    const now = Date.now();
    const records = await this.connections.list();
    return Promise.all(records.map(async (record) => {
      const credential = await this.secretStore.get(record.id, record.providerId).catch(() => undefined);
      const expiresAt = credential?.type === 'oauth' && typeof credential.expiresAt === 'string' ? credential.expiresAt : undefined;
      let credentialState: 'valid' | 'expiring' | 'expired' | 'unknown' | 'none' = credential ? 'unknown' : 'none';
      // A keyless connection states that it is keyless rather than reporting an unreadable expiry: `{ type: 'none' }`
      // is a deliberate save, and calling it `unknown` would send its operator looking for a session to renew.
      if (credential?.type === 'none') return { ...record, credentialExpiresAt: undefined, credentialState: 'none' };
      if (expiresAt) {
        const at = Date.parse(expiresAt);
        if (Number.isFinite(at)) {
          credentialState = at <= now ? 'expired' : at <= now + renewalWindowMs ? 'expiring' : 'valid';
        }
      }
      return { ...record, credentialExpiresAt: expiresAt, credentialState };
    }));
  }

  async addConnectionModels(connectionId: string, modelIds: string[]) {
    return this.connections.setModels(connectionId, modelIds);
  }

  /**
   * Forgets model ids this gateway added to a connection.
   *
   * The inverse of `addConnectionModels`, and the pair the provider page's add-model control needs: an id
   * typed by hand used to be permanent, because the route that writes one refuses an empty list and there is no
   * way to name a removal. An empty `modelIds` clears every addition, which is the "forget what I added"
   * action; the provider's own catalog is never touched by either.
   */
  async removeConnectionModels(connectionId: string, modelIds: string[]) {
    return this.connections.removeModels(connectionId, modelIds);
  }

  /**
   * Removes a connection, and the traces of it that are not credentials.
   *
   * A browser-driver profile is a signed-in third-party session on disk; leaving it behind after a delete
   * leaves a credential the operator asked to be rid of. Best effort: a connection that never opened a
   * browser has nothing to remove, and a failure to clean up must not make the delete fail.
   */
  async removeConnection(connectionId: string) {
    const removed = await this.connections.remove(connectionId);
    await removeChatGptWebProfile(connectionId).catch(() => undefined);
    await removeGeminiWebProfile(connectionId).catch(() => undefined);
    return removed;
  }

  /** The API keys this gateway knows about, and whether a key is required to use it. */
  listApiKeys(): Promise<GatewayApiKeyList> {
    return this.apiKeys.list();
  }

  /** Creating a key returns its secret exactly once; it is never readable again. */
  createApiKey(name: string, workspaceId?: string, role?: 'owner' | 'viewer') {
    return this.apiKeys.create(name, workspaceId, role);
  }

  setApiKeyEnabled(id: string, enabled: boolean) {
    return this.apiKeys.setEnabled(id, enabled);
  }

  /** Renames a key without touching its secret, so a client using it keeps working. */
  renameApiKey(id: string, name: string) {
    return this.apiKeys.rename(id, name);
  }

  /** Sets or clears a key's rate limit and expiry. `null` clears; an omitted field is left alone. */
  setApiKeyLimits(id: string, limits: ApiKeyLimits) {
    return this.apiKeys.setLimits(id, limits);
  }

  removeApiKey(id: string) {
    return this.apiKeys.remove(id);
  }

  setRequireApiKey(value: boolean) {
    return this.apiKeys.setEnforced(value);
  }

  /**
   * Every file-backed store this gateway holds, encrypted under a passphrase.
   *
   * Connections carry their decrypted credential on purpose: that is what makes the backup useful, and the
   * envelope is the only place it travels. The API-key section holds hashes, not plaintext — the plaintext
   * existed once, at creation, and a backup cannot invent it.
   *
   * Which sections travel is decided by `backupSections()`, so a store added to the gateway is one visible
   * edit here rather than a category that quietly stops travelling — which is how version 1 came to carry
   * three of eleven while its own comment called the file everything needed to rebuild the gateway.
   *
   * Deliberately not carried, and named so nobody has to infer it from a missing key: `secrets.key` and the
   * dashboard token are this installation's identity rather than its configuration — credentials travel
   * decrypted and are re-wrapped under the target's own master key on import, so shipping the source key
   * would let a backup decrypt a machine it does not belong to. Settings are environment variables with no
   * store behind them, and the token saver's cache lives in memory only. A store this gateway was never
   * given contributes nothing, and its absence from the file says exactly that.
   */
  async exportBackup(passphrase: string) {
    const sections: Record<string, unknown> = {};
    for (const section of this.backupSections()) {
      if (section.store?.exportState) sections[section.name] = await section.store.exportState();
    }
    const envelope = encryptBackup({
      format: backupFormat,
      version: backupVersion,
      createdAt: new Date().toISOString(),
      ...sections,
    }, passphrase);
    /**
     * Read the file back before reporting it saved.
     *
     * The importer refuses an envelope over 20 MiB, while export enforced no bound: a machine with
     * several web profiles could produce a backup this same build would not restore. Decrypting here
     * makes that a failed export with a reason, not a saved file that fails at restore.
     */
    decryptBackup(envelope, passphrase);
    return envelope;
  }

  /**
   * Reads a backup without writing it.
   *
   * The import button asked for consent with no evidence; this is the evidence. It decrypts, runs every
   * section through the same parser the importer uses, and returns counts — no store is touched.
   */
  async verifyBackup(passphrase: string, envelope: unknown) {
    const decrypted = decryptBackup(envelope, passphrase);
    if (!isBackupRecord(decrypted) || decrypted.format !== backupFormat) throw notAGatewayBackup();
    const payload = decrypted.version === 1
      ? legacyBackupSections(decrypted)
      : decrypted.version === backupVersion
        ? decrypted
        : (() => { throw notAGatewayBackup(); })();
    const sections = this.backupSections();
    const counts: Record<string, number> = {};
    const notCarried: string[] = [];
    for (const section of sections) {
      const value = payload[section.name];
      if (value === undefined) {
        notCarried.push(section.name);
        continue;
      }
      counts[section.name] = countSectionRecords(section.parse(value));
    }
    if (!('connections' in counts)) throw notAGatewayBackup();
    return {
      valid: true,
      version: decrypted.version,
      createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : undefined,
      sections: counts,
      notCarried,
    };
  }

  /**
   * The stores a backup carries, each paired with the parser that reads its section back.
   *
   * The parser is the store's own — the same function that reads its file — so a payload accepted here is
   * one the store would accept on the next restart, and a field cannot be carried by one reader and dropped
   * by the other. Two readers of one shape is how a credential lost three of its nine fields between its
   * writer and its reader, twice, in this repository.
   */
  private backupSections(): Array<{
    name: string;
    store: { exportState?: () => Promise<unknown>; importState?: (state: never) => Promise<void> } | undefined;
    parse: (value: unknown) => unknown;
  }> {
    return [
      { name: 'connections', store: this.connectionStore, parse: parseConnectionsBackupState },
      { name: 'apiKeys', store: this.apiKeyStore, parse: parseApiKeyState },
      { name: 'usage', store: this.usageStore, parse: parseUsageState },
      { name: 'requestDetails', store: this.requestDetails, parse: parseRequestDetailState },
      { name: 'virtualModels', store: this.virtualModelStore, parse: parseVirtualModelState },
      { name: 'skills', store: this.skillStore, parse: parseSkillState },
      { name: 'workspaces', store: this.workspaceStore, parse: parseWorkspaceState },
      { name: 'tunnels', store: this.tunnelStore, parse: parseTunnelState },
      { name: 'proxyPools', store: this.proxyPoolStore, parse: parseProxyPoolState },
      { name: 'providerNodes', store: this.providerNodeStore, parse: parseProviderNodeState },
      { name: 'mitm', store: this.mitmStore, parse: parseMitmState },
      { name: 'prompts', store: this.promptStore, parse: parsePromptState },
      // Last on purpose: a profile belongs to a connection that the connections section has already
      // installed, so this one writes sessions for the vault the import just put in place.
      { name: 'webProfiles', store: this.webProfileStore(), parse: parseWebProfilesState },
    ];
  }

  /**
   * The web-profile section, shaped like a store so the backup loop needs no second pass.
   *
   * It is not a store: a browser profile is a directory the ChatGPT Web and Gemini Web drivers own, keyed by
   * connection id, and only part of it travels (`core/web-profiles.ts` says which part and why).
   */
  private webProfileStore(): { exportState: () => Promise<unknown>; importState: (state: never) => Promise<void> } {
    return {
      exportState: async () => exportWebProfiles(await this.connections.list()),
      importState: async (state: never) => {
        const connections = await this.connections.list();
        const providers = new Map(connections.map((connection) => [connection.id, connection.providerId] as const));
        await importWebProfiles(state, connections.map((connection) => connection.id), (id) => providers.get(id));
      },
    };
  }

  /**
   * Replaces this installation's configuration with a decrypted backup.
   *
   * Replace, not merge: a backup is a snapshot of one gateway, and merging two snapshots by id leaves
   * credentials from the old machine attached to records from the new one. The caller has to say yes to
   * that; the route passes the confirmation through.
   *
   * Every section is validated before any store is written. The stores validate their own section too, but a
   * store that took its part and then failed on the sixth of ten would leave an installation whose
   * connections came from one machine and whose tunnels came from another — while the user, told the import
   * failed, looks at a gateway that half-believes it succeeded. Reading the whole payload through the same
   * parsers first is what makes the refusal total.
   *
   * A section the file does not carry is left alone rather than cleared. An absent section means the source
   * installation had no such store, which is not the same statement as "this installation should have none";
   * clearing on the strength of silence would destroy data the file never spoke about. The result names both
   * what travelled and what did not.
   */
  async importBackup(passphrase: string, envelope: unknown) {
    if (!this.connectionStore) throw new ProviderError('CONFIGURATION_ERROR', 'This gateway has no connection store to import into.');
    const decrypted = decryptBackup(envelope, passphrase);
    if (!isBackupRecord(decrypted) || decrypted.format !== backupFormat) throw notAGatewayBackup();
    let payload: Record<string, unknown>;
    if (decrypted.version === 1) payload = legacyBackupSections(decrypted);
    else if (decrypted.version === backupVersion) payload = decrypted;
    else throw notAGatewayBackup();

    // Validation first, writes second: every carried section is read into a store's own state before any
    // store is touched, so a payload that fails anywhere in the file changes nothing anywhere in the vault.
    const sections = this.backupSections();
    const validated = new Map<string, unknown>();
    for (const section of sections) {
      const value = payload[section.name];
      if (value === undefined) continue;
      validated.set(section.name, section.parse(value));
    }
    if (!validated.has('connections')) throw notAGatewayBackup();
    const cannotImport = sections.filter((section) => validated.has(section.name) && !section.store?.importState).map((section) => section.name);
    if (cannotImport.length > 0) {
      throw new ProviderError('CONFIGURATION_ERROR', `This gateway cannot import ${cannotImport.join(', ')}.`);
    }

    const previous = await this.connectionStore.list();
    // Snapshot every section before the first write. Validation is total, but a store's write can
    // still fail (disk full, permission, metadata bound); without this a failure on the sixth store
    // left the first five replaced while the UI said nothing was written.
    const snapshots = new Map<string, unknown>();
    for (const section of sections) {
      if (!validated.has(section.name) || !section.store?.exportState) continue;
      snapshots.set(section.name, await section.store.exportState());
    }
    try {
      for (const section of sections) {
        const state = validated.get(section.name);
        if (state === undefined) continue;
        await section.store!.importState!(state as never);
      }
    } catch (error) {
      for (const section of [...sections].reverse()) {
        const snapshot = snapshots.get(section.name);
        if (snapshot === undefined || !section.store?.importState) continue;
        await section.store.importState(snapshot as never).catch(() => undefined);
      }
      throw error;
    }

    // Read back what the store actually holds. A write that resolves but stores nothing is the failure mode
    // that looks exactly like "the import did nothing"; the counts must describe the store, not a loop.
    const connections = validated.get('connections') as ConnectionsBackupState;
    const persisted = new Set((await this.connectionStore.list()).map((connection) => connection.id));
    const missing = connections.connections.map((entry) => entry.connection.id).filter((id) => !persisted.has(id));
    if (missing.length > 0) {
      throw new ProviderError('CONFIGURATION_ERROR', `The connection store did not persist: ${missing.join(', ')}.`);
    }

    // Routing reads this map on every request, so it has to describe the strategies that just arrived rather
    // than the ones the previous installation had.
    this.providerStrategies.clear();
    for (const [providerId, strategy] of Object.entries(connections.strategies)) this.providerStrategies.set(providerId, strategy);

    const counts: Record<string, number> = {};
    for (const [name, state] of validated) counts[name] = countSectionRecords(state);
    return {
      connections: counts.connections ?? 0,
      strategies: Object.keys(connections.strategies).length,
      aliases: Object.keys(connections.aliases).length,
      apiKeys: counts.apiKeys ?? 0,
      removed: previous.length,
      sections: counts,
      notCarried: sections.filter((section) => payload[section.name] === undefined).map((section) => section.name),
    };
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
  private async preparedMessages(request: ChatRequest, scope: RequestScope | undefined, allowImageContext: boolean): Promise<ChatRequest['messages']> {
    const complete = completeToolRounds(request.messages);
    if (scope?.tokenSaver === false) return complete;
    const signature = JSON.stringify(complete);
    const cached = scope ? this.compressionCache.get(scope.id) : undefined;
    // The cache is per request, but a local-tool loop calls this again with a growing conversation.
    // Returning the first round's result dropped the tool results added since.
    if (cached && cached.signature === signature) return cached.messages;
    const store = this.tokenSaverStore;
    const saversActive = Boolean(this.tokenSaverConfig || this.historyTrim || this.headroom || this.pxpipe || this.caveman || this.ponytail);
    if (saversActive) {
      let messages = complete as SavableMessage[];
      const savers: SaverTelemetry['savers'] = {};
      let totalTokensSaved = 0;
      let totalBytesSaved = 0;
      const record = (
        id: string,
        kind: string,
        state: 'ran' | 'skipped',
        figure: { tokensSaved?: number; bytesBefore?: number; bytesAfter?: number; detail?: string } = {},
      ) => {
        const entry = savers[id] ?? { kind, requests: 0, tokensSaved: 0, bytesBefore: 0, bytesAfter: 0, state };
        entry.requests += 1;
        entry.state = state;
        if (figure.detail) entry.detail = figure.detail;
        entry.tokensSaved += Math.max(0, figure.tokensSaved ?? 0);
        entry.bytesBefore += Math.max(0, figure.bytesBefore ?? 0);
        entry.bytesAfter += Math.max(0, figure.bytesAfter ?? 0);
        savers[id] = entry;
      };
      const size = () => Buffer.byteLength(JSON.stringify(messages), 'utf8');

      /**
       * The always-on tool-result shortener runs before every configured saver.
       *
       * It used to live only in the `else` branch, so setting `caveman`/`ponytail` alone disabled it and
       * could make the prompt larger than a stock gateway. Its own saving is now in the same telemetry.
       */
      const beforeToolBytes = size();
      const shortened = compressToolResults(complete) as SavableMessage[];
      messages = shortened;
      const afterToolBytes = size();
      if (beforeToolBytes > afterToolBytes) {
        record('tool-shortener', 'tool', 'ran', {
          tokensSaved: Math.ceil((beforeToolBytes - afterToolBytes) / 4),
          bytesBefore: beforeToolBytes,
          bytesAfter: afterToolBytes,
        });
        totalTokensSaved += Math.ceil((beforeToolBytes - afterToolBytes) / 4);
        totalBytesSaved += beforeToolBytes - afterToolBytes;
      }

      if (this.tokenSaverConfig && store) {
        const beforeBytes = size();
        const compressed = compressMessages(messages, {
          targetRatio: this.tokenSaverConfig.targetRatio,
          protectRecent: this.tokenSaverConfig.protectRecent,
          compressUsers: this.tokenSaverConfig.compressUsers,
          compressCode: this.tokenSaverConfig.compressCode,
          reversible: this.tokenSaverConfig.reversible,
          ccr: store,
        });
        messages = compressed.value as SavableMessage[];
        if (compressed.stats.savedTokens > 0) {
          const afterBytes = size();
          for (const [index, route] of compressed.stats.routes.entries()) {
            record(route.strategy || route.kind, route.kind, 'ran', {
              tokensSaved: Math.max(0, route.originalTokens - route.compressedTokens),
              // The conversation delta belongs to the pass, not to every route: counting the whole
              // before/after for each route reported the saving several times.
              bytesBefore: index === 0 ? beforeBytes : 0,
              bytesAfter: index === 0 ? afterBytes : 0,
            });
          }
          totalTokensSaved = compressed.stats.savedTokens;
          totalBytesSaved = Math.max(0, beforeBytes - afterBytes);
        } else {
          record('token-saver', 'text', 'skipped', { detail: 'no compression opportunity' });
        }
      }

      if (this.headroom) {
        const beforeBytes = size();
        const result = await headroomCompress(messages, request.model, this.headroom);
        messages = result.messages as SavableMessage[];
        const savedBytes = Math.max(0, beforeBytes - result.bytesAfter);
        if (result.applied) {
          const tokensSaved = Math.ceil(savedBytes / 4);
          record('headroom', 'text', 'ran', { tokensSaved, bytesBefore: beforeBytes, bytesAfter: result.bytesAfter });
          totalTokensSaved += tokensSaved;
          totalBytesSaved += savedBytes;
        } else {
          record('headroom', 'text', 'skipped', {
            bytesBefore: beforeBytes,
            bytesAfter: result.bytesAfter,
            detail: result.detail ? `${result.reason}: ${result.detail}` : result.reason,
          });
        }
      }

      // PXPIPE turns bulky text into images; only an adapter that carries Anthropic image context can take them.
      if (this.pxpipe && allowImageContext) {
        const beforeBytes = size();
        const result = await pxpipeCompress(messages, request.model, this.pxpipe);
        messages = result.messages as SavableMessage[];
        const savedBytes = Math.max(0, beforeBytes - result.bytesAfter);
        if (result.applied) {
          const tokensSaved = Math.ceil(savedBytes / 4);
          record('pxpipe', 'text', 'ran', {
            tokensSaved,
            bytesBefore: beforeBytes,
            bytesAfter: result.bytesAfter,
            ...(result.detail ? { detail: result.detail } : {}),
          });
          totalTokensSaved += tokensSaved;
          totalBytesSaved += savedBytes;
        } else {
          record('pxpipe', 'text', 'skipped', {
            bytesBefore: beforeBytes,
            bytesAfter: result.bytesAfter,
            detail: result.detail ? `${result.reason}: ${result.detail}` : result.reason,
          });
        }
      }

      if (this.caveman) {
        const beforeBytes = size();
        messages = injectCaveman(messages, this.caveman.level);
        record('caveman', 'prompt', 'ran', { bytesBefore: beforeBytes, bytesAfter: size(), detail: this.caveman.level });
      }
      if (this.ponytail) {
        const beforeBytes = size();
        messages = injectPonytail(messages, this.ponytail.level);
        record('ponytail', 'prompt', 'ran', { bytesBefore: beforeBytes, bytesAfter: size(), detail: this.ponytail.level });
      }

      if (this.historyTrim && store) {
        const trim = trimHistory(messages, {
          maxInputTokens: this.historyTrim.maxInputTokens,
          keepRecent: this.historyTrim.keepRecent,
          ccr: store,
          reversible: this.tokenSaverConfig?.reversible,
        });
        if (trim.trimmed > 0) {
          const beforeTrimBytes = size();
          messages = trim.messages;
          const afterTrimBytes = size();
          const tokensSaved = Math.max(0, trim.originalTokens - trim.trimmedTokens);
          record('history-trim', 'text', 'ran', { tokensSaved, bytesBefore: beforeTrimBytes, bytesAfter: afterTrimBytes });
          totalTokensSaved += tokensSaved;
          totalBytesSaved += Math.max(0, beforeTrimBytes - afterTrimBytes);
        }
      }

      const telemetry: SaverTelemetry | undefined = Object.keys(savers).length > 0
        ? { totalTokensSaved, totalBytesSaved, savers }
        : undefined;
      if (scope) {
        if (telemetry) {
          this.compressionTelemetry.set(scope.id, telemetry);
          this.compressionCache.set(scope.id, { messages: messages as ChatRequest['messages'], telemetry, signature });
        } else {
          this.compressionCache.set(scope.id, { messages: messages as ChatRequest['messages'], signature });
        }
        while (this.compressionCache.size > 500) {
          const oldest = this.compressionCache.keys().next().value;
          if (oldest === undefined) break;
          this.compressionCache.delete(oldest);
          this.compressionTelemetry.delete(oldest);
        }
      }
      if (telemetry) console.log(`[token-saver] request ${scope?.id ?? 'unscoped'} saved ~${totalTokensSaved} tokens`);
      return messages as ChatRequest['messages'];
    }
    const compressed = compressToolResults(complete);
    const saved = toolResultBytes(complete) - toolResultBytes(compressed);
    if (saved > 0) console.log(`[token-saver] request ${scope?.id ?? 'unscoped'} saved ${saved} bytes of tool output`);
    return compressed;
  }

  /**
   * Runs the configured savers over a conversation **without storing it**.
   *
   * The analysis page needs a real before/after, and `usage.json` deliberately carries no prompt
   * content. This is the compromise: the request body is processed in memory and only counts,
   * per-saver rows and reasons are returned. External savers may be called if configured; they fail
   * open exactly as they do on the request path.
   */
  async analyzeTokenSaver(messages: ChatMessage[]): Promise<{
    beforeBytes: number;
    afterBytes: number;
    tokensSaved: number;
    savers: Array<{ id: string; kind: string; state: 'ran' | 'skipped'; tokensSaved: number; bytesBefore: number; bytesAfter: number; detail?: string }>;
  }> {
    const complete = completeToolRounds(messages);
    const beforeBytes = Buffer.byteLength(JSON.stringify(complete), 'utf8');
    let current = compressToolResults(complete) as SavableMessage[];
    const rows: Array<{ id: string; kind: string; state: 'ran' | 'skipped'; tokensSaved: number; bytesBefore: number; bytesAfter: number; detail?: string }> = [];
    const size = () => Buffer.byteLength(JSON.stringify(current), 'utf8');
    const shortenedBytes = size();
    if (shortenedBytes < beforeBytes) rows.push({ id: 'tool-shortener', kind: 'tool', state: 'ran', tokensSaved: Math.ceil((beforeBytes - shortenedBytes) / 4), bytesBefore: beforeBytes, bytesAfter: shortenedBytes });

    if (this.tokenSaverConfig) {
      const store = this.tokenSaverStore ?? new MemoryCcrStore(this.tokenSaverConfig.ccrLimit);
      const before = size();
      const compressed = compressMessages(current, {
        targetRatio: this.tokenSaverConfig.targetRatio,
        protectRecent: this.tokenSaverConfig.protectRecent,
        compressUsers: this.tokenSaverConfig.compressUsers,
        compressCode: this.tokenSaverConfig.compressCode,
        reversible: this.tokenSaverConfig.reversible,
        ccr: store,
      });
      current = compressed.value as SavableMessage[];
      const after = size();
      for (const [index, route] of compressed.stats.routes.entries()) {
        rows.push({
          id: route.strategy || route.kind,
          kind: route.kind,
          state: compressed.stats.savedTokens > 0 ? 'ran' : 'skipped',
          tokensSaved: Math.max(0, route.originalTokens - route.compressedTokens),
          bytesBefore: index === 0 ? before : 0,
          bytesAfter: index === 0 ? after : 0,
          ...(compressed.stats.savedTokens > 0 ? {} : { detail: 'no compression opportunity' }),
        });
      }
    }
    if (this.headroom) {
      const before = size();
      const result = await headroomCompress(current, 'analysis', this.headroom);
      current = result.messages as SavableMessage[];
      rows.push({ id: 'headroom', kind: 'text', state: result.applied ? 'ran' : 'skipped', tokensSaved: result.applied ? Math.ceil(Math.max(0, before - result.bytesAfter) / 4) : 0, bytesBefore: before, bytesAfter: result.bytesAfter, ...(result.applied ? {} : { detail: result.detail ? `${result.reason}: ${result.detail}` : result.reason }) });
    }
    if (this.pxpipe) {
      const before = size();
      const result = await pxpipeCompress(current, 'analysis', this.pxpipe);
      current = result.messages as SavableMessage[];
      rows.push({ id: 'pxpipe', kind: 'text', state: result.applied ? 'ran' : 'skipped', tokensSaved: result.applied ? Math.ceil(Math.max(0, before - result.bytesAfter) / 4) : 0, bytesBefore: before, bytesAfter: result.bytesAfter, ...(result.applied ? {} : { detail: result.detail ? `${result.reason}: ${result.detail}` : result.reason }) });
    }
    if (this.caveman) {
      const before = size();
      current = injectCaveman(current, this.caveman.level);
      rows.push({ id: 'caveman', kind: 'prompt', state: 'ran', tokensSaved: 0, bytesBefore: before, bytesAfter: size(), detail: this.caveman.level });
    }
    if (this.ponytail) {
      const before = size();
      current = injectPonytail(current, this.ponytail.level);
      rows.push({ id: 'ponytail', kind: 'prompt', state: 'ran', tokensSaved: 0, bytesBefore: before, bytesAfter: size(), detail: this.ponytail.level });
    }
    if (this.historyTrim) {
      const before = size();
      const trim = trimHistory(current, {
        maxInputTokens: this.historyTrim.maxInputTokens,
        keepRecent: this.historyTrim.keepRecent,
        ccr: this.tokenSaverStore ?? new MemoryCcrStore(500),
        reversible: this.tokenSaverConfig?.reversible,
      });
      current = trim.messages;
      rows.push({ id: 'history-trim', kind: 'text', state: trim.trimmed > 0 ? 'ran' : 'skipped', tokensSaved: Math.max(0, trim.originalTokens - trim.trimmedTokens), bytesBefore: before, bytesAfter: size(), ...(trim.trimmed > 0 ? {} : { detail: 'under the trim threshold' }) });
    }
    const afterBytes = size();
    return {
      beforeBytes,
      afterBytes,
      tokensSaved: Math.max(0, Math.ceil((beforeBytes - afterBytes) / 4)),
      savers: rows,
    };
  }

  /** Removes and returns the telemetry for one request, so a retry path cannot double-count it. */
  takeCompressionTelemetry(requestId: string | undefined): SaverTelemetry | undefined {    if (!requestId) return undefined;
    const telemetry = this.compressionTelemetry.get(requestId);
    if (telemetry) {
      this.compressionTelemetry.delete(requestId);
      this.compressionCache.delete(requestId);
    }
    return telemetry;
  }

  /** The original behind a `<<token-saver:id>>` marker, for the retrieval route. */
  retrieveTokenSaverContext(id: string): string | undefined {
    return this.tokenSaverStore?.get(id)?.content;
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

  private withRequestLimits(request: ChatRequest): ChatRequest {
    const maxOutputTokens = this.maxOutputTokensCap === undefined
      ? request.maxOutputTokens
      : Math.min(request.maxOutputTokens ?? this.maxOutputTokensCap, this.maxOutputTokensCap);
    const maxThinkingTokens = this.thinkingBudgetCap === undefined
      ? request.maxThinkingTokens
      : Math.min(request.maxThinkingTokens ?? this.thinkingBudgetCap, this.thinkingBudgetCap);
    return {
      ...request,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(maxThinkingTokens === undefined ? {} : { maxThinkingTokens }),
      ...(this.cacheAnchor ? { cacheAnchor: true } : {}),
    };
  }

  /**
   * The tool contract, applied before anything is sent.
   *
   * `null` means the request carried no tools and no `tool_choice`, which is the common case: the whole cost of this
   * feature for a client that does not use tools is one map lookup.
   */
  private noteToolContract(scopeId: string | undefined, note: ToolContractTelemetry): void {
    if (!scopeId) return;
    if (this.toolContractNotes.size >= 512) this.toolContractNotes.delete(this.toolContractNotes.keys().next().value!);
    this.toolContractNotes.set(scopeId, note);
  }

  /** Counts only. Used by the HTTP layer to label the usage record for this request. */
  toolContractFor(scopeId: string | undefined): ToolContractTelemetry | undefined {
    return scopeId ? this.toolContractNotes.get(scopeId) : undefined;
  }

  /** Calls the model made that the gateway refused to forward, so a route can flag a truncated tool turn. */
  blockedCallsFor(scopeId: string | undefined): number {
    return scopeId ? this.blockedCallNotes.get(scopeId) ?? 0 : 0;
  }

  private noteBlockedCalls(scopeId: string | undefined, count: number): void {
    if (!scopeId || count <= 0) return;
    if (this.blockedCallNotes.size >= 512) this.blockedCallNotes.delete(this.blockedCallNotes.keys().next().value!);
    this.blockedCallNotes.set(scopeId, (this.blockedCallNotes.get(scopeId) ?? 0) + count);
  }

  private async applyToolContract(providerId: string, request: ChatRequest, includeLocalTools = false, connectionId?: string, scopeId?: string): Promise<{ request: ChatRequest; declared: readonly string[]; renames: ReadonlyMap<string, string>; cloaked: boolean }> {
    try {
      const connection = connectionId ? (await this.connections.list()).find((entry) => entry.id === connectionId) : undefined;
      const effectiveCaps = narrowedToolCaps(request.model, connection, toolCaps(providerId));
      const { request: normalized, notes } = normalizeToolsRequest(request, providerId, effectiveCaps, {
        ...(this.toolSchemaBytes ? { maxSchemaBytes: this.toolSchemaBytes } : {}),
      });
      const toolContract: ToolContractTelemetry = {
        declared: (request.tools ?? []).length,
        forwarded: 0,
        stripped: notes.stripped ? (request.tools ?? []).length : 0,
        dropped: notes.dropped.length,
      };
      // A client that declared tools which this provider cannot serve gets a stated refusal before any
      // provider call, instead of a normal-looking text turn that ends the agent's tool loop silently.
      // `toolChoice: 'none'` is the caller's own decision, not a capability mismatch.
      if (notes.stripped && (request.tools ?? []).length > 0 && request.toolChoice !== 'none') {
        this.noteToolContract(scopeId, { ...toolContract, stripped: (request.tools ?? []).length });
        throw new ToolContractError(
          'TOOLS_UNSUPPORTED',
          providerId,
          `${providerId} cannot serve the ${(request.tools ?? []).length} declared tool(s); they were stripped.`,
          `${providerId} cannot serve function tools. Continue this conversation with a tool-capable provider, or send the request without tools.`,
        );
      }
      if (notes.stripped) console.warn(`[tools] ${providerId} does not serve tools; ${(request.tools ?? []).length} definition(s) removed`);
      if (notes.assumed) console.warn(`[tools] ${providerId} has no capability row; assuming tools with auto/none`);
      for (const drop of notes.dropped) console.warn(`[tools] ${providerId} dropped "${drop.name}": ${drop.reason}`);
      // Only definitions that survived sanitisation reached the adapter, so only those may be called. Reading the
      // raw request here used to leave a rejected name on the allow list, which forwarded a call the client never
      // offered — the exact class of call the guard exists to stop.
      const kept = (normalized.tools ?? []).map((tool) => tool.name);
      const declared = kept.length > 0 || (request.tools ?? []).length === 0
        ? kept
        // An empty allow list means "the client did not constrain calls" (providers inject their own tools), so it
        // cannot also mean "every definition was rejected". A name outside the sanitised alphabet blocks all calls.
        : ['\u0000no-definitions-forwarded'];

      // The free-tier lanes used to declare their own tool quartet — including `bash` — inside each SDK adapter.
      // The declaration now comes from the one catalog in Kernel/Tools and is applied here, at the gateway, so a
      // provider package can no longer invent a tool the client never offered. A forced call keeps only the client's
      // own definitions: a generated "unavailable" tool must never be the thing a forced choice selects.
      let declaredNames = declared;
      let outbound = normalized;
      // Folding `Read` to `read` on the wire is harmless only if a returned `read` is still treated as
      // the caller's tool and renamed back before the client sees it.
      const renames = gatewayToolNameMap(normalized.tools, normalized.toolChoice);
      if (renames.size > 0) declaredNames = [...declaredNames, ...renames.keys()];
      // Claude connections carry the Claude Code tool surface: client names get a stable suffix and
      // unavailable decoys are declared beside them. The restore map shares the request's lifetime, so
      // the same map that hid a name is the one that reveals it — before the allow-list guard, never
      // after. Decoy names map to a name no client declared, so a decoy call is blocked by that guard.
      // The allow list above is deliberately built *before* the cloak map is merged: a wire name is not
      // a name the client declared just because we happened to put it on the wire.
      let cloaked = false;
      if (shouldCloakTools(providerId, connection)) {
        const result = cloakClaudeTools(outbound);
        outbound = result.request;
        cloaked = result.renames.size > 0;
        for (const [wire, original] of result.renames) renames.set(wire, original);
      }
      if (GATEWAY_TOOL_PROVIDERS.has(providerId) && !(normalized.toolChoice === 'required' && kept.length > 0)) {
        outbound = { ...normalized, tools: withGatewayTools(normalized.tools) } as ChatRequest;
      }
      // Local tools are exposed only when the operator opted in AND the provider can really call a function.
      // A browser-session provider gets the prompt form instead, applied in `runLocalToolRounds`.
      if (includeLocalTools && this.localToolRoots.length > 0 && (effectiveCaps?.tools ?? toolCaps(providerId).tools)) {
        outbound = { ...outbound, tools: [...(outbound.tools ?? []), ...localToolDefinitions()] } as ChatRequest;
        // The gateway declared these tools, so a call naming one is legitimate even though the client did not.
        declaredNames = [...declaredNames, ...LOCAL_TOOL_NAMES];
      }
      toolContract.forwarded = (outbound.tools ?? []).length;
      this.noteToolContract(scopeId, toolContract);
      return { request: outbound, declared: declaredNames, renames, cloaked };
    } catch (error) {
      if (error instanceof ToolContractError) {
        throw new ProviderError('NOT_SUPPORTED', error.message, { providerId: error.providerId, publicMessage: error.publicMessage });
      }
      throw error;
    }
  }

  /**
   * The calls a client may run.
   *
   * A provider can return a call naming a tool the client never declared, or arguments that are not an object. Both used
   * to reach the client untouched, which is how an agent runs the wrong command and blames the model. What survives is
   * forwarded; what does not is dropped and logged, and a turn whose only call was dropped no longer claims
   * `finish_reason: tool_calls`.
   */
  private validatedToolResponse(providerId: string, declared: readonly string[], response: ChatResponse, renames: ReadonlyMap<string, string> = new Map(), cloaked = false, scopeId?: string): ChatResponse {
    const calls = response.message.toolCalls;
    if (!calls?.length) return response;
    const allowed = new Set(declared);
    const wireCalls = calls.map((call) => {
      const original = cloaked
        ? restoreClaudeToolName(call.function.name, renames, allowed)
        : renames.get(call.function.name);
      return original && original !== call.function.name
        ? { ...call, function: { ...call.function, name: original } }
        : call;
    });
    const { calls: valid, issues, repaired } = validateToolCalls(wireCalls, declared);
    this.noteBlockedCalls(scopeId, issues.length);
    for (const issue of issues) console.warn(`[tools] ${providerId} returned a call that was not forwarded: ${issue.name} — ${issue.reason}`);
    for (const fix of repaired) console.log(`[tools] ${providerId} repaired arguments on call ${fix.index}: ${fix.repairs.join(', ')}`);
    // A call that survived is a tool turn whatever the provider called its finish reason. Gemini reports `STOP`
    // next to a `functionCall`, and Claude Code's final stream chunk hardcodes `stop`; a client that keys its loop
    // on the finish reason then ends the turn with an executable call in hand. Derive the truth from the calls.
    const finishReason = valid.length > 0 && response.finishReason !== 'tool_calls'
      ? 'tool_calls' as const
      : response.finishReason;
    if (valid.length === wireCalls.length && repaired.length === 0) {
      return { ...response, finishReason, message: { ...response.message, ...(valid.length ? { toolCalls: valid } : {}) } };
    }
    const { toolCalls: _dropped, ...rest } = response.message;
    return {
      ...response,
      finishReason: valid.length === 0 && response.finishReason === 'tool_calls' ? 'stop' as const : finishReason,
      message: valid.length > 0 ? { ...rest, toolCalls: valid } : rest,
    };
  }

  /**
   * Runs gateway-local read-only tools for providers that cannot run them themselves.
   *
   * Native providers get real tool definitions and answer calls over their own function-calling wire; providers
   * without that surface get an instruction in the system message and answer with a fenced JSON block. Both paths
   * execute the call here, append the result and ask the model again, for a bounded number of rounds.
   */
  private async runLocalToolRounds(
    providerId: string,
    contracted: { request: ChatRequest; declared: readonly string[]; renames: ReadonlyMap<string, string>; cloaked: boolean },
    adapter: ProviderAdapter,
    signal: AbortSignal | undefined,
    scope: RequestScope | undefined,
    connectionId: string | undefined,
  ): Promise<ChatResponse | undefined> {
    if (this.localToolRoots.length === 0) return undefined;
    const native = toolCaps(providerId).tools;
    const messages: ChatMessage[] = [...(contracted.request.messages ?? [])];
    if (!native) messages.push({ role: 'system', content: LOCAL_TOOL_PROMPT });
    let last: ChatResponse | undefined;

    for (let round = 0; round < 4; round += 1) {
      const prepared = await this.preparedMessages({ ...contracted.request, messages }, scope, adapter.imageContext === true);
      const context = await this.contextForRequest(providerId, connectionId, signal, scope);
      const response = this.validatedToolResponse(providerId, contracted.declared, await adapter.chat!(
        this.withRequestLimits({ ...contracted.request, model: await this.upstreamModelFor(providerId, connectionId, contracted.request.model), messages: prepared }),
        context,
      ), contracted.renames, contracted.cloaked, scope?.id);
      last = response;

      if (native) {
        const localCalls = (response.message.toolCalls ?? []).filter((call) => isLocalToolName(call.function.name));
        if (localCalls.length === 0) return response;
        messages.push({ role: 'assistant', content: response.message.content, ...(response.message.toolCalls ? { toolCalls: response.message.toolCalls } : {}) });
        for (const call of localCalls) {
          const parsed = parseNativeToolCall(call.function.name, call.function.arguments);
          const result = parsed
            ? await executeLocalTool(parsed, this.localToolRoots)
            : { content: 'Invalid local tool call.', isError: true };
          messages.push({ role: 'tool', content: result.content, toolCallId: call.id, ...(result.isError ? { isError: true } : {}) });
        }
        continue;
      }

      const text = typeof response.message.content === 'string' ? response.message.content : '';
      const call = parsePromptToolCall(text);
      if (!call) return response;
      const result = await executeLocalTool(call, this.localToolRoots);
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: `Local tool result${result.isError ? ' (error)' : ''}: ${result.content}` });
    }

    // A model that never settles is refused rather than answered with a half-finished tool round.
    return last ? { ...last, finishReason: 'stop' } : last;
  }

  async chat(providerId: string, request: ChatRequest, signal?: AbortSignal, scope?: RequestScope, connectionId?: string): Promise<ChatResponse> {
    const adapter = await this.resolveAdapter(providerId, undefined, connectionId);
    if (!adapter.chat || adapter.capabilities.chat !== true) throw notSupported(adapter, 'chat');
    const contracted = await this.applyToolContract(providerId, request, true, connectionId, scope?.id);
    const release = await this.acquireConcurrency(connectionId);
    try {
      const local = await this.runLocalToolRounds(providerId, contracted, adapter, signal, scope, connectionId);
      if (local) return local;
      const response = await adapter.chat(this.withRequestLimits({ ...contracted.request, model: await this.upstreamModelFor(providerId, connectionId, contracted.request.model), messages: await this.preparedMessages(contracted.request, scope, adapter.imageContext === true) }), await this.contextForRequest(providerId, connectionId, signal, scope));
      return this.validatedToolResponse(providerId, contracted.declared, response, contracted.renames, contracted.cloaked, scope?.id);
    } finally {
      release();
    }
  }

  /**
   * The streaming half of Claude cloaking. A tool name arrives in exactly one delta
   * (`content_block_start` on the provider wire), so restoring it here is enough for the rest of the
   * call's deltas to be recognised. Decoy names restore to a name no client declared, which the guard
   * below drops along with their arguments.
   */
  private async *restoreStreamToolNames(
    chunks: AsyncIterable<ChatChunk>,
    renames: ReadonlyMap<string, string>,
    declared: readonly string[],
    cloaked: boolean,
  ): AsyncIterable<ChatChunk> {
    if (!cloaked) {
      yield* chunks;
      return;
    }
    const allowed = new Set(declared);
    for await (const chunk of chunks) {
      const pieces = chunk.delta?.toolCalls;
      if (!pieces?.length) {
        yield chunk;
        continue;
      }
      yield {
        ...chunk,
        delta: {
          ...chunk.delta,
          toolCalls: pieces.map((piece) => {
            const wire = piece.function?.name;
            if (!wire || !piece.function) return piece;
            const original = restoreClaudeToolName(wire, renames, allowed);
            return original === wire ? piece : { ...piece, function: { ...piece.function, name: original } };
          }),
        },
      };
    }
  }

  async *streamChat(providerId: string, request: ChatRequest, signal?: AbortSignal, scope?: RequestScope, connectionId?: string): AsyncIterable<ChatChunk> {
    const adapter = await this.resolveAdapter(providerId, undefined, connectionId);
    if (!adapter.streamChat || adapter.capabilities.streaming !== true) throw notSupported(adapter, 'streaming');
    const contracted = await this.applyToolContract(providerId, request, false, connectionId, scope?.id);
    const release = await this.acquireConcurrency(connectionId);
    try {
      const chunks = adapter.streamChat(this.withRequestLimits({ ...contracted.request, model: await this.upstreamModelFor(providerId, connectionId, contracted.request.model), messages: await this.preparedMessages(contracted.request, scope, adapter.imageContext === true) }), await this.contextForRequest(providerId, connectionId, signal, scope));
      const report: { allowed: string[]; blocked: { index: number; name: string }[] } = { allowed: [], blocked: [] };
      try {
        yield* guardToolStream(
          this.restoreStreamToolNames(chunks, contracted.renames, contracted.declared, contracted.cloaked),
          contracted.declared,
          report,
          contracted.renames,
        );
      } finally {
        this.noteBlockedCalls(scope?.id, report.blocked.length);
        for (const blocked of report.blocked) {
          console.warn(`[tools] ${providerId} streamed a call to "${blocked.name}", which the client did not declare; its deltas were dropped`);
        }
      }
    } finally {
      release();
    }
  }

  /**
   * Reserves one in-flight slot for the selected account, or refuses before a request is dispatched.
   *
   * The slot belongs to the connection, not the provider: two accounts of one vendor have independent
   * concurrency. A refusal is not a provider failure; nothing was sent.
   */
  private async acquireConcurrency(connectionId?: string): Promise<() => void> {
    if (!connectionId) return () => {};
    const connection = (await this.connections.list()).find((entry) => entry.id === connectionId);
    const limit = connection?.resilience.maxConcurrentRequests ?? 0;
    if (!limit) return () => {};
    const active = this.inFlight.get(connectionId) ?? 0;
    if (active >= limit) {
      throw new ProviderError('RATE_LIMITED', 'The account is at its concurrency limit.', {
        retryable: false,
        details: { concurrencyLimited: true },
        publicMessage: 'This account is at its concurrency limit. Wait for an in-flight request to finish.',
      });
    }
    this.inFlight.set(connectionId, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const now = this.inFlight.get(connectionId) ?? 1;
      if (now <= 1) this.inFlight.delete(connectionId);
      else this.inFlight.set(connectionId, now - 1);
    };
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
    const release = await this.acquireConcurrency(connectionId);
    try {
      return await adapter.embed({ ...request, model: await this.upstreamModelFor(providerId, connectionId, request.model) }, await this.contextForRequest(providerId, connectionId, signal, scope));
    } finally {
      release();
    }
  }

  async image(providerId: string, request: ImageRequest, signal?: AbortSignal, scope?: RequestScope, connectionId?: string): Promise<ImageResponse> {
    const adapter = await this.resolveAdapter(providerId, undefined, connectionId);
    if (adapter.capabilities.images !== true || typeof adapter.image !== 'function') throw notSupported(adapter, 'images');
    const release = await this.acquireConcurrency(connectionId);
    try {
      return await adapter.image({ ...request, model: await this.upstreamModelFor(providerId, connectionId, request.model) }, await this.contextForRequest(providerId, connectionId, signal, scope));
    } finally {
      release();
    }
  }

  async audio(providerId: string, request: AudioSpeechRequest, signal?: AbortSignal, scope?: RequestScope, connectionId?: string): Promise<AudioSpeechResponse> {
    const adapter = await this.resolveAdapter(providerId, undefined, connectionId);
    if (adapter.capabilities.audio !== true || typeof adapter.audio !== 'function') throw notSupported(adapter, 'audio');
    const release = await this.acquireConcurrency(connectionId);
    try {
      return await adapter.audio({ ...request, model: await this.upstreamModelFor(providerId, connectionId, request.model) }, await this.contextForRequest(providerId, connectionId, signal, scope));
    } finally {
      release();
    }
  }

  async transcribe(providerId: string, request: AudioTranscriptionRequest, signal?: AbortSignal, scope?: RequestScope, connectionId?: string): Promise<AudioTranscriptionResponse> {
    const adapter = await this.resolveAdapter(providerId, undefined, connectionId);
    if (adapter.capabilities.audio !== true || typeof adapter.transcribe !== 'function') throw notSupported(adapter, 'audio');
    const release = await this.acquireConcurrency(connectionId);
    try {
      return await adapter.transcribe({ ...request, model: await this.upstreamModelFor(providerId, connectionId, request.model) }, await this.contextForRequest(providerId, connectionId, signal, scope));
    } finally {
      release();
    }
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
    const saved = await this.connections.get(connectionId);
    if (saved && saved.proxyPool !== 'none') {
      // Refusing is the honest outcome. Sending through the direct transport while the account says
      // it is isolated would leak the request from the wrong network identity, which is worse than a
      // clear configuration error.
      throw new ProviderError('CONFIGURATION_ERROR', `Connection ${connectionId} names proxy pool "${saved.proxyPool}", but this gateway build cannot enforce proxied egress.`, {
        retryable: false,
        publicMessage: 'This account names a proxy pool, but this build cannot enforce proxied egress. Remove the proxy pool or use a direct account.',
      });
    }
    const canonical = providerAlias(providerId);
    // A connection with its own key/OAuth credential uses it. Only a keyless record with no per-record
    // link falls back to the legacy provider alias.
    const usesOwnCredential = saved?.credentialType === 'api-key' || saved?.credentialType === 'oauth';
    if (!saved?.credentialConnectionId && !usesOwnCredential && canonical && canonical !== providerId) {
      // A pre-link shared card's routed connection is the alias record, which deliberately holds no token
      // of its own. The credential lives on the owner's connection, and this is the one lookup that
      // follows the alias. A record with `credentialConnectionId` is handled by `context()` directly.
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
    // Fusion cannot be expressed as a route reorder: it owns the whole turn and produces one answer
    // from several paid turns. It is intercepted here, before the single-route executor and its cache.
    if (request.model.startsWith('oh/')) {
      const virtual = await this.virtualModelStore?.get(request.model);
      if (virtual?.strategy === 'fusion') {
        if (!virtual.enabled) throw new ProviderError('INVALID_REQUEST', `Virtual model "${request.model}" is disabled.`, {
          retryable: false,
          publicMessage: `Virtual model "${request.model}" is disabled. Enable it on the Models page to use it.`,
        });
        return this.runFusion(virtual, request, signal, scope);
      }
    }
    /**
     * A client request is never deduplicated.
     *
     * `!signal` looks like an accident here and is the opposite: the HTTP layer always passes an
     * abort signal, so this condition keeps every request that came from a client on the real path.
     * `load.test.js` pins the invariant — 200 concurrent identical requests must reach the provider
     * 200 times, "once, not zero times and not twice" — so serving a client from the response cache,
     * or coalescing two client requests onto one upstream call, is a behaviour the project refuses.
     * The cache and the coalescing below therefore apply only to a caller that reaches the service
     * directly with no signal.
     */
    const cacheable = (request.temperature === undefined || request.temperature === 0) && !signal && request.connectionId === undefined && explicitProviderId === undefined;
    if (cacheable) await this.responseCache.ready();
    const cacheKey = cacheable ? this.responseCache.keyFor(request) : undefined;
    if (cacheKey) {
      const cached = this.responseCache.get(cacheKey) as ChatResponse | undefined;
      if (cached) return { response: cached, attempts: [] };
      if (this.semanticCache) {
        const similar = await this.semanticCache.get(JSON.stringify(request.messages)).catch(() => undefined);
        if (similar) return { response: similar.value as ChatResponse, attempts: [] };
      }
      // A duplicate already running is waited on rather than sent again. `!signal` is guaranteed by
      // `cacheable`, so no caller can abort out of a shared promise and strand the others.
      const inflight = this.inflightChats.get(cacheKey);
      if (inflight) return inflight;
      const work = this.requests.chat(request, explicitProviderId, undefined, scope)
        .then((outcome) => {
          if (outcome?.response) {
            this.responseCache.set(cacheKey, outcome.response);
            void this.semanticCache?.set(JSON.stringify(request.messages), outcome.response).catch(() => undefined);
          }
          return outcome;
        })
        .finally(() => { this.inflightChats.delete(cacheKey); });
      this.inflightChats.set(cacheKey, work);
      return work;
    }
    return this.requests.chat(request, explicitProviderId, signal, scope);
  }

  /**
   * A scope for one request, created at the edge so the id is per *request* rather than per
   * provider.
   *
   * Public because the HTTP layer is the only place that knows a request has been accepted, and it
   * needs to hand the id to the client *and* to the providers it will be sent to.
   */
  startScope(requestedModel: string, explicitProviderId?: string, tokenSaver?: boolean, id?: string): RequestScope {
    return startRequestScope({
      requestedModel,
      ...(explicitProviderId === undefined ? {} : { explicitProviderId }),
      ...(tokenSaver === undefined ? {} : { tokenSaver }),
      // The id the server already announced on the response, so the header, the error envelope and the usage record
      // carry one string. Absent for a caller with no HTTP request behind it (a test, an embedded service).
      ...(id === undefined ? {} : { id }),
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

  async imageWithFailover(request: ImageRequest, explicitProviderId: string | undefined, signal?: AbortSignal, scope?: RequestScope): Promise<GatewayImageOutcome> {
    return this.requests.image(request, explicitProviderId, signal, scope);
  }

  async audioWithFailover(request: AudioSpeechRequest, explicitProviderId: string | undefined, signal?: AbortSignal, scope?: RequestScope): Promise<GatewayAudioOutcome> {
    return this.requests.audio(request, explicitProviderId, signal, scope);
  }

  async transcribeWithFailover(request: AudioTranscriptionRequest, explicitProviderId: string | undefined, signal?: AbortSignal, scope?: RequestScope): Promise<GatewayTranscriptionOutcome> {
    return this.requests.transcribe(request, explicitProviderId, signal, scope);
  }

  /** Streaming cannot retry after bytes are sent, so failover only covers the first chunk. */
  async streamChatWithFailover(request: ChatRequest, explicitProviderId: string | undefined, signal?: AbortSignal, scope?: RequestScope): Promise<GatewayStreamOutcome> {
    if (request.model.startsWith('oh/')) {
      const virtual = await this.virtualModelStore?.get(request.model);
      if (virtual?.strategy === 'fusion') {
        if (!virtual.enabled) throw new ProviderError('INVALID_REQUEST', `Virtual model "${request.model}" is disabled.`, {
          retryable: false,
          publicMessage: `Virtual model "${request.model}" is disabled. Enable it on the Models page to use it.`,
        });
        const outcome = await this.runFusion(virtual, request, signal, scope);
        // One honest chunk from the judge's complete answer. Inventing per-source deltas here would
        // pretend a streamed turn that never happened.
        const text = typeof outcome.response.message.content === 'string' ? outcome.response.message.content : '';
        async function* chunks() {
          yield {
            id: outcome.response.id,
            providerId: outcome.response.providerId,
            model: outcome.response.model,
            delta: { content: text },
            ...(outcome.response.finishReason ? { finishReason: outcome.response.finishReason } : {}),
            ...(outcome.response.usage ? { usage: outcome.response.usage } : {}),
          };
        }
        return { chunks: chunks(), attempts: outcome.attempts };
      }
    }
    return this.requests.stream(request, explicitProviderId, signal, scope);
  }

  private async planRoute(model: string, explicitProviderId?: string, explicitConnectionId?: string, context?: PlanRouteContext): Promise<RouteDecision> {
    const connections = await this.listConnections();
    if (explicitConnectionId !== undefined && !connections.some((connection) => connection.id === explicitConnectionId)) {
      throw new ProviderError('INVALID_REQUEST', 'The requested connection does not exist.', {
        retryable: false,
        publicMessage: 'The requested connection does not exist.',
      });
    }
    if (model.startsWith('oh/')) {
      const virtual = await this.virtualModelStore?.get(model);
      if (!virtual) {
        throw new ProviderError('INVALID_REQUEST', `Virtual model "${model}" does not exist.`, {
          retryable: false,
          publicMessage: `Virtual model "${model}" does not exist.`,
        });
      }
      if (!virtual.enabled) {
        throw new ProviderError('INVALID_REQUEST', `Virtual model "${model}" is disabled.`, {
          retryable: false,
          publicMessage: `Virtual model "${model}" is disabled. Enable it on the Models page to use it.`,
        });
      }
      return this.applyProviderPolicy(await this.planVirtual(virtual, connections, explicitProviderId, explicitConnectionId, context));
    }
    return this.applyProviderPolicy(await this.routing.plan({
      connections,
      model,
      ...(explicitProviderId === undefined ? {} : { explicitProviderId }),
      ...(explicitConnectionId === undefined ? {} : { explicitConnectionId }),
      // Derived from the request, not from the model: a vision-capable model is only needed when the
      // turn actually carries an image. The scope still names what the client asked for, so the wire
      // substitution below never changes the usage label.
      ...(context?.request ? { requiredCapabilities: requiredCapabilitiesFromRequest(context.request) } : {}),
    }));
  }

  /** Removes candidates a key's provider allowlist forbids, refusing rather than silently re-routing. */
  private applyProviderPolicy(decision: RouteDecision): RouteDecision {
    const allowed = currentPrincipal()?.allowedProviders;
    if (!allowed || allowed.length === 0) return decision;
    const candidates = decision.candidates.filter((candidate) => allowed.includes(candidate.providerId));
    if (candidates.length === 0) {
      throw new ProviderError('FORBIDDEN', 'This key may not use any provider that could serve the request.', {
        publicMessage: `This key may only use: ${allowed.join(', ')}.`,
      });
    }
    return { ...decision, candidates };
  }

  /**
   * Turns virtual targets into ordinary route candidates.
   *
   * Each target is planned as a one-connection decision, so health, credential, model presence, rate
   * limit and balance stay in the routing engine instead of being re-implemented here. The only thing this
   * adds is the upstream model override, which the request executor sends instead of the `oh/…` id.
   */
  private async planVirtual(
    virtual: VirtualModel,
    connections: Awaited<ReturnType<GatewayService['listConnections']>>,
    explicitProviderId?: string,
    explicitConnectionId?: string,
    context?: PlanRouteContext,
  ): Promise<RouteDecision> {
    const targets = virtual.targets
      .filter((target) => target.enabled && (explicitConnectionId === undefined || target.connectionId === explicitConnectionId))
      .sort((left, right) => left.priority - right.priority);
    let ordered = targets;
    if (virtual.strategy === 'smart' && context) {
      const chosen = await this.resolveSmartChoice(virtual, targets, context);
      if (chosen) {
        const at = targets.findIndex((target) => target.connectionId === chosen.connectionId && target.upstreamModelId === chosen.upstreamModelId);
        if (at > 0) ordered = [targets[at]!, ...targets.filter((_, index) => index !== at)];
      }
    } else if (virtual.strategy === 'round-robin' && targets.length > 1) {
      const offset = (this.virtualRotation.get(virtual.id) ?? 0) % targets.length;
      this.virtualRotation.set(virtual.id, offset + 1);
      ordered = [...targets.slice(offset), ...targets.slice(0, offset)];
    } else if (virtual.strategy === 'fastest') {
      ordered = [...targets].sort((left, right) => {
        const a = this.connectionLatency.get(left.connectionId)?.latencyMs ?? Number.POSITIVE_INFINITY;
        const b = this.connectionLatency.get(right.connectionId)?.latencyMs ?? Number.POSITIVE_INFINITY;
        return a - b || left.priority - right.priority;
      });
    }

    const candidates: RouteCandidate[] = [];
    const skipped: RouteDecision['skipped'] = [];
    for (const target of ordered) {
      const connection = connections.find((entry) => entry.id === target.connectionId);
      // A target is a claim about a saved account and a model it lists. If either changed, skip it
      // rather than inventing a route that the adapter cannot serve.
      if (!connection || !connection.modelIds.includes(target.upstreamModelId)) continue;
      const single = await this.routing.plan({
        connections: [{ ...connection, priority: target.priority, modelIds: [target.upstreamModelId] }],
        model: target.upstreamModelId,
        ...(explicitProviderId === undefined ? {} : { explicitProviderId }),
        ...(explicitConnectionId === undefined ? {} : { explicitConnectionId }),
      });
      for (const candidate of single.candidates) {
        candidates.push({ ...candidate, model: target.upstreamModelId, priority: target.priority });
      }
      skipped.push(...single.skipped);
    }
    return { candidates, skipped };
  }



  /**
   * A stable key for one conversation, derived from its first user turn.
   *
   * OpenAI-shaped clients resend the whole history on every call, so the first user message identifies
   * the conversation without adding a header or a public field to `ChatRequest`. Hashing it keeps a
   * prompt out of the map; the key is opaque and never leaves this process.
   */
  private smartSessionKey(virtualId: string, request: ChatRequest): string {
    const first = request.messages.find((message) => message.role === 'user');
    const text = first ? (typeof first.content === 'string' ? first.content : JSON.stringify(first.content ?? '')) : '';
    return createHash('sha256').update(`${virtualId}\u0000${text}`).digest('hex').slice(0, 24);
  }

  /**
   * Spends one real turn on the configured router model and reads a JSON decision from its answer.
   *
   * No simulated choice and no placeholder response: a model that refuses, times out, returns prose
   * that is not the promised object, gives a confidence below the configured threshold, or names a
   * model that is not a target produces no ordering change at all.
   */
  private async askSmartRouter(
    virtual: VirtualModel,
    targets: readonly VirtualModelTarget[],
    context: PlanRouteContext,
  ): Promise<{ choice: string; confidence: number } | undefined> {
    if (!virtual.routerModel) return undefined;
    const candidates = [...new Set(targets.map((target) => target.upstreamModelId))];
    const system = [
      'You are the routing judge for a multi-account virtual model.',
      `Choose exactly one of these upstream model ids: ${JSON.stringify(candidates)}.`,
      'Reply with ONLY a JSON object of the shape {"choice":"<one id>","confidence":0.0}.',
      'confidence is your own calibrated certainty from 0 to 1. A low confidence means the caller keeps its declared order.',
    ].join('\n');
    const routerRequest: ChatRequest = {
      ...context.request,
      model: virtual.routerModel,
      messages: [
        { role: 'system', content: system },
        ...context.request.messages.map((message) => ({ ...message })),
      ],
      stream: false,
      tools: undefined,
      toolChoice: undefined,
      connectionId: undefined,
    };
    try {
      const outcome = await this.chatWithFailover(routerRequest, undefined, context.signal, context.scope);
      const raw = typeof outcome.response.message.content === 'string' ? outcome.response.message.content : '';
      const json = raw.includes('```')
        ? /\{[\s\S]*?"choice"[\s\S]*?\}/.exec(raw)?.[0]
        : raw.trim();
      if (!json) return undefined;
      const decision: unknown = JSON.parse(json);
      if (!decision || typeof decision !== 'object') return undefined;
      const { choice, confidence } = decision as { choice?: unknown; confidence?: unknown };
      if (typeof choice !== 'string' || typeof confidence !== 'number' || !Number.isFinite(confidence)) return undefined;
      if (!candidates.includes(choice)) return undefined;
      if (confidence < (virtual.confidenceThreshold ?? 0.8)) return undefined;
      return { choice, confidence };
    } catch {
      // A router failure is never a reason to fail the caller's turn. Declared target order is the
      // answer the operator already configured, so it is the safe fallback.
      return undefined;
    }
  }

  private async resolveSmartChoice(
    virtual: VirtualModel,
    targets: readonly VirtualModelTarget[],
    context: PlanRouteContext,
  ): Promise<VirtualModelTarget | undefined> {
    const find = (choice: string) => targets.find((target) => target.upstreamModelId === choice);
    if (virtual.sessionSticky !== false) {
      const key = this.smartSessionKey(virtual.id, context.request);
      const remembered = this.smartStickyChoices.get(key);
      if (remembered) {
        const target = find(remembered);
        if (target) return target;
        this.smartStickyChoices.delete(key);
      }
      const decision = await this.askSmartRouter(virtual, targets, context);
      if (!decision) return undefined;
      const target = find(decision.choice);
      if (!target) return undefined;
      if (!this.smartStickyChoices.has(key)) {
        this.smartStickyOrder.push(key);
        if (this.smartStickyOrder.length > 500) {
          const oldest = this.smartStickyOrder.shift();
          if (oldest) this.smartStickyChoices.delete(oldest);
        }
      }
      this.smartStickyChoices.set(key, decision.choice);
      return target;
    }
    const decision = await this.askSmartRouter(virtual, targets, context);
    return decision ? find(decision.choice) : undefined;
  }

  /**
   * The fusion judge sees anonymised sources: a vendor's reputation must not decide the synthesis.
   * It is asked to analyse consensus and contradictions and then write one answer, never to merge text.
   */
  private buildFusionJudgePrompt(answers: readonly { source: number; text: string }[]): string {
    const panel = answers.map((answer) => `[Source ${answer.source}]\n${answer.text}`).join('\n\n');
    return [
      `You are the JUDGE in a model-fusion panel. ${answers.length} models independently answered the user's most recent request. Their responses are below, anonymised by source.`,
      'Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.',
      'First analyse consensus, contradictions, partial coverage, unique insights and blind spots internally; then write the best possible final answer grounded in that analysis.',
      '=== PANEL RESPONSES ===',
      panel,
      '=== END PANEL RESPONSES ===',
      'Now write the final answer to the user\'s original request.',
    ].join('\n');
  }

  /** Collect a panel with quorum + grace + hard timeout. A loser keeps running; its answer is ignored. */
  private collectPanel<T>(calls: readonly Promise<T>[], quorum: number, graceMs: number, hardTimeoutMs: number, signal?: AbortSignal): Promise<Array<T | undefined>> {
    const output = new Array<T | undefined>(calls.length);
    let settled = 0;
    let succeeded = 0;
    let finished = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish();
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hard);
      if (grace) clearTimeout(grace);
      signal?.removeEventListener('abort', onAbort);
      resolve(output);
    };
    let resolve!: (value: Array<T | undefined>) => void;
    const promise = new Promise<Array<T | undefined>>((r) => { resolve = r; });
    const hard = setTimeout(finish, hardTimeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    calls.forEach((call, index) => {
      void Promise.resolve(call)
        .then((value) => { output[index] = value; if (value !== undefined) succeeded += 1; })
        .catch(() => { output[index] = undefined; })
        .finally(() => {
          settled += 1;
          if (settled === calls.length) return finish();
          if (succeeded >= quorum && !grace) grace = setTimeout(finish, graceMs);
        });
    });
    if (calls.length === 0) finish();
    return promise;
  }

  /**
   * Fusion: every enabled target answers the same prompt in parallel with no tools, then one judge
   * model synthesises. Zero enabled targets is refused before any turn is paid for; one target is
   * answered directly because there is nothing to fuse. A client abort is forwarded to every member.
   */
  private async runFusion(
    virtual: VirtualModel,
    request: ChatRequest,
    signal?: AbortSignal,
    scope?: RequestScope,
  ): Promise<GatewayChatOutcome> {
    const connections = await this.listConnections();
    const targets = virtual.targets.filter((target) => target.enabled
      && connections.some((connection) => connection.id === target.connectionId && connection.enabled));
    if (targets.length === 0) {
      throw new ProviderError('INVALID_REQUEST', 'A fusion virtual model has no enabled targets.', {
        retryable: false,
        publicMessage: 'This fusion model has no enabled targets. Enable one on the Models page.',
      });
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const attempts: GatewayFailoverAttempt[] = [];
    try {
      if (targets.length === 1) {
        const single = targets[0]!;
        const outcome = await this.chatWithFailover({ ...request, model: single.upstreamModelId, connectionId: single.connectionId }, undefined, controller.signal, scope);
        attempts.push(...outcome.attempts);
        return { response: { ...outcome.response, model: request.model }, attempts };
      }
      const panelBody: ChatRequest = {
        ...request,
        stream: false,
        tools: undefined,
        toolChoice: undefined,
        connectionId: undefined,
      };
      const calls = targets.map((target, index) => (async () => {
        const started = Date.now();
        try {
          const outcome = await this.chatWithFailover({ ...panelBody, model: target.upstreamModelId, connectionId: target.connectionId }, undefined, controller.signal, scope);
          const served = outcome.attempts.find((attempt) => attempt.ok);
          attempts.push({
            providerId: served?.providerId ?? outcome.response.providerId,
            connectionId: target.connectionId,
            attempt: index + 1,
            ok: true,
            latencyMs: Date.now() - started,
          });
          return { source: index + 1, text: typeof outcome.response.message.content === 'string' ? outcome.response.message.content : '' };
        } catch (error) {
          attempts.push({
            providerId: 'fusion-panel',
            connectionId: target.connectionId,
            attempt: index + 1,
            ok: false,
            latencyMs: Date.now() - started,
            ...(isProviderError(error) ? { errorCode: error.code } : { errorCode: 'FUSION_PANEL_FAILED' }),
          });
          return undefined;
        }
      })());
      const settled = await this.collectPanel(
        calls,
        Math.min(virtual.quorum ?? 2, targets.length),
        virtual.graceMs ?? 2_000,
        virtual.hardTimeoutMs ?? 90_000,
        controller.signal,
      );
      const answers = settled.filter((entry): entry is { source: number; text: string } => entry !== undefined && entry.text.length > 0);
      if (answers.length === 0) {
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'Every fusion panel member failed.', {
          retryable: false,
          publicMessage: 'No fusion panel member answered, so there is nothing to synthesise.',
        });
      }
      const judgeStarted = Date.now();
      const judge = await this.chatWithFailover({
        ...request,
        model: virtual.judgeModel!,
        messages: [...request.messages, { role: 'user', content: this.buildFusionJudgePrompt(answers) }],
        stream: false,
        connectionId: undefined,
      }, undefined, controller.signal, scope);
      const served = judge.attempts.find((attempt) => attempt.ok);
      attempts.push({
        providerId: served?.providerId ?? judge.response.providerId,
        connectionId: served?.connectionId,
        attempt: targets.length + 1,
        ok: true,
        latencyMs: Date.now() - judgeStarted,
      });
      return { response: { ...judge.response, model: request.model }, attempts };
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private enforceRateLimit(candidate: RouteCandidate) {
    this.routing.enforceRateLimit(candidate);
  }

  /**
   * Runs one direct provider operation through the same account controls chat uses.
   *
   * System One and video used to reach the transport themselves. They authenticated and applied
   * their own timeout, but nothing spent the account's RPM, consulted its breaker or fed the health
   * sweep — so a connection could be disabled, exhausted or already open and still be called.
   */
  private async runConnectionOperation<T>(input: {
    providerId: string;
    connection?: ConnectionRecord;
    model: string;
    signal?: AbortSignal;
    run: (deadline: AbortSignal | undefined) => Promise<T>;
  }): Promise<T> {
    const connection = input.connection;
    if (!connection) return input.run(input.signal);
    if (!connection.enabled) {
      throw new ProviderError('INVALID_REQUEST', `Connection "${connection.id}" is disabled.`, {
        providerId: input.providerId,
        retryable: false,
        publicMessage: `Connection "${connection.id}" is paused. Enable it before sending a request.`,
      });
    }
    const candidate: RouteCandidate = {
      providerId: input.providerId,
      connectionId: connection.id,
      priority: connection.priority,
      resilience: connection.resilience,
    };
    if (!this.breakers.allows(connection.id)) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'The connection is cooling down after repeated failures.', {
        providerId: input.providerId,
        retryable: false,
        publicMessage: 'This connection is cooling down after repeated failures. Try another account or wait for it to recover.',
      });
    }
    try {
      this.enforceRateLimit(candidate);
    } catch (error) {
      this.breakers.recordAbandoned(connection.id);
      throw error;
    }
    this.rateLimiter.record(connection.id);
    const startedAt = Date.now();
    try {
      const result = await this.withDeadline(input.signal, connection.resilience.timeoutMs, input.providerId, input.run);
      const latencyMs = Date.now() - startedAt;
      this.healthManager.recordSuccess(input.providerId, latencyMs, new Date().toISOString(), connection.id);
      this.connectionLatency.record(connection.id, latencyMs);
      this.breakers.recordSuccess(connection.id);
      if (!connection.id.startsWith('unmanaged:')) void this.connectionStore?.recordUsage(connection.id).catch(() => undefined);
      return result;
    } catch (error) {
      const code = isProviderError(error) ? error.code : 'PROVIDER_REQUEST_FAILED';
      const callerFault = code === 'CANCELLED' || code === 'INVALID_REQUEST' || code === 'NOT_SUPPORTED';
      if (!callerFault) {
        this.healthManager.recordFailure(input.providerId, code, error instanceof Error ? error.message : 'The provider request failed.', connection.id);
        this.breakers.recordFailure(connection.id);
      } else {
        this.breakers.recordAbandoned(connection.id);
      }
      throw error;
    }
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
    const strategy = this.providers.validationStrategy(providerId);
    if (strategy === 'none') {
      throw new ProviderError('NOT_SUPPORTED', `${providerId} cannot check a key before it is saved.`, {
        providerId,
        publicMessage: `${providerId} cannot check a candidate key. Its sign-in is its proof, or the check would prove nothing; save the connection and use Test to check the saved credential.`,
      });
    }
    if (strategy === 'credential') {
      if (!adapter.validateCredential) throw notSupported(adapter, 'credential validation');
      const result = await adapter.validateCredential(credential, context);
      return { providerId, valid: true, checkedAt: result?.checkedAt ?? new Date().toISOString(), ...(result?.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }) };
    }
    // `models`: an authenticated catalog read is a real check only for a provider whose catalog
    // refuses unauthenticated reads. A declaration here is a claim that this was measured.
    if (!adapter.listModels) throw notSupported(adapter, 'credential validation');
    const startedAt = Date.now();
    const models = await adapter.listModels(context);
    if (!Array.isArray(models) || models.length === 0) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', `${providerId} listed no models for this key.`, {
        providerId,
        publicMessage: `${providerId} accepted the request but listed no models, so the key cannot be confirmed.`,
      });
    }
    return { providerId, valid: true, checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt };
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
    throw new ProviderError('NOT_SUPPORTED', `${connection.providerId} has no saved-credential check.`, {
      providerId: connection.providerId,
      publicMessage: `${connection.providerId} exposes neither a credential check nor a model catalog, so this connection cannot be tested from here.`,
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

  /** The opt-in detail store, or `undefined` when this gateway records no request detail. */
  get requestDetailStore(): RequestDetailStore | undefined {
    return this.requestDetails;
  }

  /** Records one whitelisted, sanitised detail. Absent store is a no-op. */
  async recordRequestDetail(input: RequestDetailInput): Promise<void> {
    await this.requestDetails?.record(input).catch(() => undefined);
  }

  /**
   * A bounded document read through the gateway's own transport.
   *
   * This is deliberately not the transport's `assertDestination` alone: that hook intentionally skips
   * loopback so a local Ollama base URL keeps working, which is exactly the opposite of what an
   * arbitrary user-supplied URL needs. Every check below is applied here, including the async DNS
   * resolution in `assertPublicDestination` — the hostname-text check in `url.ts` cannot see a name
   * that resolves to 127.0.0.1.
   */
  async fetchDocument(input: { url: string; maxBytes?: number; signal?: AbortSignal }): Promise<{ url: string; status: number; contentType: string; bytes: number; truncated: boolean; text: string }> {
    const { url, maxBytes = 256 * 1024, signal } = input;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ProviderError('INVALID_REQUEST', 'url must be an absolute HTTP(S) URL.', { publicMessage: 'url must be an absolute HTTP(S) URL.' });
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new ProviderError('INVALID_REQUEST', 'Only a public https URL without credentials can be fetched.', { publicMessage: 'Only a public https URL without credentials can be fetched.' });
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/, '');
    if (isLoopbackHostname(hostname) || isPrivateHostname(hostname)) {
      throw new ProviderError('INVALID_REQUEST', 'Private and loopback destinations cannot be fetched.', { publicMessage: 'Private and loopback destinations cannot be fetched.' });
    }
    await assertPublicDestination(hostname, signal).catch((error: unknown) => {
      throw new ProviderError('INVALID_REQUEST', 'The URL resolved to a private destination.', {
        publicMessage: 'The URL resolved to a private destination.',
        cause: error,
      });
    });
    const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, 1024 * 1024) : 256 * 1024;
    const response = await this.transport.request<string>({
      method: 'GET',
      url: parsed.toString(),
      providerId: 'web-fetch',
      headers: { accept: 'text/plain, text/html;q=0.9, application/json;q=0.8' },
      ...(signal ? { signal } : {}),
    });
    const raw = typeof response.data === 'string' ? response.data : String(response.data ?? '');
    const bytes = Buffer.byteLength(raw, 'utf8');
    const truncated = bytes > limit;
    const text = truncated ? Buffer.from(raw, 'utf8').subarray(0, limit).toString('utf8') : raw;
    return {
      url: parsed.toString(),
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      bytes: truncated ? limit : bytes,
      truncated,
      text,
    };
  }

  /** Whether a named provider declares a real web-fetch capability. Absent adapters answer false. */
  async supportsWebFetch(providerId: string): Promise<boolean> {
    const adapter = await this.resolveAdapter(providerId).catch(() => undefined);
    return (adapter?.capabilities as Record<string, unknown> | undefined)?.webFetch === true;
  }

  /**
   * Whether a named provider declares video generation.
   *
   * Reading the flag here rather than duplicating a capability list in the route means an adapter
   * opts in from its own package, without editing 54 vendored type copies or the HTTP handler.
   */
  async supportsVideoGeneration(providerId: string): Promise<boolean> {
    const adapter = await this.resolveAdapter(providerId).catch(() => undefined);
    return (adapter?.capabilities as Record<string, unknown> | undefined)?.video === true;
  }

  /**
   * The System One endpoint declared for one saved account, by connection id first.
   *
   * A provider-wide entry is the fallback because several accounts of one vendor share a wire. An
   * entry keyed by connection id is the more specific declaration and wins. Neither is guessed from
   * the connection's generic chat endpoint: a decision model's native JSON wire is a different lane.
   */
  systemOneEndpointFor(providerId: string, connectionId: string | undefined): string | undefined {
    const endpoints = this.options.systemOne?.endpoints;
    if (!endpoints) return undefined;
    return (connectionId ? endpoints[connectionId] : undefined) ?? endpoints[providerId];
  }

  /**
   * One System One turn: native JSON in, native JSON out.
   *
   * The request body is forwarded untouched apart from the model, which is replaced by the catalog's
   * stated upstream id when one exists. No client session header, no `public` access token and no
   translated chat body are invented: those would impersonate a vendor's own client. Failover uses the
   * same route candidates chat uses, and success or failure is recorded against the account that was
   * actually called. A connection with no declared endpoint is refused by name as `NOT_SUPPORTED`.
   */
  async runSystemOne(input: {
    model: string;
    body: Record<string, unknown>;
    connectionId?: string;
    explicitProviderId?: string;
    signal?: AbortSignal;
  }): Promise<{ body: unknown; providerId: string; connectionId?: string; wireModel: string; attempts: number }> {
    const decision = await this.planRoute(input.model, input.explicitProviderId, input.connectionId);
    if (decision.candidates.length === 0) {
      const message = noCandidateMessage;
      throw new ProviderError('PROVIDER_UNAVAILABLE', message, { retryable: false, publicMessage: message });
    }
    const connections = await this.listConnections();
    const withoutEndpoint: string[] = [];
    const failures: string[] = [];
    let attempts = 0;
    for (const candidate of decision.candidates) {
      const connection = connections.find((entry) => entry.id === candidate.connectionId);
      if (!connection) continue;
      const endpoint = this.systemOneEndpointFor(connection.providerId, connection.id);
      if (!endpoint) {
        withoutEndpoint.push(connection.providerId);
        continue;
      }
      const wireModel = await this.upstreamModelFor(connection.providerId, connection.id, candidate.model ?? input.model);
      const context = await this.contextForRequest(connection.providerId, connection.id, input.signal);
      const credential = context.credential;
      const token = credential && credential.type !== 'none' ? credential.value : undefined;
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(this.options.systemOne?.headers ?? {}),
      };
      const body = JSON.stringify({ ...input.body, model: wireModel });
      attempts += 1;
      try {
        const response = await this.runConnectionOperation({
          providerId: connection.providerId,
          connection,
          model: candidate.model ?? input.model,
          signal: input.signal,
          run: (deadline) => this.transport.request<unknown>({
            method: 'POST',
            url: endpoint,
            providerId: connection.providerId,
            headers,
            body,
            ...(deadline ? { signal: deadline } : {}),
          }),
        });
        return { body: response.data, providerId: connection.providerId, connectionId: connection.id, wireModel, attempts };
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'the endpoint refused the request');
      }
    }
    if (withoutEndpoint.length > 0 && failures.length === 0) {
      const names = [...new Set(withoutEndpoint)].join(', ');
      const message = `Provider "${names}" declares no System One endpoint; no native decision turn was sent.`;
      throw new ProviderError('NOT_SUPPORTED', message, { retryable: false, publicMessage: message, details: { attempts } });
    }
    const message = `No System One route answered. ${[...new Set(failures)].join('; ')}`;
    throw new ProviderError('PROVIDER_UNAVAILABLE', message, { retryable: false, publicMessage: message, details: { attempts } });
  }

  /**
   * The one video round-trip, resolved against the pinned connection.
   *
   * The adapter is resolved with the connection id so a saved endpoint override reaches the same
   * adapter chat uses, and the credential comes from `contextForRequest` — never from the request
   * body or from a provider-wide fallback. An adapter that declares video but has no handler is
   * refused by name: the capability is a claim, and a claim without a handler is not a job.
   */
  async createVideoGeneration(providerId: string, connectionId: string | undefined, action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayVideoJob> {
    return this.runVideoGeneration(providerId, connectionId, { kind: 'create', action, body }, signal);
  }

  async pollVideoGeneration(providerId: string, connectionId: string | undefined, id: string, signal?: AbortSignal): Promise<GatewayVideoJob> {
    return this.runVideoGeneration(providerId, connectionId, { kind: 'poll', id }, signal);
  }

  private async runVideoGeneration(providerId: string, connectionId: string | undefined, request: GatewayVideoRequest, signal?: AbortSignal): Promise<GatewayVideoJob> {
    const adapter = await this.resolveAdapter(providerId, undefined, connectionId).catch(() => undefined) as VideoCapableAdapter | undefined;
    const attempts: GatewayFailoverAttempt[] = [{
      providerId,
      ...(connectionId ? { connectionId } : {}),
      attempt: 1,
      ok: false,
      latencyMs: 0,
      errorCode: 'NOT_SUPPORTED',
    }];
    const refuse = (message: string): never => {
      throw new ProviderError('NOT_SUPPORTED', message, {
        providerId,
        retryable: false,
        publicMessage: message,
        details: { attempts },
      });
    };
    if (!adapter || (adapter.capabilities as Record<string, unknown> | undefined)?.video !== true) {
      return refuse(`Provider "${providerId}" does not declare video generation; no video job was created and no job URL was invented.`);
    }
    if (typeof adapter.video !== 'function') {
      return refuse(`Provider "${providerId}" declares video generation, but no generation handler is wired; no video job was created and no job URL was invented.`);
    }
    const context = await this.contextForRequest(providerId, connectionId, signal);
    const connection = connectionId ? await this.connections.get(connectionId) : undefined;
    return this.runConnectionOperation({
      providerId,
      ...(connection ? { connection } : {}),
      model: request.kind === 'create' && typeof request.body.model === 'string' ? request.body.model : 'video-generation',
      signal,
      run: () => adapter.video!.call(adapter, request, context),
    });
  }

  /** The virtual-model catalog, or `undefined` when this build has no persisted store. */
  get virtualModels(): VirtualModelStore | undefined {
    return this.virtualModelStore;
  }

  get workspaces(): WorkspaceStore | undefined {
    return this.workspaceStore;
  }

  get tunnels(): TunnelStore | undefined {
    return this.tunnelStore;
  }

  get mitm(): MitmStore | undefined {
    return this.mitmStore;
  }

  get proxyPools(): ProxyPoolStore | undefined {
    return this.proxyPoolStore;
  }

  get providerNodes(): ProviderNodeStore | undefined {
    return this.providerNodeStore;
  }

  /** The skill catalog, or `undefined` when this build has no persisted store. */
  get skills(): SkillStore | undefined {
    return this.skillStore;
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
    const service = this;
    return new Proxy(store, {
      get(target, property) {
        if (property === 'record') {
          return async (entry: Parameters<UsageStore['record']>[0]) => {
            // Attribution is applied once, at the write boundary, from the request's ambient principal.
            // An entry that already states who it belongs to keeps its own answer: a test and a
            // backfill are allowed to be explicit, and a record must never be re-attributed by a
            // request that merely ran beside it.
            const attributed = entry.actor === undefined
              ? { ...entry, ...principalUsageFields(currentPrincipal()) }
              : entry;
            const record = await target.record(attributed);
            for (const listener of listeners) {
              try { listener(record); } catch { /* a listener must not fail the request */ }
            }
            service.otelExporter?.record(spanFromUsage(record) ?? { name: 'gen_ai.chat', traceId: record.requestId ?? '0'.repeat(32), startMs: Date.now() - record.latencyMs, endMs: Date.now(), attributes: { 'gen_ai.request.model': record.model, 'omnihilbras.outcome': record.outcome } });
            void service.settleSpend(record).catch(() => undefined);
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

  /** The batch store, when this gateway was started with one. */
  get batches(): BatchStore | undefined {
    return this.batchStore;
  }

  /** The prompt registry, when this gateway was started with one. */
  get prompts(): LocalPromptStore | undefined {
    return this.promptStore;
  }


  /** The webhook registry, when this gateway was started with one. */
  get webhooks(): LocalWebhookStore | undefined {
    return this.webhookStore;
  }

  /** Recent webhook deliveries, newest first. */
  webhookDeliveries(limit = 50): WebhookDelivery[] {
    return this.webhookDispatcher?.list(limit) ?? [];
  }

  /** Delivers one event to every subscribed hook. Never throws. */
  async deliverWebhook(event: WebhookEvent, payload: unknown): Promise<WebhookDelivery[]> {
    try { return (await this.webhookDispatcher?.deliver(event, payload)) ?? []; } catch { return []; }
  }

  /** Empties the exact cache. The semantic cache, when wired, is cleared with it. */
  async clearResponseCache(): Promise<void> {
    await this.responseCache.clear();
  }

  /**
   * Submits a batch and starts it. The record is created before any request is sent, so a caller that
   * loses the connection can still find what it asked for.
   */
  async submitBatch(items: BatchItem[]): Promise<BatchRecord | undefined> {
    if (!this.batchStore) return undefined;
    const principal = currentPrincipal();
    const record = await this.batchStore.create({
      status: 'in_progress',
      items,
      results: [],
      ...(principal?.apiKeyId === undefined ? {} : { apiKeyId: principal.apiKeyId }),
      ...(principal?.workspaceId === undefined ? {} : { workspaceId: principal.workspaceId }),
    });
    const controller = new AbortController();
    this.batchControllers.set(record.id, controller);
    void this.runBatch(record.id, items, principal, controller.signal);
    return record;
  }

  /** Cancels a running batch; the record is updated when its workers stop. */
  async cancelBatch(id: string): Promise<BatchRecord | undefined> {
    const controller = this.batchControllers.get(id);
    if (!controller) return undefined;
    controller.abort();
    return this.batchStore?.get(id);
  }

  private async runBatch(id: string, items: BatchItem[], principal: ReturnType<typeof currentPrincipal>, signal: AbortSignal): Promise<void> {
    const results: BatchResult[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length && !signal.aborted) {
        const item = items[cursor++]!;
        try {
          const request = batchChatRequest(item.body);
          const scope = this.startScope(request.model, undefined, true);
          await runWithPrincipal(principal ?? { actor: 'anonymous' }, async () => {
            const refusal = await this.reserveBudget({ requestId: scope.id, model: request.model, messages: request.messages, maxOutputTokens: request.maxOutputTokens });
            if (refusal) throw new ProviderError(refusal.code, refusal.message);
            const outcome = await this.chatWithFailover(request, undefined, signal, scope);
            results.push({
              customId: item.customId,
              ok: true,
              response: {
                model: outcome.response.model,
                content: outcome.response.message.content ?? '',
                ...(outcome.response.usage ? { usage: outcome.response.usage } : {}),
              },
            });
          });
        } catch (error) {
          results.push({ customId: item.customId, ok: false, error: error instanceof Error ? error.message.slice(0, 300) : 'The request failed.' });
        }
      }
    };
    await Promise.all([worker(), worker()]);
    this.batchControllers.delete(id);
    const status = signal.aborted ? 'cancelled' : 'completed';
    await this.batchStore?.update(id, { status, results, completedAt: new Date().toISOString() });
    void this.deliverWebhook('batch.completed', { batchId: id, status, completed: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length });
  }

  /**
   * Orders documents through a connection whose adapter declares `rerank`.
   *
   * Returns undefined when no connection can do it: a gateway that invented relevance scores would be
   * answering a different question.
   */
  async rerank(
    input: { model: string; query: string; documents: Array<{ index: number; text: string; id?: string }>; topN?: number },
    signal?: AbortSignal,
  ): Promise<{ results: Array<{ index: number; relevanceScore: number; document?: string }>; providerId?: string; connectionId?: string } | undefined> {
    const connections = (await this.connections.list()).filter((connection) => connection.enabled && (connection.modelPolicy === 'all' || connection.modelIds.includes(input.model)));
    for (const connection of connections) {
      const adapter = this.registry.get(connection.providerId) as ProviderAdapter & {
        rerank?: (request: { model: string; query: string; documents: Array<{ index: number; text: string; id?: string }>; topN?: number }, context: ProviderRequestContext) => Promise<Array<{ index: number; relevanceScore: number; document?: string }>>;
      };
      if (typeof adapter.rerank !== 'function') continue;
      const context = await this.contextForAdapter(connection.providerId, signal);
      const results = await adapter.rerank(input, context);
      return { results, providerId: connection.providerId, connectionId: connection.id };
    }
    return undefined;
  }

  async modelPrice(connectionId: string | undefined, model: string): Promise<ModelPricing | undefined> {
    if (!connectionId) return undefined;
    const record = (await this.connections.list()).find((connection) => connection.id === connectionId);
    return pricingFromConnection(record, model);
  }

  /** The durable spend ledger, when this gateway was started with one. */
  get spend(): SpendLedger | undefined {
    return this.spendLedger;
  }

  /** Budget gate counters for `/metrics`. */
  budgetMetrics(): { checks: number; usdRefusals: number; tokenRefusals: number; policyRefusals: number } {
    return { ...this.budgetCounters };
  }

  /**
   * Provider connection-pool counters for `/metrics`.
   *
   * `reused` is the number that says whether the pool is doing its job: a request that reused a socket
   * paid no TCP or TLS handshake. The counters are process-lifetime and never reset by a request, which
   * is what a counter is for.
   */
  providerHttpMetrics(): ProviderHttpStats {
    return currentProviderHttpStats();
  }

  /** The guardrail policy store, when this gateway was started with one. */
  get guardrails(): LocalGuardrailStore | undefined {
    return this.guardrailStore;
  }

  /**
   * The most expensive quote any connection offers for this model.
   *
   * A reservation must not under-estimate: the request has not been routed yet, so the price that
   * matters is the worst one it could be served at. `undefined` means no connection quotes a price,
   * which is a normal state and is carried through as "unpriced" rather than as free.
   */
  async maxModelPrice(model: string): Promise<ModelPricing | undefined> {
    const connections = await this.connections.list();
    let best: ModelPricing | undefined;
    for (const connection of connections) {
      const pricing = pricingFromConnection(connection, model);
      if (!pricing) continue;
      if (!best) { best = pricing; continue; }
      best = {
        ...best,
        ...(pricing.inputPer1M !== undefined ? { inputPer1M: Math.max(best.inputPer1M ?? 0, pricing.inputPer1M) } : {}),
        ...(pricing.outputPer1M !== undefined ? { outputPer1M: Math.max(best.outputPer1M ?? 0, pricing.outputPer1M) } : {}),
      };
    }
    return best;
  }

  /**
   * What this request may spend, resolved from the key's own budget or its workspace default.
   *
   * Absent means no budget applies — the historical behaviour. A key with a budget and no ledger is
   * refused: a guardrail that cannot read spend must not pretend the spend is zero.
   */
  async requestBudget(): Promise<{ budget: Budget; scope: 'key' | 'workspace'; id: string } | undefined> {
    const principal = currentPrincipal();
    if (!principal || principal.actor !== 'key' || principal.apiKeyId === undefined) return undefined;
    if (principal.budget) return { budget: principal.budget, scope: 'key', id: principal.apiKeyId };
    if (principal.workspaceId === undefined) return undefined;
    const workspace = await this.workspaceStore?.get(principal.workspaceId);
    return workspace?.budget ? { budget: workspace.budget, scope: 'workspace', id: principal.workspaceId } : undefined;
  }

  /**
   * Checks the budget and reserves the worst-case cost for one request.
   *
   * Returns a refusal the route can send, or `undefined` when the request may proceed. The hold is
   * keyed by request id and released when the usage record settles, so two requests dispatched at
   * once see each other's reservation rather than both reading the same remaining amount.
   */
  async reserveBudget(input: { requestId: string; model: string; route?: string; messages?: unknown; maxOutputTokens?: number; inputTokens?: number }): Promise<{
    status: 402 | 403 | 429;
    code: 'BUDGET_EXCEEDED' | 'QUOTA_EXCEEDED' | 'POLICY_DENIED';
    message: string;
    headers: Record<string, string>;
  } | undefined> {
    const principal = currentPrincipal();
    if (principal?.actor === 'key') {
      const allowedModels = principal.allowedModels;
      if (allowedModels && allowedModels.length > 0 && !allowedModels.some((pattern) => globMatches(pattern, input.model))) {
        this.budgetCounters.policyRefusals += 1;
        return { status: 403, code: 'POLICY_DENIED', message: `This key may not request ${input.model}.`, headers: {} };
      }
      const allowedRoutes = principal.allowedRoutes;
      if (input.route && allowedRoutes && allowedRoutes.length > 0 && !allowedRoutes.includes(input.route)) {
        this.budgetCounters.policyRefusals += 1;
        return { status: 403, code: 'POLICY_DENIED', message: `This key may not call ${input.route}.`, headers: {} };
      }
    }
    if (principal?.actor === 'key' && principal.apiKeyId && principal.tpm !== undefined && principal.tpm > 0) {
      const now = Date.now();
      const window = this.tokenWindows.get(principal.apiKeyId);
      const current = window && now - window.start < 60_000 ? window : { start: now, tokens: 0 };
      const estimate = input.inputTokens ?? estimatePromptTokens(Array.isArray(input.messages) ? input.messages : undefined) ?? 0;
      const wanted = estimate + (input.maxOutputTokens ?? this.maxOutputTokensCap ?? 4096);
      if (current.tokens > 0 && current.tokens + wanted > principal.tpm) {
        this.budgetCounters.tokenRefusals += 1;
        return {
          status: 429,
          code: 'QUOTA_EXCEEDED',
          message: `This key may spend ${principal.tpm} tokens per minute.`,
          headers: { 'retry-after': String(Math.max(1, Math.ceil((60_000 - (now - current.start)) / 1000))), 'x-omnihilbras-tpm-remaining': String(Math.max(0, principal.tpm - current.tokens)) },
        };
      }
      current.tokens += wanted;
      this.tokenWindows.set(principal.apiKeyId, current);
    }
    const policy = await this.requestBudget();
    if (!policy) return undefined;
    this.budgetCounters.checks += 1;
    if (!this.spendLedger) {
      return {
        status: 402,
        code: 'BUDGET_EXCEEDED',
        message: 'This key has a budget but this gateway has no spend ledger, so the budget cannot be enforced.',
        headers: {},
      };
    }
    const snapshot = await this.spendLedger.snapshot(policy.scope, policy.id, policy.budget.period);
    const status = evaluateBudget(policy.budget, snapshot);
    const headers: Record<string, string> = {};
    if (status.remainingUsdMicros !== undefined) headers['x-omnihilbras-budget-remaining-usd'] = (status.remainingUsdMicros / 1_000_000).toFixed(6);
    if (status.remainingTokens !== undefined) headers['x-omnihilbras-budget-remaining-tokens'] = String(status.remainingTokens);
    if (status.resetAt) headers['x-omnihilbras-budget-reset'] = status.resetAt;
    if (!status.allowed) {
      const resetSeconds = status.resetAt ? Math.max(1, Math.ceil((Date.parse(status.resetAt) - Date.now()) / 1000)) : undefined;
      if (resetSeconds) headers['retry-after'] = String(resetSeconds);
      if (status.kind === 'usd') this.budgetCounters.usdRefusals += 1;
      else this.budgetCounters.tokenRefusals += 1;
      return {
        status: status.kind === 'usd' ? 402 : 429,
        code: status.kind === 'usd' ? 'BUDGET_EXCEEDED' : 'QUOTA_EXCEEDED',
        message: status.kind === 'usd'
          ? `This key has reached its ${policy.budget.period} dollar budget.`
          : `This key has reached its ${policy.budget.period} token quota.`,
        headers,
      };
    }
    const estimated = await this.estimateReservationMicros(input);
    if (estimated > 0) {
      await this.spendLedger.hold({ scope: policy.scope, id: policy.id, requestId: input.requestId, usdMicros: estimated });
    }
    return undefined;
  }

  /** Worst-case cost of one request, in micro-USD. Zero when no connection quotes a price. */
  private async estimateReservationMicros(input: { model: string; messages?: unknown; maxOutputTokens?: number; inputTokens?: number }): Promise<number> {
    const pricing = await this.maxModelPrice(input.model);
    if (!pricing) return 0;
    const inputTokens = input.inputTokens ?? estimatePromptTokens(Array.isArray(input.messages) ? input.messages : undefined) ?? 0;
    const outputTokens = input.maxOutputTokens ?? this.maxOutputTokensCap ?? 4096;
    const cost = ((pricing.inputPer1M ?? 0) * inputTokens + (pricing.outputPer1M ?? 0) * outputTokens) / 1_000_000;
    return Math.max(0, Math.round(cost * 1_000_000));
  }

  /** Settles one usage record into the ledger, releasing the reservation it carried. */
  private async settleSpend(record: UsageRecord): Promise<void> {
    const ledger = this.spendLedger;
    if (!ledger) return;
    const apiKeyId = record.apiKeyId;
    const workspaceId = record.workspaceId;
    if (!apiKeyId && !workspaceId) {
      if (record.requestId) await ledger.release(record.requestId);
      return;
    }
    const pricing = await this.modelPrice(record.connectionId, record.model);
    const cost = requestCostUsd({ ...record, pricing });
    const entry = {
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      ...(cost === undefined ? { unpriced: true } : { usdMicros: Math.round(cost * 1_000_000) }),
    };
    if (apiKeyId) await ledger.record({ scope: 'key', id: apiKeyId, requestId: record.requestId, ...entry });
    if (workspaceId) await ledger.record({ scope: 'workspace', id: workspaceId, ...entry });
    await this.checkBudgetThresholds(record);
  }

  /**
   * Emits `budget.threshold` once per scope, period and threshold when spend crosses 80% or 100%.
   *
   * The dedupe key includes the period's reset date, so a new day can alert again while a hundred
   * requests in the same minute produce one notification. Failure to deliver is never allowed to
   * affect the request that caused it; `deliverWebhook` already swallows.
   */
  private async checkBudgetThresholds(record: UsageRecord): Promise<void> {
    if (!this.webhookDispatcher || !this.spendLedger) return;
    let budget: Budget | undefined;
    let scope: 'key' | 'workspace' = 'key';
    let id: string | undefined;
    if (record.apiKeyId) {
      const key = (await this.listApiKeys()).keys.find((candidate) => candidate.id === record.apiKeyId);
      if (key?.budget) { budget = key.budget; id = key.id; }
    }
    if (!budget && record.workspaceId) {
      const workspace = await this.workspaceStore?.get(record.workspaceId);
      if (workspace?.budget) { budget = workspace.budget; scope = 'workspace'; id = workspace.id; }
    }
    if (!budget || !id) return;
    const snapshot = await this.spendLedger.snapshot(scope, id, budget.period);
    const ratio = budget.usd !== undefined
      ? snapshot.usdMicros / Math.max(1, Math.round(budget.usd * 1_000_000))
      : budget.tokens !== undefined
        ? snapshot.tokens / Math.max(1, budget.tokens)
        : 0;
    const reset = budget.period === 'total' ? 'total' : new Date().toISOString().slice(0, 10);
    for (const threshold of [0.8, 1] as const) {
      if (ratio < threshold) continue;
      const key = `${scope}:${id}:${budget.period}:${reset}:${threshold}`;
      if (this.budgetAlerts.has(key)) continue;
      this.budgetAlerts.add(key);
      void this.deliverWebhook('budget.threshold', {
        scope, id, period: budget.period, threshold,
        spentUsd: snapshot.usdMicros / 1_000_000,
        spentTokens: snapshot.tokens,
        limitUsd: budget.usd,
        limitTokens: budget.tokens,
      });
    }
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
  private async contextForAdapter(providerId: string, signal?: AbortSignal, scope?: RequestScope, options: { refuseWhenExpired?: boolean } = {}): Promise<ProviderRequestContext> {
    return this.credentials.contextForProvider(providerId, signal, scope, options);
  }



}

