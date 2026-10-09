import {
  connectGatewayOauthProvider,
  requestJson,
  type GatewayConnection,
} from './gatewayClient';

/**
 * Kiro's sign-in, as six ways in.
 *
 * Kiro is not one login. It is AWS's OIDC device flow for an AWS account, the same flow
 * pointed at a company's own Identity Center, a social login through Kiro's own auth host,
 * and two ways to bring a credential you already hold. Each is a different exchange with a
 * different failure mode, so they are kept apart here rather than folded into one generic
 * "paste a token" box that would be wrong for most of them.
 */

export type KiroAuthMethod =
  | 'builder-id'
  | 'organization'
  | 'google'
  | 'github'
  | 'import-token'
  | 'api-key';

export type KiroMethod = {
  id: KiroAuthMethod;
  title: string;
  detail: string;
  /** The first line of a method's own instructions, shown once it is chosen. */
  hint?: string;
};

/**
 * The methods, in the order they are worth trying.
 *
 * "Recommended" is on Builder ID because it is the one that needs nothing the user has to
 * go and find: no start URL to copy out of a company portal, no exported token, no key
 * that has to be created first.
 */
export const KIRO_METHODS: KiroMethod[] = [
  {
    id: 'builder-id',
    title: 'AWS Builder ID',
    detail: 'Recommended for most users. Sign in with the AWS account linked to Kiro AI.',
    hint: 'A code appears here and your browser opens the approval page. Nothing to paste.',
  },
  {
    id: 'organization',
    title: 'Your Organization (AWS IAM Identity Center)',
    detail: 'Use your company SSO start URL, for example https://your-org.awsapps.com/start.',
    hint: 'Paste the start URL your company gave you. It must end in /start.',
  },
  {
    id: 'google',
    title: 'Google Account',
    detail: 'Log in with your Google account.',
    hint: 'Kiro sends your browser to a kiro:// address, which only the Kiro app can open. Copy the code from your address bar and paste it below.',
  },
  {
    id: 'github',
    title: 'GitHub Account',
    detail: 'Log in with your GitHub account.',
    hint: 'Kiro sends your browser to a kiro:// address, which only the Kiro app can open. Copy the code from your address bar and paste it below.',
  },
  {
    id: 'import-token',
    title: 'Import Token',
    detail: 'Paste a refresh token exported from Kiro AI.',
    hint: 'It is spent once here to get a session, so what gets stored is not the token you pasted.',
  },
  {
    id: 'api-key',
    title: 'API Key',
    detail: 'Paste a long-lived Kiro AI / CodeWhisperer API key. It is stored as a bearer credential with no refresh token; profile discovery is best-effort.',
    hint: 'A key cannot be renewed, so this connection has to be replaced by hand when it stops working.',
  },
];

export function kiroMethod(id: KiroAuthMethod): KiroMethod {
  return KIRO_METHODS.find((method) => method.id === id) ?? KIRO_METHODS[0]!;
}

/* ------------------------------------------------------------------ *
 * The exchanges
 * ------------------------------------------------------------------ */

export type KiroDeviceSignIn = {
  sessionId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
};

export type KiroSignInStatus = {
  status: 'pending' | 'connected' | 'failed' | 'expired';
  connection?: GatewayConnection;
  error?: string;
  userCode?: string;
  verificationUrl?: string;
};

export function startKiroDeviceSignIn(startUrl?: string): Promise<KiroDeviceSignIn> {
  return requestJson<KiroDeviceSignIn>('/v1/oauth/kiro/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(startUrl ? { startUrl } : {}),
  });
}

export function getKiroSignInStatus(sessionId: string, signal?: AbortSignal): Promise<KiroSignInStatus> {
  return requestJson<KiroSignInStatus>(`/v1/oauth/kiro/session/${encodeURIComponent(sessionId)}`, { signal });
}

export type KiroSocialSignIn = { sessionId: string; authUrl: string };

/**
 * Google or GitHub through Kiro's device flow: the gateway returns a code and a verification URL, and the
 * session is polled like Builder ID's. There is no paste step, so no authorization URL is involved.
 */
export type KiroSocialDeviceSignIn = { sessionId: string; userCode: string; verificationUrl: string };

export function startKiroSocialDeviceSignIn(provider: 'google' | 'github'): Promise<KiroSocialDeviceSignIn> {
  return requestJson<KiroSocialDeviceSignIn>('/v1/oauth/kiro/social/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
}

export function startKiroSocialSignIn(provider: 'google' | 'github'): Promise<KiroSocialSignIn> {
  return requestJson<KiroSocialSignIn>('/v1/oauth/kiro/social/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider }),
  });
}

export function exchangeKiroSocialCode(sessionId: string, code: string): Promise<{ connection: GatewayConnection }> {
  return requestJson<{ connection: GatewayConnection }>('/v1/oauth/kiro/social/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, code }),
  });
}

export function importKiroRefreshToken(refreshToken: string): Promise<{ connection: GatewayConnection }> {
  return requestJson<{ connection: GatewayConnection }>('/v1/oauth/kiro/import-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
}

export function connectKiroApiKey(apiKey: string): Promise<{ connection: GatewayConnection }> {
  return requestJson<{ connection: GatewayConnection }>('/v1/oauth/kiro/api-key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
}

/**
 * Pulls a code out of whatever the user pasted.
 *
 * The social flow hands back a whole `kiro://…?code=…&state=…` URL, and people paste the
 * address bar verbatim, so a bare code and a full URL are both accepted. The provider is
 * also validated as a known option rather than interpolated into anything.
 */
export function extractKiroCode(pasted: string): string {
  const trimmed = pasted.trim();
  if (!trimmed) return '';
  // A `kiro://` or `https://` address, possibly with the code in the fragment.
  if (trimmed.includes('://') || trimmed.includes('code=')) {
    const query = trimmed.split('#')[0] ?? trimmed;
    const match = /[?&#]code=([^&#]+)/.exec(query) ?? /code=([^&#]+)/.exec(query);
    if (match?.[1]) return decodeURIComponent(match[1]);
    return '';
  }
  // A bare code, or a `code#state` pair.
  return trimmed.split('#')[0]?.trim() ?? trimmed;
}

export { connectGatewayOauthProvider };
