import { randomBytes } from 'node:crypto';

/**
 * The standalone ZCode OAuth flow, the same one the desktop app uses for a CLI sign-in.
 *
 * The app has two ways in: a browser redirect to `zcode://oauth/callback` (which needs the app
 * registered as a scheme handler) and a **polling** flow that needs neither a custom scheme nor the
 * app. The polling flow is what a gateway can use:
 *
 *  1. `POST /api/v1/oauth/cli/init` with a locally generated bearer and `{ provider }` answers
 *     `{ flow_id, poll_token, authorize_url, expires_at, poll_interval_sec }`. The `authorize_url`
 *     already points at the server's own callback, so nothing local has to receive a redirect.
 *  2. The user opens `authorize_url` in any browser and signs in.
 *  3. `GET /api/v1/oauth/cli/poll/<flow_id>` with the returned `poll_token` answers `pending` until
 *     the sign-in completes, then `ready` with `data.token` (the `zcodejwttoken`), the account
 *     `data.user.user_id`, and the provider access token.
 *
 * Verified live: `init` answered 200 with a real `authorize_url`, and `poll` answered `pending` with
 * the returned token while rejecting a different one with `code: 3004, invalid_flow`. The token is
 * obtained from ZCode's own OAuth server; nothing is read from the installed app.
 */

const ZCODE_OAUTH_ORIGIN = 'https://zcode.z.ai';

export type ZcodeOAuthProvider = 'zai' | 'bigmodel';

export type ZcodeOAuthStart = {
  flowId: string;
  /** Sent to the poll route. Server-issued; a different token is rejected with `invalid_flow`. */
  pollToken: string;
  authorizeUrl: string;
  /** Unix seconds. */
  expiresAt: number;
  pollIntervalSec: number;
};

export type ZcodeOAuthPoll =
  | { status: 'pending' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; token: string; accountUuid?: string; accessToken?: string; refreshToken?: string };

type InitBody = {
  code?: number;
  msg?: string;
  data?: {
    flow_id?: string;
    poll_token?: string;
    authorize_url?: string;
    expires_at?: number;
    poll_interval_sec?: number;
  };
};

type PollBody = {
  code?: number;
  msg?: string;
  data?: {
    status?: string;
    token?: string;
    user?: { user_id?: string; name?: string; email?: string; avatar?: string };
    zai?: { access_token?: string; accessToken?: string };
    bigmodel?: { access_token?: string; accessToken?: string; refresh_token?: string; refreshToken?: string };
  };
};

export type ZcodeOAuthOptions = {
  origin?: string;
  signal?: AbortSignal;
};

function errorFrom(body: { code?: number; msg?: string }, fallback: string): Error {
  const message = body.msg?.trim();
  return new Error(message || fallback);
}

/** Starts a sign-in and returns the URL to open plus the server-issued poll token. */
export async function startZcodeOAuth(provider: ZcodeOAuthProvider = 'zai', options: ZcodeOAuthOptions = {}): Promise<ZcodeOAuthStart> {
  const origin = options.origin ?? ZCODE_OAUTH_ORIGIN;
  // The init call carries a locally generated bearer; the server does not need an account, only the
  // poll token it returns for the later poll call.
  const local = randomBytes(32).toString('hex');
  const response = await fetch(`${origin}/api/v1/oauth/cli/init`, {
    method: 'POST',
    headers: { authorization: `Bearer ${local}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ provider }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = (await response.json().catch(() => ({}))) as InitBody;
  if (!response.ok || body.code !== 0) throw errorFrom(body, `ZCode sign-in could not start (HTTP ${response.status}).`);
  const data = body.data ?? {};
  if (typeof data.flow_id !== 'string' || typeof data.poll_token !== 'string' || typeof data.authorize_url !== 'string' || typeof data.expires_at !== 'number' || typeof data.poll_interval_sec !== 'number') {
    throw new Error('ZCode sign-in answered without a flow id, poll token, authorize URL or lifetime.');
  }
  return {
    flowId: data.flow_id,
    pollToken: data.poll_token,
    authorizeUrl: data.authorize_url,
    expiresAt: data.expires_at,
    pollIntervalSec: Math.max(1, Math.floor(data.poll_interval_sec)),
  };
}

/** One poll. `pending` is a normal answer, not an error. */
export async function pollZcodeOAuth(flowId: string, pollToken: string, options: ZcodeOAuthOptions = {}): Promise<ZcodeOAuthPoll> {
  const origin = options.origin ?? ZCODE_OAUTH_ORIGIN;
  const response = await fetch(`${origin}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`, {
    headers: { authorization: `Bearer ${pollToken}`, accept: 'application/json' },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = (await response.json().catch(() => ({}))) as PollBody;
  // `invalid_flow` means the flow expired or was already consumed; both are terminal for this flow.
  if (!response.ok || body.code !== 0) return { status: 'failed', message: body.msg?.trim() || `ZCode sign-in poll failed (HTTP ${response.status}).` };
  const data = body.data ?? {};
  if (data.status === 'pending') return { status: 'pending' };
  if (data.status === 'failed') return { status: 'failed', message: body.msg?.trim() || 'ZCode sign-in was refused.' };
  if (data.status !== 'ready') return { status: 'failed', message: `ZCode sign-in answered an unexpected status: ${String(data.status)}` };

  const token = data.token?.trim();
  const accountUuid = data.user?.user_id?.trim() || undefined;
  const accessToken = (data.zai?.access_token ?? data.zai?.accessToken ?? data.bigmodel?.access_token ?? data.bigmodel?.accessToken)?.trim() || undefined;
  const refreshToken = (data.bigmodel?.refresh_token ?? data.bigmodel?.refreshToken)?.trim() || undefined;
  if (!token) return { status: 'failed', message: 'ZCode sign-in completed without a token.' };
  return { status: 'ready', token, ...(accountUuid ? { accountUuid } : {}), ...(accessToken ? { accessToken } : {}), ...(refreshToken ? { refreshToken } : {}) };
}