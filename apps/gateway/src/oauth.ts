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

/**
 * Cline hands the sign-in to WorkOS AuthKit, which starts a session of its own
 * and does not echo a caller-supplied `state` back. So the session cannot be
 * correlated by `state` alone: the session id travels in the *path* of the
 * redirect, which the provider must honour verbatim in order to redirect at all.
 *
 * `state` is still sent, and is still checked whenever it does come back, so a
 * provider that echoes it gets the stronger guarantee for free.
 */
export function clineCallbackPathFor(sessionId: string) {
  return `${clineCallbackPath}/${sessionId}`;
}

/** Pulls the session id out of a callback path, if it carries one. */
export function sessionIdFromCallbackPath(pathname: string): string | undefined {
  if (!pathname.startsWith(`${clineCallbackPath}/`)) return undefined;
  const id = pathname.slice(clineCallbackPath.length + 1);
  return /^[A-Za-z0-9_-]{16,128}$/.test(id) ? id : undefined;
}

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
  /** Set once a callback has claimed this session, so it cannot be replayed. */
  claimed?: boolean;
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

  /**
   * `buildRedirect` receives the freshly minted session id and returns the
   * redirect this sign-in will use. The redirect is built from the id because
   * the id has to travel in the redirect path, and the same value must later be
   * sent to the token endpoint: OAuth requires the `redirect_uri` at exchange
   * time to match the one the authorize request carried.
   */
  start(buildRedirect: (sessionId: string) => string) {
    this.prune();
    const id = randomToken(32);
    const session: ClineSession = {
      id,
      state: randomToken(32),
      redirectUri: buildRedirect(id),
      createdAt: this.now(),
      expiresAt: this.now() + clineSessionTtlMs,
      result: { status: 'pending' },
    };
    this.sessions.set(id, session);
    return { sessionId: id, state: session.state as string, redirectUri: session.redirectUri };
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
   * Claims the session a callback belongs to. The session id in the redirect
   * path identifies it; a `state` that comes back is cross-checked when present.
   *
   * Returns nothing when the session is unknown, already used, or expired, so a
   * replayed or forged callback cannot re-run the exchange. The claim is spent
   * whether or not the exchange then succeeds.
   */
  claim(sessionId: string, state?: string): ClineSession | undefined {
    this.prune();
    const session = this.sessions.get(sessionId);
    if (!session || session.claimed) return undefined;
    // A provider that echoes `state` must echo the right one.
    if (state !== undefined && session.state !== undefined && session.state !== state) return undefined;
    // A wrong state spends nothing, so a user whose provider crossed the value
    // can retry; the session id is the capability, and the state only narrows it.
    session.claimed = true;
    delete session.state;
    return session;
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
