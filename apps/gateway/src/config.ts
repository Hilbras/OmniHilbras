import {
  AnthropicAdapter,
  FetchHttpTransport,
  GeminiAdapter,
  OpenAIAdapter,
  OpenAICompatibleAdapter,
  ProviderRegistry,
  type ProviderCredential,
  type SecretStore,
} from '@omnihilbras/sdk';

export type GatewayConfig = {
  host: string;
  port: number;
  timeoutMs: number;
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
  compatible: {
    id: string;
    name: string;
    baseUrl: string;
    authHeader?: string;
    authPrefix?: string;
    authRequired: boolean;
  };
};

export class EnvironmentSecretStore implements SecretStore {
  constructor(private readonly env: Readonly<Record<string, string | undefined>>) {}

  async get(providerId: string) {
    const value = this.env[providerEnvKey(providerId)]
      ?? this.env[`${providerId.toUpperCase()}_API_KEY`]
      ?? (providerId === 'openai-compatible' ? this.env.OMNIHILBRAS_COMPATIBLE_API_KEY : undefined);
    return value ? { type: 'api-key' as const, value } satisfies ProviderCredential : undefined;
  }
}

export function loadGatewayConfig(env: Readonly<Record<string, string | undefined>> = process.env): GatewayConfig {
  return {
    host: env.OMNIHILBRAS_HOST ?? '127.0.0.1',
    port: parseInteger(env.OMNIHILBRAS_PORT, 8787, 'OMNIHILBRAS_PORT'),
    timeoutMs: parseInteger(env.OMNIHILBRAS_TIMEOUT_MS, 30_000, 'OMNIHILBRAS_TIMEOUT_MS'),
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
    compatible: {
      id: env.OMNIHILBRAS_COMPATIBLE_PROVIDER_ID ?? 'openai-compatible',
      name: env.OMNIHILBRAS_COMPATIBLE_PROVIDER_NAME ?? 'OpenAI-compatible endpoint',
      baseUrl: env.OMNIHILBRAS_COMPATIBLE_BASE_URL ?? 'http://localhost:8000/v1',
      authHeader: env.OMNIHILBRAS_COMPATIBLE_AUTH_HEADER,
      authPrefix: env.OMNIHILBRAS_COMPATIBLE_AUTH_PREFIX,
      authRequired: Boolean(env.OMNIHILBRAS_COMPATIBLE_API_KEY),
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
  registry.register(new OpenAICompatibleAdapter({
    id: config.compatible.id,
    name: config.compatible.name,
    baseUrl: config.compatible.baseUrl,
    auth: {
      header: config.compatible.authHeader,
      prefix: config.compatible.authPrefix,
      required: config.compatible.authRequired,
    },
  }, { transport }));
  return registry;
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
