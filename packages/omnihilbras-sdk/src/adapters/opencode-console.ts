import { ProviderError } from '../errors.js';
import { FetchHttpTransport } from '../transport.js';
import type { HttpTransport } from '../transport.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import type { ChatChunk, ChatRequest, ChatResponse, CredentialValidation, Model, ProviderAdapter, ProviderCredential, ProviderRequestContext } from '../types.js';

/**
 * OpenCode Console is the credential that reaches OpenCode's free Zen models. An API
 * key is refused by every lane with `OpenCode's free tier can only be used from within
 * OpenCode`, so this provider signs in through the same device flow the OpenCode client
 * runs for itself.
 *
 * A signed-in session also changes the endpoints. `GET /api/config` returns the live
 * provider config, and its base URL is not the public `/zen/v1` one: the catalog is
 * served from `/inference/openai/v1`, `/inference/anthropic/v1` and
 * `/inference/google/v1beta`, with a different subset of models on each. Which lane a
 * model uses is therefore a property of the model, read from the server rather than
 * hardcoded here.
 */
export const OPENCODE_CONSOLE = {
  server: 'https://console.opencode.ai',
  clientId: 'opencode-cli',
  deviceCodePath: '/auth/device/code',
  deviceTokenPath: '/auth/device/token',
  userPath: '/api/user',
  orgsPath: '/api/orgs',
  configPath: '/api/config',
  grantType: 'urn:ietf:params:oauth:grant-type:device_code',
} as const;

export const opencodeConsoleProviderId = 'opencode-console';

type ConsoleConfig = {
  config?: {
    provider?: {
      opencode?: {
        api?: string;
        options?: { headers?: Record<string, string> };
        models?: Record<string, { provider?: { api?: string } }>;
      };
    };
  };
};

/** The lane layout, as the server describes it. */
type ConsoleLanes = {
  /** Default base for models the server does not override. */
  base: string;
  /** Per-model overrides, keyed by model id. */
  byModel: Map<string, string>;
  orgId?: string;
};

const configTtlMs = 10 * 60_000;

/** True when the lane speaks the Anthropic Messages shape. */
function isAnthropicLane(lane: string) {
  return lane.includes('/inference/anthropic/');
}

/** True when the lane speaks the Google GenAI shape. */
function isGoogleLane(lane: string) {
  return lane.includes('/inference/google/');
}

function orgHeaderValue(credential: ProviderCredential | undefined): string | undefined {
  return credential?.type === 'oauth' ? credential.orgId : undefined;
}

function bearer(credential: ProviderCredential | undefined): string {
  if (!credential || credential.type === 'none') return '';
  return credential.value ?? '';
}

/**
 * Exchanges a refresh token for a new access token.
 *
 * The Console refresh grant takes the same path as the device grant, distinguished only
 * by `grant_type`, and answers 200 with the token pair.
 */
export async function refreshOpencodeConsoleCredential(
  credential: ProviderCredential,
  transport: HttpTransport = new FetchHttpTransport(),
): Promise<ProviderCredential> {
  if (credential.type !== 'oauth' || !credential.refreshToken) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'This OpenCode Console session cannot be renewed. Sign in again.', {
      providerId: opencodeConsoleProviderId,
      publicMessage: 'This OpenCode Console session cannot be renewed. Sign in again.',
    });
  }
  const response = await transport.request<Record<string, unknown>>({
    method: 'POST',
    providerId: opencodeConsoleProviderId,
    url: `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.deviceTokenPath}`,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: OPENCODE_CONSOLE.clientId,
    }),
  });
  const access = response.data?.access_token;
  if (typeof access !== 'string' || !access) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'OpenCode Console did not return a renewed session. Sign in again.', {
      providerId: opencodeConsoleProviderId,
      publicMessage: 'OpenCode Console did not return a renewed session. Sign in again.',
    });
  }
  const expiresIn = typeof response.data?.expires_in === 'number' ? response.data.expires_in : undefined;
  const rotated = typeof response.data?.refresh_token === 'string' ? response.data.refresh_token : undefined;
  return {
    type: 'oauth',
    value: access,
    ...(rotated ? { refreshToken: rotated } : credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
    ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }),
    ...(credential.email ? { email: credential.email } : {}),
    ...(credential.orgId ? { orgId: credential.orgId } : {}),
    ...(credential.orgName ? { orgName: credential.orgName } : {}),
    ...(credential.accountId ? { accountId: credential.accountId } : {}),
  };
}

