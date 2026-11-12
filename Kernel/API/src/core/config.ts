import { FetchHttpTransport, ProviderRegistry, canonicalLoopbackHost, isLoopbackHostname, loopbackBaseUrl, type ProviderCredential, type SecretStore } from './index.js';
import { AnthropicAdapter } from '@omnihilbras/sdk-anthropic';
import { OpenAICompatibleAdapter } from '@omnihilbras/sdk-openai';
import { GeminiAdapter } from '@omnihilbras/sdk-gemini';
import { OpenAIAdapter } from '@omnihilbras/sdk-openai';
import { OpenRouterAdapter } from '@omnihilbras/sdk-openrouter';
import { LocalApiKeyStore, type ApiKeyStore } from './api-keys.js';
import { assertPublicDestination } from './destination-check.js';
import { LocalUsageStore } from './usage-store.js';
import { LocalVirtualModelStore } from './virtual-models.js';
import { LocalSkillStore } from './skills.js';
import { LocalWorkspaceStore } from './workspaces.js';
import { LocalTunnelStore } from './tunnels.js';
import { LocalMitmStore } from './mitm.js';
import { LocalProxyPoolStore } from './proxy-pools.js';
import { LocalProviderNodeStore } from './provider-nodes.js';
import { defaultConnectionDirectory, LocalConnectionStore, parseMasterKey, type ConnectionStore } from './connections.js';
import { GatewayService } from './service.js';
import { CAVEMAN_LEVELS, PONYTAIL_LEVELS, type CavemanLevel, type PonytailLevel } from '@omnihilbras/token-saver';
import { localDeployment, type DeploymentConfig } from './runtime.js';

export type GatewayConfig = {
  host: string;
  port: number;
  timeoutMs: number;
  /** Background provider health polling interval. 0 disables polling. */
  healthIntervalMs: number;
  /** Consecutive failures before a connection stops receiving traffic. */
  failureThreshold: number;
  /** How long an ejected connection waits before one probe request. */
  recoveryCooldownMs: number;
  corsOrigins: string[];
  dataDir: string;
  tokenSaver: {
    enabled: boolean;
    targetRatio: number;
    protectRecent: number;
    compressUsers: boolean;
    compressCode: boolean;
    reversible: boolean;
    ccrLimit: number;
  };
  /** 0/undefined means no cap. Applied before every adapter. */
  maxOutputTokensCap?: number;
  /** 0/undefined means no cap. Applied to adapters that take a thinking budget. */
  thinkingBudgetCap?: number;
  /** Threshold history trimming in estimated input tokens. */
  historyTrim?: { maxInputTokens: number; keepRecent: number };
  /** Re-anchor provider cache breakpoints on the final body. */
  cacheAnchor?: boolean;
  /** Output-shaping prompt levels. */
  caveman?: { level: CavemanLevel };
  ponytail?: { level: PonytailLevel };
  /** Optional external compressor. */
  headroom?: { url: string; timeoutMs?: number; compressUserMessages?: boolean };
  /** Optional Anthropic-only image-context hook. */
  pxpipe?: { url: string; timeoutMs?: number; minChars?: number };
  codex: {
    clientId?: string;
    redirectUri?: string;
    /**
     * The CLI version sent to the Codex catalog endpoint. Overridable because that value decides
     * how many model entries come back, and too low a value hides them silently.
     */
    clientVersion?: string;
  };
  openai: {
    baseUrl: string;
    organization?: string;
    project?: string;
  };
  anthropic: {
    baseUrl: string;
    apiVersion?: string;
  };
  gemini: {
    baseUrl: string;
  };
  openrouter: {
    baseUrl: string;
  };
  compatible: {
    id: string;
    name: string;
    baseUrl: string;
    authHeader?: string;
    authPrefix?: string;
    modelsPath?: string;
    chatPath?: string;
    authRequired: boolean;
  };
};

