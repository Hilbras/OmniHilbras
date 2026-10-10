import { ProviderError } from '../../core/errors.js';
import { providerErrorDetail } from '../../core/transport.js';
import { FetchHttpTransport } from '../../core/transport.js';
import { OpenAICompatibleAdapter, type OpenAIResponse } from '../openai-compatible/index.js';
import type { HttpTransport } from '../../core/transport.js';
import type { ChatChunk, ChatRequest, ChatResponse, CredentialValidation, Model, ProviderAdapter, ProviderCredential, ProviderHealth, ProviderRequestContext } from '../../core/types.js';

/**
 * Cline serves an OpenAI-compatible API behind an OAuth authorization-code
 * flow. Two details are not OpenAI-shaped and are handled here rather than in
 * the generic adapter:
 *
 * - Cline issues WorkOS JWTs, which the API only accepts with a `workos:`
 *   prefix. A key that is not a JWT must be sent verbatim or the API rejects it
 *   with 401. What that non-JWT key looks like is **not** modelled anywhere in
 *   Cline's own source — the vendor never names a prefix for it — so this
 *   function guesses nothing and only rewrites the shape it can actually see.
 * - The API requires a set of client headers on every request.
 */

export const CLINE_OAUTH = {
  appBaseUrl: 'https://app.cline.bot',
  apiBaseUrl: 'https://api.cline.bot',
  /**
   * Cline serves its whole API under `/api/v1`. The adapter's base URL has to
   * include that prefix, otherwise the generic `models` path resolves to
   * `api.cline.bot/models`, which is not an endpoint Cline serves.
   */
  apiBasePath: 'https://api.cline.bot/api/v1',
  authorizeUrl: 'https://api.cline.bot/api/v1/auth/authorize',
  tokenUrl: 'https://api.cline.bot/api/v1/auth/token',
  refreshUrl: 'https://api.cline.bot/api/v1/auth/refresh',
  modelsUrl: 'https://api.cline.bot/api/v1/models',
  /**
   * The feed Cline's own client reads for its tiers. Its `clinePass` list is the ClinePass model list the
   * CLI shows; the general catalog above does not carry the subscription tier for every account.
   */
  recommendedModelsUrl: 'https://api.cline.bot/api/v1/ai/cline/recommended-models',
  /**
   * The catalog is public: it answers 200 to an unauthenticated request, so it
   * cannot be used to check a token. This endpoint does check, and is what a
   * sign-in is proved against.
   */
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
  /**
   * The provider id and display name this adapter reports.
   *
   * Defaulted, because Cline owns the wire format and ClinePass is the same API on the same host — see
   * `clinepass.ts`, which subclasses this adapter to change only the id, the name, and the model filter.
   * The id is what a failure is attributed to, and the two ids are separate cards in the dashboard even
   * though they share one stored credential, so it has to travel rather than be hardcoded here.
   */
  id?: string;
  name?: string;
};

const defaultRefreshSkewMs = 60_000;

/** Reported to Cline as this client's version. */
const omnihilbrasVersion = '1.79.0';

/** Cline only accepts WorkOS JWTs with an explicit prefix. */
export function toClineAccessToken(token: string) {
  const trimmed = token.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith('workos:')) return trimmed;
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(trimmed) ? `workos:${trimmed}` : trimmed;
}

/**
 * The return type is written out rather than inferred, so no ambient Node type can reach the emitted
 * declaration. Every value here is a string; saying so is also the honest description.
 */