/** True when the access token is at or past expiry, with a minute of slack. */
export function opencodeConsoleCredentialExpired(credential: ProviderCredential | undefined, now = Date.now()): boolean {
  if (credential?.type !== 'oauth' || !credential.expiresAt) return false;
  const expiry = Date.parse(credential.expiresAt);
  return Number.isFinite(expiry) && expiry - 60_000 <= now;
}

export type OpencodeConsoleAdapterOptions = {
  transport?: HttpTransport;
  /** Called with a renewed credential so the caller can persist it. */
  onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  now?: () => number;
};

export class OpencodeConsoleAdapter implements ProviderAdapter {
  readonly id = opencodeConsoleProviderId;
  readonly name = 'OpenCode Console';
  readonly capabilities = { chat: true, streaming: true, models: true } as const;

  private readonly transport: HttpTransport;
  private readonly onTokensRefreshed?: (credential: ProviderCredential) => void | Promise<void>;
  private readonly now: () => number;
  /** Lanes keyed by the access token they were read with, so a renewal invalidates them. */
  private lanes = new Map<string, { at: number; lanes: ConsoleLanes }>();
  /** Renewed credentials, keyed by the token they replaced. */
  private renewed = new Map<string, ProviderCredential>();

  constructor(options: OpencodeConsoleAdapterOptions = {}) {
    this.transport = options.transport ?? new FetchHttpTransport();
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.now = options.now ?? (() => Date.now());
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    const credential = await this.credential(context);
    const lanes = await this.resolveLanes(credential, context.signal);
    return [...lanes.byModel.keys()]
      .filter((id) => id.length > 0)
      .map((id) => ({ id, providerId: this.id, displayName: id }));
  }