export class EnvironmentSecretStore implements SecretStore {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly compatibleProviderId = 'openai-compatible',
  ) {}

  async get(providerId: string) {
    const value = this.env[providerEnvKey(providerId)]
      ?? (providerId === this.compatibleProviderId ? this.env.OMNIHILBRAS_COMPATIBLE_API_KEY : undefined);
    return value ? { type: 'api-key' as const, value } satisfies ProviderCredential : undefined;
  }
}

export function loadGatewayConfig(env: Readonly<Record<string, string | undefined>> = process.env): GatewayConfig {
  const host = canonicalLoopbackHost(env.OMNIHILBRAS_HOST ?? '127.0.0.1');
  assertLoopbackHost(host);
  parseMasterKey(env.OMNIHILBRAS_MASTER_KEY);
  const compatibleId = env.OMNIHILBRAS_COMPATIBLE_PROVIDER_ID ?? 'openai-compatible';
  const compatibleCredential = env[providerEnvKey(compatibleId)]
    ?? env.OMNIHILBRAS_COMPATIBLE_API_KEY;
  const caveman = parseChoice(env.OMNIHILBRAS_CAVEMAN, CAVEMAN_LEVELS, 'OMNIHILBRAS_CAVEMAN');
  const ponytail = parseChoice(env.OMNIHILBRAS_PONYTAIL, PONYTAIL_LEVELS, 'OMNIHILBRAS_PONYTAIL');
  const headroomUrl = parseOptionalUrl(env.OMNIHILBRAS_HEADROOM_URL, 'OMNIHILBRAS_HEADROOM_URL');
  const pxpipeUrl = parseOptionalUrl(env.OMNIHILBRAS_PXPIPE_URL, 'OMNIHILBRAS_PXPIPE_URL');

  return {
    host,
    port: parseInteger(env.OMNIHILBRAS_PORT, 8787, 'OMNIHILBRAS_PORT'),
    timeoutMs: parseInteger(env.OMNIHILBRAS_TIMEOUT_MS, 30_000, 'OMNIHILBRAS_TIMEOUT_MS'),
    healthIntervalMs: parseNonNegativeInteger(env.OMNIHILBRAS_HEALTH_INTERVAL_MS, 60_000, 'OMNIHILBRAS_HEALTH_INTERVAL_MS', 3_600_000),
    failureThreshold: parseNonNegativeInteger(env.OMNIHILBRAS_FAILURE_THRESHOLD, 3, 'OMNIHILBRAS_FAILURE_THRESHOLD', 100),
    recoveryCooldownMs: parseNonNegativeInteger(env.OMNIHILBRAS_RECOVERY_COOLDOWN_MS, 30_000, 'OMNIHILBRAS_RECOVERY_COOLDOWN_MS', 3_600_000),
    corsOrigins: parseCorsOrigins(env.OMNIHILBRAS_CORS_ORIGINS),
    dataDir: env.OMNIHILBRAS_DATA_DIR?.trim() || defaultConnectionDirectory(env),
    ...(parseOptionalLimit(env.OMNIHILBRAS_MAX_OUTPUT_TOKENS, 1, 1_000_000) !== undefined ? { maxOutputTokensCap: parseOptionalLimit(env.OMNIHILBRAS_MAX_OUTPUT_TOKENS, 1, 1_000_000) } : {}),
    ...(parseOptionalLimit(env.OMNIHILBRAS_THINKING_BUDGET, 1024, 1_000_000) !== undefined ? { thinkingBudgetCap: parseOptionalLimit(env.OMNIHILBRAS_THINKING_BUDGET, 1024, 1_000_000) } : {}),
    ...(parseOptionalLimit(env.OMNIHILBRAS_HISTORY_TRIM_TOKENS, 1_000, 10_000_000) !== undefined
      ? { historyTrim: { maxInputTokens: parseOptionalLimit(env.OMNIHILBRAS_HISTORY_TRIM_TOKENS, 1_000, 10_000_000)!, keepRecent: parseNonNegativeInteger(env.OMNIHILBRAS_HISTORY_TRIM_KEEP_RECENT, 8, 'OMNIHILBRAS_HISTORY_TRIM_KEEP_RECENT', 200) } }
      : {}),
    ...(['1', 'true', 'on', 'yes'].includes((env.OMNIHILBRAS_CACHE_ANCHOR ?? '').trim().toLowerCase()) ? { cacheAnchor: true } : {}),
    ...(caveman ? { caveman: { level: caveman } } : {}),
    ...(ponytail ? { ponytail: { level: ponytail } } : {}),
    ...(headroomUrl ? {
      headroom: {
        url: headroomUrl,
        ...(parseOptionalLimit(env.OMNIHILBRAS_HEADROOM_TIMEOUT_MS, 100, 600_000) === undefined ? {} : { timeoutMs: parseOptionalLimit(env.OMNIHILBRAS_HEADROOM_TIMEOUT_MS, 100, 600_000)! }),
        ...(['1', 'true', 'on', 'yes'].includes((env.OMNIHILBRAS_HEADROOM_USERS ?? '').trim().toLowerCase()) ? { compressUserMessages: true } : {}),
      },
    } : {}),
    ...(pxpipeUrl ? {
      pxpipe: {
        url: pxpipeUrl,
        ...(parseOptionalLimit(env.OMNIHILBRAS_PXPIPE_TIMEOUT_MS, 100, 600_000) === undefined ? {} : { timeoutMs: parseOptionalLimit(env.OMNIHILBRAS_PXPIPE_TIMEOUT_MS, 100, 600_000)! }),
        ...(parseOptionalLimit(env.OMNIHILBRAS_PXPIPE_MIN_CHARS, 1_000, 10_000_000) === undefined ? {} : { minChars: parseOptionalLimit(env.OMNIHILBRAS_PXPIPE_MIN_CHARS, 1_000, 10_000_000)! }),
      },
    } : {}),
    tokenSaver: {
      enabled: ['1', 'true', 'on', 'yes'].includes((env.OMNIHILBRAS_TOKEN_SAVER ?? '').trim().toLowerCase()),
      targetRatio: parseRatio(env.OMNIHILBRAS_TOKEN_SAVER_RATIO, 0.5),
      protectRecent: parseNonNegativeInteger(env.OMNIHILBRAS_TOKEN_SAVER_PROTECT_RECENT, 4, 'OMNIHILBRAS_TOKEN_SAVER_PROTECT_RECENT', 100),
      compressUsers: ['1', 'true', 'on', 'yes'].includes((env.OMNIHILBRAS_TOKEN_SAVER_USERS ?? '').trim().toLowerCase()),
      compressCode: ['1', 'true', 'on', 'yes'].includes((env.OMNIHILBRAS_TOKEN_SAVER_CODE ?? '').trim().toLowerCase()),
      reversible: !['0', 'false', 'off', 'no'].includes((env.OMNIHILBRAS_TOKEN_SAVER_REVERSIBLE ?? 'true').trim().toLowerCase()),
      ccrLimit: parseNonNegativeInteger(env.OMNIHILBRAS_TOKEN_SAVER_CCR_LIMIT, 500, 'OMNIHILBRAS_TOKEN_SAVER_CCR_LIMIT', 10_000),
    },
    codex: {
      clientId: env.OMNIHILBRAS_CODEX_CLIENT_ID?.trim() || undefined,
      redirectUri: env.OMNIHILBRAS_CODEX_REDIRECT_URI?.trim() || undefined,
      clientVersion: env.OMNIHILBRAS_CODEX_CLIENT_VERSION?.trim() || undefined,
    },
    openai: {
      baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      organization: env.OPENAI_ORGANIZATION,
      project: env.OPENAI_PROJECT,
    },
    anthropic: {
      baseUrl: env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
      apiVersion: env.ANTHROPIC_VERSION,
    },
    gemini: {
      baseUrl: env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
    },
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
    },
    compatible: {
      id: compatibleId,
      name: env.OMNIHILBRAS_COMPATIBLE_PROVIDER_NAME ?? 'OpenAI-compatible endpoint',
      baseUrl: env.OMNIHILBRAS_COMPATIBLE_BASE_URL ?? 'http://localhost:8000/v1',
      authHeader: env.OMNIHILBRAS_COMPATIBLE_AUTH_HEADER,
      authPrefix: env.OMNIHILBRAS_COMPATIBLE_AUTH_PREFIX,
      modelsPath: env.OMNIHILBRAS_COMPATIBLE_MODELS_PATH,
      chatPath: env.OMNIHILBRAS_COMPATIBLE_CHAT_PATH,
      authRequired: Boolean(compatibleCredential),
    },
  };
}

