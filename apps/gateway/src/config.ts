import {
  AnthropicAdapter,
  FetchHttpTransport,
  GeminiAdapter,
  OpenAIAdapter,
  OpenAICompatibleAdapter,
  OpenRouterAdapter,
  ProviderRegistry,
  canonicalLoopbackHost,
  isLoopbackHostname,
  type ProviderCredential,
  type SecretStore,
} from '@hilbras/omnihilbras';
import { LocalApiKeyStore, type ApiKeyStore } from './api-keys.js';
import { defaultConnectionDirectory, LocalConnectionStore, parseMasterKey, type ConnectionStore } from './connections.js';
import { GatewayService } from './service.js';

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

  return {
    host,
    port: parseInteger(env.OMNIHILBRAS_PORT, 8787, 'OMNIHILBRAS_PORT'),
    timeoutMs: parseInteger(env.OMNIHILBRAS_TIMEOUT_MS, 30_000, 'OMNIHILBRAS_TIMEOUT_MS'),
    healthIntervalMs: parseNonNegativeInteger(env.OMNIHILBRAS_HEALTH_INTERVAL_MS, 60_000, 'OMNIHILBRAS_HEALTH_INTERVAL_MS', 3_600_000),
    failureThreshold: parseNonNegativeInteger(env.OMNIHILBRAS_FAILURE_THRESHOLD, 3, 'OMNIHILBRAS_FAILURE_THRESHOLD', 100),
    recoveryCooldownMs: parseNonNegativeInteger(env.OMNIHILBRAS_RECOVERY_COOLDOWN_MS, 30_000, 'OMNIHILBRAS_RECOVERY_COOLDOWN_MS', 3_600_000),
    corsOrigins: parseCorsOrigins(env.OMNIHILBRAS_CORS_ORIGINS),
    dataDir: env.OMNIHILBRAS_DATA_DIR?.trim() || defaultConnectionDirectory(env),
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

export function createProviderRegistry(config: GatewayConfig, transport = new FetchHttpTransport({ timeoutMs: config.timeoutMs })) {
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

export function createGatewayService(config: GatewayConfig = loadGatewayConfig(), env: Readonly<Record<string, string | undefined>> = process.env, connectionStore?: ConnectionStore, apiKeyStore?: ApiKeyStore) {
  const environmentSecretStore = new EnvironmentSecretStore(env, config.compatible.id);
  const store = connectionStore ?? new LocalConnectionStore({ directory: config.dataDir, fallback: environmentSecretStore, masterKey: parseMasterKey(env.OMNIHILBRAS_MASTER_KEY) });
  const keys = apiKeyStore ?? new LocalApiKeyStore({ directory: config.dataDir });
  return new GatewayService(createProviderRegistry(config), store, store, keys, {
    failureThreshold: config.failureThreshold,
    recoveryCooldownMs: config.recoveryCooldownMs,
  });
}

function providerEnvKey(providerId: string) {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
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

function parseCorsOrigins(value: string | undefined) {
  const origins = (value ?? 'http://localhost:5173,http://127.0.0.1:5173')
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