  /**
   * Reads `/api/user`, which is free and never bills, so a health check costs nothing
   * and still proves the session is live.
   */
  async validateCredential(credential: ProviderCredential | undefined): Promise<CredentialValidation> {
    if (credential?.type === 'none' || !bearer(credential)) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'Sign in to OpenCode Console to use this provider.', {
        providerId: this.id,
        publicMessage: 'Sign in to OpenCode Console to use this provider.',
      });
    }
    const response = await this.transport.request<{ id?: string; email?: string }>({
      method: 'GET',
      providerId: this.id,
      url: `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.userPath}`,
      headers: this.headers(credential),
    });
    return { status: 'valid', checkedAt: new Date().toISOString(), ...(response.data?.email ? { account: response.data.email } : {}) };
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    const { lane, orgId } = await this.laneFor(request.model, context);
    const adapter = this.laneAdapter(lane, orgId);
    if (!adapter.chat) throw this.laneUnsupported(lane);
    return adapter.chat(request, { ...context, credential: this.laneCredential(await this.credential(context)) });
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    const { lane, orgId } = await this.laneFor(request.model, context);
    const adapter = this.laneAdapter(lane, orgId);
    if (!adapter.streamChat) throw this.laneUnsupported(lane);
    yield* adapter.streamChat(request, { ...context, credential: this.laneCredential(await this.credential(context)) });
  }

  /**
   * The lane adapters accept a bare token and reject anything else, so an OAuth access
   * token is handed across in the shape they take. Their credential contract is left
   * alone rather than widened for one caller.
   */
  private laneCredential(credential: ProviderCredential): ProviderCredential {
    if (!credential || credential.type === 'none') return { type: 'none' };
    return { type: 'api-key', value: credential.value };
  }

  private laneUnsupported(lane: string) {
    return new ProviderError('NOT_SUPPORTED', `No adapter speaks the OpenCode Console lane ${lane}.`, {
      providerId: this.id,
      publicMessage: 'That OpenCode Console model is served from a lane this gateway does not implement yet.',
    });
  }

  async healthCheck(context: ProviderRequestContext = {}): Promise<{ status: 'healthy' | 'degraded' | 'unavailable'; checkedAt: string; message?: string }> {
    try {
      await this.validateCredential(context.credential);
      return { status: 'healthy', checkedAt: new Date().toISOString() };
    } catch (error) {
      return {
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'The OpenCode Console session could not be checked.',
      };
    }
  }

  /**
   * Renews the session when it is at or past expiry, then persists the result. A
   * failure here is a sign-in problem, not a provider problem, so it is raised as one.
   *
   * A request resolves the credential more than once — once to read the lanes and once
   * to send — so a renewal is memoised against the token it replaced. Without that, one
   * request would burn two refresh grants and the second would invalidate the first.
   */
  private async credential(context: ProviderRequestContext): Promise<ProviderCredential> {
    const current = context.credential;
    if (!opencodeConsoleCredentialExpired(current, this.now())) return current as ProviderCredential;
    const replaced = bearer(current);
    const memo = this.renewed.get(replaced);
    if (memo) return memo;
    const renewed = await refreshOpencodeConsoleCredential(current as ProviderCredential, this.transport);
    this.renewed.set(replaced, renewed);
    await this.onTokensRefreshed?.(renewed);
    return renewed;
  }

  private headers(credential: ProviderCredential | undefined): Record<string, string> {
    const org = orgHeaderValue(credential);
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      Authorization: `Bearer ${bearer(credential)}`,
      ...(org ? { 'x-opencode-org-id': org } : {}),
    };
  }

  private async resolveLanes(credential: ProviderCredential, signal?: AbortSignal): Promise<ConsoleLanes> {
    const key = bearer(credential);
    const cached = this.lanes.get(key);
    if (cached && this.now() - cached.at < configTtlMs) return cached.lanes;
    const response = await this.transport.request<ConsoleConfig>({
      method: 'GET',
      providerId: this.id,
      url: `${OPENCODE_CONSOLE.server}${OPENCODE_CONSOLE.configPath}`,
      headers: this.headers(credential),
      ...(signal ? { signal } : {}),
    });
    const provider = response.data?.config?.provider?.opencode;
    const base = typeof provider?.api === 'string' ? provider.api : '';
    const byModel = new Map<string, string>();
    for (const [id, model] of Object.entries(provider?.models ?? {})) {
      const lane = model?.provider?.api;
      if (typeof lane === 'string' && lane) byModel.set(id, lane);
      else if (base) byModel.set(id, base);
    }
    const orgId = provider?.options?.headers?.['x-opencode-org-id'] ?? orgHeaderValue(credential);
    const lanes: ConsoleLanes = { base, byModel, ...(orgId ? { orgId } : {}) };
    this.lanes.set(key, { at: this.now(), lanes });
    return lanes;
  }

  private async laneFor(model: string, context: ProviderRequestContext): Promise<{ lane: string; orgId?: string }> {
    const id = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
    const lanes = await this.resolveLanes(await this.credential(context), context.signal);
    const lane = lanes.byModel.get(id) ?? lanes.base;
    if (!lane) {
      throw new ProviderError('NOT_SUPPORTED', `OpenCode Console did not list a lane for ${model}.`, {
        providerId: this.id,
        publicMessage: `OpenCode Console did not list a lane for ${model}.`,
      });
    }
    if (isGoogleLane(lane)) {
      throw new ProviderError('NOT_SUPPORTED', `OpenCode Console serves ${model} from a Google GenAI lane, which this gateway does not implement.`, {
        providerId: this.id,
        publicMessage: `${model} is served from a Google GenAI lane, which this gateway does not implement yet.`,
      });
    }
    return { lane, ...(lanes.orgId ? { orgId: lanes.orgId } : {}) };
  }

  /**
   * Builds the adapter for a lane. The org header rides on the config rather than the
   * request, because that is the only place either adapter accepts extra headers.
   */
  private laneAdapter(lane: string, orgId: string | undefined): ProviderAdapter {
    const headers = orgId ? { 'x-opencode-org-id': orgId } : undefined;
    if (isAnthropicLane(lane)) {
      return new AnthropicAdapter({
        baseUrl: lane,
        ...(headers ? { headers } : {}),
        transport: this.transport,
      });
    }
    return new OpenAICompatibleAdapter(
      {
        id: this.id,
        name: this.name,
        // The OpenAI-compatible adapter appends the chat path to the base.
        baseUrl: lane.replace(/\/chat\/completions$/, ''),
        auth: { header: 'Authorization', prefix: 'Bearer' },
        ...(headers ? { headers } : {}),
      },
      { transport: this.transport },
    );
  }
}