export function createProviderRegistry(config: GatewayConfig, transport = new FetchHttpTransport({ timeoutMs: config.timeoutMs, checkDestination: assertPublicDestination })) {
  const registry = new ProviderRegistry();
  registry.register(new OpenAIAdapter({
    baseUrl: config.openai.baseUrl,
    organization: config.openai.organization,
    project: config.openai.project,
    transport,
  }));
  registry.register(new AnthropicAdapter({
    baseUrl: config.anthropic.baseUrl,
    apiVersion: config.anthropic.apiVersion,
    transport,
  }));
  registry.register(new GeminiAdapter({ baseUrl: config.gemini.baseUrl, transport }));
  registry.register(new OpenRouterAdapter({ baseUrl: config.openrouter.baseUrl }, { transport }));
  registry.register(new OpenAICompatibleAdapter({
    id: config.compatible.id,
    name: config.compatible.name,
    baseUrl: config.compatible.baseUrl,
    auth: {
      header: config.compatible.authHeader,
      prefix: config.compatible.authPrefix,
      required: config.compatible.authRequired,
    },
    ...(config.compatible.modelsPath ? { modelsPath: config.compatible.modelsPath } : {}),
    ...(config.compatible.chatPath ? { chatPath: config.compatible.chatPath } : {}),
  }, { transport }));
  return registry;
}

