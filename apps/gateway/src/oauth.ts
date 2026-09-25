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
 * Cline has no browser callback we can own, so the dashboard asks the user to
 * paste what the browser ends up with. The gateway only accepts a loopback
 * callback so a pasted redirect can never point somewhere else.
 */
export const clineCallbackPath = '/v1/oauth/cline/callback';

export type ClineAuthorizeResult = {
  authUrl: string;
  redirectUri: string;
};

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

export function beginClineAuthorization(redirectUri: string): ClineAuthorizeResult {
  assertLoopbackCallback(redirectUri);
  return { authUrl: buildClineAuthorizeUrl(redirectUri), redirectUri };
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
