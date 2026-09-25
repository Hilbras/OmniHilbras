import {
  CLINE_OAUTH,
  ClineAdapter,
  ProviderError,
  buildClineAuthorizeUrl,
  clineHeaders,
  decodeClineCode,
  type ClineTokens,
  type HttpTransport,
  type ProviderCredential,
} from '@hilbras/omnihilbras';

/**
 * Cline signs in through a browser redirect to a loopback address this gateway
 * owns, so the whole flow can complete on its own: the user approves in the
 * browser, the callback lands here, and the dashboard only has to notice the
 * result. The redirect is required to be loopback, so a callback can never be
 * pointed somewhere else.
 */
export const clineCallbackPath = '/v1/oauth/cline/callback';

/** How long a started sign-in stays usable before it is discarded. */
export const clineSessionTtlMs = 5 * 60_000;

export type ClineAuthorizeResult = {
  authUrl: string;
  redirectUri: string;
};

export type ClineSessionStatus = {
  status: 'pending' | 'connected' | 'failed' | 'expired';
  /** Present once the sign-in succeeded. Contains no secrets. */
  connection?: { id: string; providerId: string; name: string; modelIds: string[] };
  /** Present once the sign-in failed. */
  error?: string;
};

type ClineSession = {
  id: string;
  /** Single-use CSRF value echoed back by the provider. Cleared once consumed. */
  state?: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
  result: ClineSessionStatus;
};

function randomToken(bytes: number) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

/**
 * Tracks in-flight sign-ins. A session is addressed by an unguessable id and
 * carries a single-use `state`, so a callback that did not come from a sign-in
 * this gateway started is rejected instead of exchanging an attacker's code into
 * the user's vault.
 */
export class ClineSessionStore {
  private readonly sessions = new Map<string, ClineSession>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  start(redirectUri: string) {
    this.prune();
    const id = randomToken(32);
    const session: ClineSession = {
      id,
      state: randomToken(32),
      redirectUri,
      createdAt: this.now(),
      expiresAt: this.now() + clineSessionTtlMs,
      result: { status: 'pending' },
    };
    this.sessions.set(id, session);
    return { sessionId: id, state: session.state as string };
  }

  /** Reads a session without letting it be used twice. */
  get(sessionId: string): ClineSessionStatus | undefined {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (this.now() >= session.expiresAt) return { status: 'expired' };
    return session.result;
  }

  /**
   * Claims the `state` a callback carries. Returns nothing when the value is
   * unknown, already used, or expired, so a replayed callback cannot re-run the
   * exchange.
   */
  claim(state: string): ClineSession | undefined {
    this.prune();
    for (const session of this.sessions.values()) {
      if (session.state !== state) continue;
      // Single use: the state is spent whether or not the exchange succeeds.
      delete session.state;
      return session;
    }
    return undefined;
  }

  resolve(sessionId: string, result: ClineSessionStatus) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.result = result;
    // A finished sign-in is kept only long enough for the dashboard to read it.
    session.expiresAt = Math.min(session.expiresAt, this.now() + 60_000);
  }

  private prune() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (now >= session.expiresAt) this.sessions.delete(id);
    }
  }
}

export type ClineExchangeInput = {
  code: string;
  /** The pasted callback URL or `code#state` pair, when the user has one. */
  callback?: string;
  redirectUri: string;
};

function assertLoopbackCallback(redirectUri: string) {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new ProviderError('INVALID_REQUEST', 'The OAuth redirect must be a URL.', { publicMessage: 'The OAuth redirect must be a URL.' });
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' || (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1')) {
    throw new ProviderError('INVALID_REQUEST', 'The OAuth redirect must be a loopback address.', { publicMessage: 'The OAuth redirect must be a loopback address.' });
  }
  return url;
}

/**
 * Accepts the three shapes a user can paste: a full callback URL, a bare
 * authorization code, or Cline's `code#state` pair.
 */
