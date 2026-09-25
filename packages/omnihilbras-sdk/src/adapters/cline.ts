import { ProviderError } from '../errors.js';
import { FetchHttpTransport } from '../transport.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import type { HttpTransport } from '../transport.js';
import type { ChatChunk, ChatRequest, ChatResponse, CredentialValidation, Model, ProviderAdapter, ProviderCredential, ProviderRequestContext } from '../types.js';

/**
 * Cline serves an OpenAI-compatible API behind an OAuth authorization-code
 * flow. Two details are not OpenAI-shaped and are handled here rather than in
 * the generic adapter:
 *
 * - Cline issues WorkOS JWTs, which the API only accepts with a `workos:`
 *   prefix. Tokens that are not JWTs (ClinePass `clp_…` keys) must be sent
 *   verbatim or the API rejects them with 401.
 * - The API requires a set of client headers on every request.
 */

export const CLINE_OAUTH = {
  appBaseUrl: 'https://app.cline.bot',
  apiBaseUrl: 'https://api.cline.bot',
  authorizeUrl: 'https://api.cline.bot/api/v1/auth/authorize',
  tokenUrl: 'https://api.cline.bot/api/v1/auth/token',
  refreshUrl: 'https://api.cline.bot/api/v1/auth/refresh',
  accountUrl: 'https://api.cline.bot/api/v1/users/me',
  clientType: 'extension',
} as const;

export type ClineTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  email?: string;
};

export type ClineAdapterOptions = {
  transport?: HttpTransport;
  /** Persists renewed tokens so a refresh is not repeated on every request. */
  onTokensRefreshed?: (tokens: ClineTokens) => void | Promise<void>;
  /** Renew when the access token is within this window of expiry. */
  refreshSkewMs?: number;
  userAgent?: string;
};

const defaultRefreshSkewMs = 60_000;

/** Cline only accepts WorkOS JWTs with an explicit prefix. */
export function toClineAccessToken(token: string) {
  const trimmed = token.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('workos:')) return trimmed;
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(trimmed) ? `workos:${trimmed}` : trimmed;
}

export function clineHeaders(token: string, extra: Record<string, string> = {}, userAgent = 'omnihilbras') {
  const accessToken = toClineAccessToken(token);
  return {
    'HTTP-Referer': CLINE_OAUTH.appBaseUrl,
    'X-Title': 'Cline',
    'User-Agent': userAgent,
    'X-CLIENT-TYPE': 'OmniHilbras',
    ...extra,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

export function buildClineAuthorizeUrl(redirectUri: string, authorizeUrl: string = CLINE_OAUTH.authorizeUrl) {
  const url = new URL(authorizeUrl);
  url.searchParams.set('client_type', CLINE_OAUTH.clientType);
  url.searchParams.set('callback_url', redirectUri);
  url.searchParams.set('redirect_uri', redirectUri);
  return url.toString();
}

type ClineTokenPayload = {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  expiresAt?: string | number;
  expires_at?: string | number;
  email?: string;
  data?: { accessToken?: string; refreshToken?: string; expiresAt?: string; userInfo?: { email?: string } };
};

/**
 * Cline sometimes returns the tokens base64-encoded inside the `code` instead
 * of a bare authorization code, so both shapes are accepted.
 */
export function decodeClineCode(code: string): ClineTokens | undefined {
  const trimmed = code.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed];
  try {
    const padded = trimmed.padEnd(trimmed.length + ((4 - (trimmed.length % 4)) % 4), '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    const end = decoded.lastIndexOf('}');
    if (end !== -1) candidates.push(decoded.slice(0, end + 1));
  } catch {
    // Not base64; the caller falls back to a token-endpoint exchange.
  }
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const payload = parsed as ClineTokenPayload;
    const accessToken = payload.accessToken ?? payload.access_token ?? payload.data?.accessToken;
    if (!accessToken || typeof accessToken !== 'string') continue;
    const expires = payload.expiresAt ?? payload.expires_at ?? payload.data?.expiresAt;
    return {
      accessToken,
      ...(typeof (payload.refreshToken ?? payload.refresh_token ?? payload.data?.refreshToken) === 'string'
        ? { refreshToken: (payload.refreshToken ?? payload.refresh_token ?? payload.data?.refreshToken) as string }
        : {}),
      ...(expires === undefined ? {} : { expiresAt: toIsoString(expires) }),
      ...(typeof (payload.email ?? payload.data?.userInfo?.email) === 'string' ? { email: (payload.email ?? payload.data?.userInfo?.email) as string } : {}),
    };
  }
  return undefined;
}