export function clineHeaders(
  token: string,
  extra: Record<string, string> = {},
  userAgent = `Cline/${omnihilbrasVersion}`,
): Record<string, string> {
  const accessToken = toClineAccessToken(token);
  return {
    // The public site, not the app host: this is the value Cline's own clients
    // send, and it is what Cline attributes a request by.
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline',
    'User-Agent': userAgent,
    // Cline's free models are served only to its own client identities: a request that identifies
    // itself as anything else is refused with "only available via Cline product surfaces".
    'X-CLIENT-TYPE': 'cline-cli',
    // Cline identifies its clients by this set. A request that omits them is
    // answered with a 4xx that reads like a bad request rather than an
    // unrecognised client, so all of them are sent.
    // **Annotated `string`, and that annotation is load-bearing.** `process.platform` infers as
    // `NodeJS.Platform`, and TypeScript writes the inferred type straight into the emitted `.d.ts`:
    //
    //     'X-PLATFORM': NodeJS.Platform;      // in dist/adapters/cline.d.ts
    //
    // `NodeJS` only exists if the consumer has `@types/node`. A browser-targeted consumer does not, so the
    // published package failed to compile for them:
    //
    //     cline.d.ts(57,19): error TS2503: Cannot find namespace 'NodeJS'.    REAL EXIT=2
    //
    // It passed every gate here because the SDK typechecks against its own `@types/node`, the repo's
    // `skipLibCheck: true` skips the declaration entirely, and the dashboard consumes the *workspace link*
    // rather than the tarball. Nothing in this repo ever compiled the published artifact from outside.
    // Verified by packing the real tarball into a consumer with no `@types/node` and compiling it.
    'X-PLATFORM': process.platform || 'unknown',
    'X-PLATFORM-VERSION': process.version || 'unknown',
    'X-CLIENT-VERSION': omnihilbrasVersion,
    'X-CORE-VERSION': omnihilbrasVersion,
    'X-IS-MULTIROOT': 'false',
    ...extra,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

/**
 * Builds the Cline sign-in URL.
 *
 * `state` is sent, and it is the strongest cross-check *if it comes back*. Cline replaces it with a
 * blob of its own — see `clineStateMatchesCallback` — so the loopback session id in the path is what
 * actually correlates the callback, and `state` narrows it when Cline hands one back.
 */
export function buildClineAuthorizeUrl(redirectUri: string, state?: string, authorizeUrl: string = CLINE_OAUTH.authorizeUrl) {
  const url = new URL(authorizeUrl);
  url.searchParams.set('client_type', CLINE_OAUTH.clientType);
  url.searchParams.set('callback_url', redirectUri);
  url.searchParams.set('redirect_uri', redirectUri);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

/** The fields Cline signs into the blob it puts on its own authorize redirect. */
type ClineStateBlob = { client_type?: string; callback_url?: string };

/**
 * Decodes the `callback_url` Cline recorded in the blob it signs at authorize time.
 *
 * Cline's blob is base64url of a flat JSON object followed by binary signature bytes,
 * so only the leading object is readable and only the `callback_url` in it is of use.
 * Returns nothing for anything that is not that shape — an unrecognised blob is not a
 * failure here, it is simply a value this cannot vouch for.
 */
export function clineStateCallbackUrl(state: string): string | undefined {
  let text: string;
  try {
    const padded = state.padEnd(state.length + ((4 - (state.length % 4)) % 4), '=');
    text = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  // The JSON is flat and holds no nested braces, so the first `}` closes it and the
  // signature bytes after it are not part of the object.
  const end = text.indexOf('}');
  if (end < 0) return undefined;
  let blob: ClineStateBlob;
  try {
    blob = JSON.parse(text.slice(0, end + 1)) as ClineStateBlob;
  } catch {
    return undefined;
  }
  return typeof blob.callback_url === 'string' ? blob.callback_url : undefined;
}

/**
 * Whether a callback's `state` can be trusted to belong to this sign-in.
 *
 * Cline replaces the caller's `state` rather than echoing it. Verified against
 * `api.cline.bot`: the blob on its authorize redirect decodes to
 * `{"client_type":"extension","callback_url":"<our loopback callback>"}` plus a
 * signature, with nothing of the value we sent. A check that demanded our exact
 * `state` therefore rejected every callback Cline actually produced, and the sign-in
 * could never complete.
 *
 * So three shapes are accepted, and they are not equally strong:
 *
 * - **our own `state`**, echoed verbatim — the full guarantee it was sent for;
 * - **Cline's blob naming this exact `callback_url`** — not our value, but it could
 *   only have been minted by Cline's authorize endpoint for *this* sign-in, so it
 *   still ties the callback to the session;
 * - **nothing at all** — a provider that echoes nothing cannot be cross-checked. The
 *   correlation rests entirely on the unguessable session id in the loopback path,
 *   which is the same guarantee the flow already relied on before `state` existed.
 *
 * Anything else is refused.
 */
export function clineStateMatchesCallback(state: string | undefined, ours: string | undefined, redirectUri: string): boolean {
  if (state === undefined) return true;
  if (ours !== undefined && state === ours) return true;
  return clineStateCallbackUrl(state) === redirectUri;
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

/**
 * Cline reports the expiry as epoch seconds, the same unit a JWT `exp` uses,
 * but not always: a value already in milliseconds must not be rescaled. Getting
 * this wrong yields a 1970 timestamp, which makes a valid token look expired
 * and sends every request down a refresh that then fails.
 */
export function clineExpiryToIso(value: string | number): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    // Any plausible millisecond timestamp is above 1e12; seconds are far below.
    const ms = value < 1e12 ? value * 1000 : value;
    const asDate = new Date(ms);
    return Number.isNaN(asDate.getTime()) ? undefined : asDate.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

const toIsoString = clineExpiryToIso;

/**
 * Cline answers a non-streaming chat request wrapped as
 * `{"success":true,"data":{ …choices… }}`, and a failure as
 * `{"success":false,…}` inside a 200 response. Reading the wrapper as an OpenAI
 * response yields a parse failure instead of the provider's own error.
 *
 * The success shape is unwrapped; the failure shape is turned into a
 * `ProviderError` carrying what Cline said, so the operator sees the reason
 * rather than "invalid response". Streaming is not wrapped and is left alone.
 */
/**
 * Unwraps Cline's non-streaming chat envelope, or raises the error it carries.
 * Returns the OpenAI-shaped body the generic adapter expects.
 *
 * `label` and `providerId` exist because the same envelope is read on behalf of more than one of our
 * provider ids — Cline and ClinePass share the host and the shape. Hardcoding `'cline'` made a
 * ClinePass failure report itself as a Cline one, which is the id the operator has to act on.
 */
export function unwrapClineEnvelope(
  body: unknown,
  options: { providerId?: string; label?: string } = {},
): OpenAIResponse {
  const label = options.label ?? 'Cline';
  const providerId = options.providerId ?? 'cline';
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body as OpenAIResponse;
  const envelope = body as { success?: unknown; data?: unknown; message?: unknown; error?: unknown };
  if (envelope.success === false) {
    const reason = [envelope.message, envelope.error]
      .map((value) => (typeof value === 'string' ? value : (value as { message?: string } | undefined)?.message))
      .find((value) => typeof value === 'string' && value.trim());
    const message = reason ? `${label} rejected the request: ${reason}` : `${label} rejected the request.`;
    throw new ProviderError('PROVIDER_REQUEST_FAILED', message, {
      providerId,
      publicMessage: message,
    });
  }
  if (envelope.success === true && envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)) {
    return envelope.data as OpenAIResponse;
  }
  return body as OpenAIResponse;
}

/** A short, safe explanation of why a Cline call failed. */
export function clineFailureReason(error: unknown, label = 'Cline'): string {
  if (error instanceof ProviderError) {
    const details = error.details as { providerMessage?: string } | undefined;
    const reason = typeof details?.providerMessage === 'string' ? details.providerMessage : undefined;
    if (error.code === 'AUTHENTICATION_FAILED') {
      return reason ? `${label} rejected the token: ${reason}` : `${label} rejected the token. Sign in again.`;
    }
    if (error.code === 'CANCELLED') return 'The health check was cancelled.';
    if (error.code === 'PROVIDER_TIMEOUT') return `${label} did not answer in time.`;
    if (error.code === 'PROVIDER_UNAVAILABLE') return `${label} could not be reached.`;
    return reason ? `${error.code}: ${reason}` : `${error.code}.`;
  }
  return `The ${label} health check failed.`;
}

export class ClineAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly capabilities = { chat: true, streaming: true, models: true } as const;

  /**
   * Whether the stored access token has expired, read from the credential rather than discovered.
   *
   * The exchange endpoint reports a dead refresh token as an opaque refusal, so without this a
   * Cline connection whose session ended is diagnosed by making a request that cannot succeed and
   * reading a message written for a token problem.
   */
  isCredentialExpired(credential: ProviderCredential | undefined, now = Date.now()): boolean | undefined {
    // `expiresAt` is declared on the OAuth branch only. An API key has no expiry to read, which is
    // "cannot say" and not "not expired" — the two look identical to the caller and only one of them
    // is honest.
    if (credential?.type !== 'oauth') return undefined;
    if (typeof credential.expiresAt !== 'string') return undefined;
    const parsed = Date.parse(credential.expiresAt);
    // An unparseable expiry is not treated as expired either. Guessing would eject a working
    // connection over a field we failed to read, and the network check would have answered for free.
    if (!Number.isFinite(parsed)) return undefined;
    return parsed <= now;
  }
  protected readonly transport: HttpTransport;
  protected readonly delegate: OpenAICompatibleAdapter;
  protected readonly onTokensRefreshed?: ClineAdapterOptions['onTokensRefreshed'];
  protected readonly refreshSkewMs: number;
  protected readonly userAgent: string;
  protected refreshInFlight?: Promise<Exclude<ProviderCredential, { type: 'none' }>>;

  constructor(options: ClineAdapterOptions = {}) {
    this.id = options.id ?? 'cline';
    this.name = options.name ?? 'Cline';
    this.transport = options.transport ?? new FetchHttpTransport();
    this.userAgent = options.userAgent ?? `Cline/${omnihilbrasVersion}`;
    this.delegate = new OpenAICompatibleAdapter(
      {
        id: this.id,
        name: this.name,
        baseUrl: CLINE_OAUTH.apiBasePath,
        auth: { header: 'Authorization', prefix: 'Bearer' },
        // Chat goes through this delegate, so the Cline client identity has to be set here too. Without it
        // the request is a stranger's, and Cline refuses its free models with "product surfaces". The
        // Authorization header is left to the delegate, which fills it from the credential.
        headers: clineHeaders('', {}, this.userAgent),
        // The envelope names whichever provider is asking, so a ClinePass refusal reports itself as
        // ClinePass. Hardcoding `cline` here would send the operator to fix the wrong card.
        unwrapResponse: (body) => unwrapClineEnvelope(body, { providerId: this.id, label: this.name }),
      },
      { transport: this.transport },
    );
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.refreshSkewMs = options.refreshSkewMs ?? defaultRefreshSkewMs;

  }

  /**
   * Confirms a token against the account endpoint, which is the one Cline
   * endpoint that actually checks it: the model catalog answers 200 to an
   * unauthenticated request, so it cannot tell a good token from a bad one.
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

  async healthCheck(context: ProviderRequestContext = {}): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      const result = await this.validateCredential(context.credential ?? { type: 'api-key', value: '' }, context);
      return { status: 'healthy', verified: 'credential', checkedAt: result.checkedAt, latencyMs: result.latencyMs ?? Date.now() - startedAt };
    } catch (error) {
      // The reason is carried through. Without it an expired token and an
      // unreachable endpoint are indistinguishable, and the only symptom is a
      // bare "unavailable" that gives the operator nothing to act on.
      return {
        status: 'unavailable', verified: 'credential',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        message: clineFailureReason(error, this.name),
      };
    }
  }

  protected context(credential: ProviderCredential): ProviderRequestContext {
    return { credential: { type: 'api-key', value: toClineAccessToken(credential.type === 'none' ? '' : credential.value) } };
  }

  protected needsRefresh(credential: ProviderCredential): credential is Extract<ProviderCredential, { type: 'oauth' }> {
    if (credential.type !== 'oauth' || !credential.refreshToken || !credential.expiresAt) return false;
    // Normalised rather than handed to `new Date` directly: an epoch-seconds
    // value read as milliseconds lands in 1970, and a perfectly valid token
    // would then be refreshed on every single request.
    const expiresAt = new Date(clineExpiryToIso(credential.expiresAt) ?? Number.NaN).getTime();
    return Number.isFinite(expiresAt) && expiresAt - this.refreshSkewMs <= Date.now();
  }

  protected async currentCredential(credential: ProviderCredential | undefined, signal?: AbortSignal): Promise<Exclude<ProviderCredential, { type: 'none' }>> {
    if (credential?.type === 'none' || !credential?.value) {
      throw new ProviderError('AUTHENTICATION_FAILED', 'A Cline access token is required.', { providerId: this.id, publicMessage: 'A Cline access token is required.' });
    }
    if (!this.needsRefresh(credential)) return credential;
    // One refresh at a time: concurrent requests share the same renewal.
    this.refreshInFlight ??= this.refresh(credential, signal).finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }

  protected async refresh(credential: Extract<ProviderCredential, { type: 'oauth' }>, signal?: AbortSignal) {
    try {
      const response = await this.transport.request<{ success?: boolean; data?: ClineTokenPayload }>({
        method: 'POST',
        providerId: this.id,
        url: CLINE_OAUTH.refreshUrl,
        headers: clineHeaders(credential.value, { 'content-type': 'application/json', accept: 'application/json' }, this.userAgent),
        // Cline's refresh is camelCase, unlike its authorization-code exchange. Snake_case is refused with
        // `400 Validation failed` naming `refreshtoken` and `granttype` as missing.
        body: JSON.stringify({ refreshToken: credential.refreshToken, grantType: 'refresh_token' }),
        ...(signal ? { signal } : {}),
      });
      // The renewed tokens come back inside a `data` envelope, next to `success`. Reading the top level
      // found nothing, so every renewal failed as "did not return a renewed access token".
      const payload: ClineTokenPayload | undefined = response.data?.data ?? undefined;
      const accessToken = payload?.accessToken;
      if (!accessToken) throw new ProviderError('AUTHENTICATION_FAILED', 'Cline did not return a renewed access token.', { providerId: this.id });
      const expires = payload?.expiresAt;
      const renewed: ClineTokens = {
        accessToken,
        ...(typeof payload?.refreshToken === 'string' ? { refreshToken: payload.refreshToken } : { refreshToken: credential.refreshToken }),
        ...(expires === undefined ? {} : { expiresAt: toIsoString(expires) }),
        ...(credential.email ? { email: credential.email } : {}),
      };
      await this.onTokensRefreshed?.(renewed);
      return { type: 'oauth', value: renewed.accessToken, ...renewed } satisfies ProviderCredential;
    } catch (error) {
      // A failed renewal means the session is over, whatever shape the refusal
      // arrived in. Letting the raw 4xx through reported "PROVIDER_REQUEST_FAILED"
      // for what is really an expired login, which gives the operator nothing to
      // act on. Cline's own wording is kept when there is one.
      if (error instanceof ProviderError && error.code === 'CANCELLED') throw error;
      if (error instanceof ProviderError && (error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'PROVIDER_TIMEOUT')) throw error;
      const detail = providerErrorDetail((error as ProviderError | undefined)?.details);
      throw new ProviderError('AUTHENTICATION_FAILED', 'The Cline access token could not be renewed. Sign in again.', {
        providerId: this.id,
        publicMessage: `The Cline session expired and could not be renewed. Sign in again.${detail ? ` Cline said: ${detail}` : ''}`,
        ...(detail ? { details: { providerMessage: detail } } : {}),
        cause: error,
      });
    }
  }
}