export function extractClineCode(input: ClineExchangeInput) {
  const raw = (input.callback ?? input.code).trim();
  if (!raw) throw new ProviderError('INVALID_REQUEST', 'Paste the callback URL or the authorization code.', { publicMessage: 'Paste the callback URL or the authorization code.' });
  if (/^https?:\/\//i.test(raw)) {
    const url = assertLoopbackCallback(raw);
    const code = url.searchParams.get('code');
    if (code) return code;
    throw new ProviderError('INVALID_REQUEST', 'That callback URL has no authorization code.', { publicMessage: 'That callback URL has no authorization code.' });
  }
  if (raw.includes('#')) {
    const [code] = raw.split('#');
    if (code?.trim()) return code.trim();
  }
  return raw;
}

export function beginClineAuthorization(redirectUri: string, state?: string): ClineAuthorizeResult {
  assertLoopbackCallback(redirectUri);
  return { authUrl: buildClineAuthorizeUrl(redirectUri, state), redirectUri };
}

/**
 * Turns whatever the user pasted into usable tokens. Cline sometimes encodes
 * the tokens inside the code itself; otherwise the code is exchanged at the
 * token endpoint. Both paths are real requests.
 */
export async function exchangeClineCode(input: ClineExchangeInput, transport: HttpTransport, signal?: AbortSignal): Promise<ClineTokens> {
  const redirectUri = assertLoopbackCallback(input.redirectUri).toString();
  const code = extractClineCode(input);

  const embedded = decodeClineCode(code);
  if (embedded) return embedded;

  let response;
  try {
    response = await transport.request<Record<string, unknown>>({
      method: 'POST',
      providerId: 'cline',
      url: CLINE_OAUTH.tokenUrl,
      headers: clineHeaders('', { 'content-type': 'application/json', accept: 'application/json' }),
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_type: CLINE_OAUTH.clientType, redirect_uri: redirectUri }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // A code Cline will not accept is an authentication problem the user can
    // fix by signing in again. A network failure is not, so that stays as-is.
    if (error instanceof ProviderError && (error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'PROVIDER_TIMEOUT' || error.code === 'CANCELLED')) throw error;
    throw new ProviderError('AUTHENTICATION_FAILED', 'Cline did not accept that sign-in. Try again.', {
      providerId: 'cline',
      publicMessage: 'Cline did not accept that sign-in. Try again.',
      cause: error,
    });
  }

  const payload = (response.data ?? {}) as {
    accessToken?: string;
    access_token?: string;
    refreshToken?: string;
    refresh_token?: string;
    expiresAt?: string | number;
    data?: { accessToken?: string; refreshToken?: string; expiresAt?: string; userInfo?: { email?: string } };
  };
  const accessToken = payload.accessToken ?? payload.access_token ?? payload.data?.accessToken;
  if (!accessToken) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'Cline did not return an access token for that code.', { providerId: 'cline', publicMessage: 'Cline did not return an access token for that code.' });
  }
  const expires = payload.expiresAt ?? payload.data?.expiresAt;
  return {
    accessToken,
    ...(typeof (payload.refreshToken ?? payload.refresh_token ?? payload.data?.refreshToken) === 'string'
      ? { refreshToken: (payload.refreshToken ?? payload.refresh_token ?? payload.data?.refreshToken) as string }
      : {}),
    ...(expires === undefined ? {} : { expiresAt: typeof expires === 'number' ? new Date(expires).toISOString() : expires }),
    ...(typeof payload.data?.userInfo?.email === 'string' ? { email: payload.data.userInfo.email } : {}),
  };
}

export function toClineCredential(tokens: ClineTokens): ProviderCredential {
  return {
    type: 'oauth',
    value: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    ...(tokens.email ? { email: tokens.email } : {}),
  };
}

/** Builds the Cline adapter with token renewal wired back into the vault. */
export function createClineAdapter(options: { transport?: HttpTransport; onTokensRefreshed?: (tokens: ClineTokens) => void | Promise<void> }) {
  return new ClineAdapter({
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.onTokensRefreshed ? { onTokensRefreshed: options.onTokensRefreshed } : {}),
  });
}