function toIsoString(value: string | number) {
  if (typeof value === 'number') return new Date(value).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export class ClineAdapter implements ProviderAdapter {
  readonly id = 'cline';
  readonly name = 'Cline';
  readonly capabilities = { chat: true, streaming: true, models: true } as const;
  private readonly transport: HttpTransport;
  private readonly delegate: OpenAICompatibleAdapter;
  private readonly onTokensRefreshed?: ClineAdapterOptions['onTokensRefreshed'];
  private readonly refreshSkewMs: number;
  private readonly userAgent: string;
  private refreshInFlight?: Promise<Exclude<ProviderCredential, { type: 'none' }>>;

  constructor(options: ClineAdapterOptions = {}) {
    this.transport = options.transport ?? new FetchHttpTransport();
    this.delegate = new OpenAICompatibleAdapter(
      { id: 'cline', name: 'Cline', baseUrl: CLINE_OAUTH.apiBaseUrl, auth: { header: 'Authorization', prefix: 'Bearer' } },
      { transport: this.transport },
    );
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.refreshSkewMs = options.refreshSkewMs ?? defaultRefreshSkewMs;
    this.userAgent = options.userAgent ?? 'omnihilbras';
  }

  /**
   * Confirms a token against the Cline account endpoint. This is a real
   * request, so a bad token costs nothing but a 401 and a good one proves the
   * connection works.
   */
  async validateCredential(credential: ProviderCredential | undefined, context: ProviderRequestContext = {}): Promise<CredentialValidation> {
    const resolved = await this.currentCredential(credential, context.signal);
    const startedAt = Date.now();
    await this.transport.request<unknown>({
      method: 'GET',
      providerId: this.id,
      url: CLINE_OAUTH.accountUrl,
      headers: clineHeaders(resolved.value, { accept: 'application/json' }, this.userAgent),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    return { status: 'valid', checkedAt: new Date().toISOString(), latencyMs: Date.now() - startedAt };
  }

  async listModels(context: ProviderRequestContext = {}): Promise<Model[]> {
    return this.delegate.listModels(this.context(await this.currentCredential(context.credential, context.signal)));
  }

  async chat(request: ChatRequest, context: ProviderRequestContext = {}): Promise<ChatResponse> {
    return this.delegate.chat(request, this.context(await this.currentCredential(context.credential, context.signal)));
  }

  async *streamChat(request: ChatRequest, context: ProviderRequestContext = {}): AsyncIterable<ChatChunk> {
    yield* this.delegate.streamChat(request, this.context(await this.currentCredential(context.credential, context.signal)));
  }

  async healthCheck(context: ProviderRequestContext = {}): Promise<{ status: 'healthy' | 'degraded' | 'unavailable'; latencyMs?: number; checkedAt: string; message?: string }> {
    try {
      await this.validateCredential(context.credential ?? { type: 'api-key', value: '' }, context);
      return { status: 'healthy', checkedAt: new Date().toISOString() };
    } catch {
      return { status: 'unavailable', checkedAt: new Date().toISOString() };
    }
  }

  private context(credential: ProviderCredential): ProviderRequestContext {
    return { credential: { type: 'api-key', value: toClineAccessToken(credential.type === 'none' ? '' : credential.value) } };
  }

  private needsRefresh(credential: ProviderCredential): credential is Extract<ProviderCredential, { type: 'oauth' }> {
    if (credential.type !== 'oauth' || !credential.refreshToken || !credential.expiresAt) return false;
    const expiresAt = new Date(credential.expiresAt).getTime();
    return Number.isFinite(expiresAt) && expiresAt - this.refreshSkewMs <= Date.now();
  }

  private async currentCredential(credential: ProviderCredential | undefined, signal?: AbortSignal): Promise<Exclude<ProviderCredential, { type: 'none' }>> {
    if (credential?.type === 'none' || !credential?.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'A Cline access token is required.', { providerId: this.id, publicMessage: 'A Cline access token is required.' });
    }
    if (!this.needsRefresh(credential)) return credential;
    // One refresh at a time: concurrent requests share the same renewal.
    this.refreshInFlight ??= this.refresh(credential, signal).finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }

  private async refresh(credential: Extract<ProviderCredential, { type: 'oauth' }>, signal?: AbortSignal) {
    try {
      const response = await this.transport.request<ClineTokenPayload>({
        method: 'POST',
        providerId: this.id,
        url: CLINE_OAUTH.refreshUrl,
        headers: clineHeaders(credential.value, { 'content-type': 'application/json', accept: 'application/json' }, this.userAgent),
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: credential.refreshToken, client_type: CLINE_OAUTH.clientType }),
        ...(signal ? { signal } : {}),
      });
      const payload = response.data;
      const accessToken = payload?.accessToken ?? payload?.access_token ?? payload?.data?.accessToken;
      if (!accessToken) throw new ProviderError('AUTHENTICATION_FAILED', 'Cline did not return a renewed access token.', { providerId: this.id });
      const expires = payload?.expiresAt ?? payload?.expires_at ?? payload?.data?.expiresAt;
      const renewed: ClineTokens = {
        accessToken,
        ...(typeof (payload?.refreshToken ?? payload?.refresh_token) === 'string' ? { refreshToken: (payload?.refreshToken ?? payload?.refresh_token) as string } : { refreshToken: credential.refreshToken }),
        ...(expires === undefined ? {} : { expiresAt: toIsoString(expires) }),
        ...(credential.email ? { email: credential.email } : {}),
      };
      await this.onTokensRefreshed?.(renewed);
      return { type: 'oauth', value: renewed.accessToken, ...renewed } satisfies ProviderCredential;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('AUTHENTICATION_FAILED', 'The Cline access token could not be renewed. Sign in again.', { providerId: this.id, cause: error });
    }
  }
}