/**
 * The deployment described by a loaded configuration.
 *
 * Derived from the config rather than declared beside it, so the two cannot disagree about where
 * state lives or which origins are allowed — a config that said one thing and a deployment another
 * would be exactly the "local/cloud behavior diverges" risk the plan names.
 */
export function deploymentFrom(config: GatewayConfig): DeploymentConfig {
  return localDeployment({
    // The config knows the port; the deployment has to state the URL an OAuth callback is built
    // from, and deriving it here is what keeps those two from being set separately.
    publicBaseUrl: loopbackBaseUrl(config.host, config.port),
    dataDir: config.dataDir,
    corsOrigins: config.corsOrigins,
  });
}

export function createGatewayService(config: GatewayConfig = loadGatewayConfig(), env: Readonly<Record<string, string | undefined>> = process.env, connectionStore?: ConnectionStore, apiKeyStore?: ApiKeyStore) {
  const environmentSecretStore = new EnvironmentSecretStore(env, config.compatible.id);
  const store = connectionStore ?? new LocalConnectionStore({ directory: config.dataDir, fallback: environmentSecretStore, masterKey: parseMasterKey(env.OMNIHILBRAS_MASTER_KEY) });
  const keys = apiKeyStore ?? new LocalApiKeyStore({ directory: config.dataDir });
  return new GatewayService(createProviderRegistry(config), store, store, keys, {
    tokenSaver: config.tokenSaver,
    ...(config.maxOutputTokensCap ? { maxOutputTokensCap: config.maxOutputTokensCap } : {}),
    ...(config.thinkingBudgetCap ? { thinkingBudgetCap: config.thinkingBudgetCap } : {}),
    ...(config.historyTrim ? { historyTrim: config.historyTrim } : {}),
    ...(config.cacheAnchor ? { cacheAnchor: config.cacheAnchor } : {}),
    ...(config.caveman ? { caveman: config.caveman } : {}),
    ...(config.ponytail ? { ponytail: config.ponytail } : {}),
    ...(config.headroom ? { headroom: config.headroom } : {}),
    ...(config.pxpipe ? { pxpipe: config.pxpipe } : {}),
    failureThreshold: config.failureThreshold,
    recoveryCooldownMs: config.recoveryCooldownMs,
    // **Wired here in 1.64.0, and it had never been.** `GatewayServiceOptions.usageStore` is optional by
    // design — "this gateway records nothing" is a state a caller chose, not an accident — but the only
    // caller that constructs a real gateway never passed one, so every deployed gateway answered
    // `recording: false` and the Usage page had nothing to read. An optional dependency with no production
    // caller is a feature that is off in every deployment, and no unit test noticed because every test
    // constructs the service itself.
    //
    // `LocalUsageStore` writes through `atomicWrite`, so `usage.json` lands at 0600 in the same 0700
    // directory as the credentials, and is bounded by `maxRecords` on write.
    usageStore: new LocalUsageStore({ directory: config.dataDir }),
    virtualModels: new LocalVirtualModelStore({ directory: config.dataDir }),
    skills: new LocalSkillStore({ directory: config.dataDir }),
    workspaces: new LocalWorkspaceStore({ directory: config.dataDir }),
    tunnels: new LocalTunnelStore({ directory: config.dataDir }),
    mitm: new LocalMitmStore({ directory: config.dataDir }),
    proxyPools: new LocalProxyPoolStore({ directory: config.dataDir }),
    providerNodes: new LocalProviderNodeStore({ directory: config.dataDir }),
    // Passed so `GET /v1/settings` can report what this process actually loaded. `service.ts` cannot import
    // `loadGatewayConfig` — this file already imports `service.ts`, for `deploymentFrom` — so the factory
    // hands the value over rather than the service reaching back for it.
    config,
  }, deploymentFrom(config));
}

function providerEnvKey(providerId: string) {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/**
 * An optional positive limit. Absent or empty means "not configured"; malformed input is an error rather
 * than a silent fallback, because a cap that silently disappears is worse than no cap.
 */
function parseOptionalLimit(value: string | undefined, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}, got "${value}".`);
  }
  return parsed;
}

function parseRatio(value: string | undefined, fallback: number) {  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a ratio between 0.05 and 0.95, got "${value}".`);
  return Math.min(0.95, Math.max(0.05, parsed));
}

function parseInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

/** Like `parseInteger`, but 0 is a meaningful value: it disables polling. */
function parseNonNegativeInteger(value: string | undefined, fallback: number, name: string, maximum: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error(`${name} must be an integer from 0 to ${maximum}.`);
  return parsed;
}

function parseChoice<T extends string>(value: string | undefined, choices: readonly T[], name: string): T | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase() as T;
  if (!choices.includes(normalized)) throw new Error(`${name} must be one of ${choices.join(', ')}.`);
  return normalized;
}

/** An external saver URL. A malformed URL is a configuration error, not a request-time surprise. */
function parseOptionalUrl(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be an http:// or https:// URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be an http:// or https:// URL.`);
  return value.trim().replace(/\/$/, '');
}

function parseCorsOrigins(value: string | undefined) {
  const origins = (value ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174,http://localhost:20138,http://127.0.0.1:20138,http://localhost:20139,http://127.0.0.1:20139,https://localhost,http://localhost')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.includes('*')) throw new Error('OMNIHILBRAS_CORS_ORIGINS must not contain a wildcard.');
  return [...new Set(origins)];
}

export function assertLoopbackHost(host: string) {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!isLoopbackHostname(normalized)) {
    throw new Error('OMNIHILBRAS_HOST must be a loopback address in local mode.');
  }
}
