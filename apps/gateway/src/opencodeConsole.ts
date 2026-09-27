import { OPENCODE_CONSOLE, opencodeConsoleProviderId } from '@hilbras/omnihilbras';
import type { ProviderCredential } from '@hilbras/omnihilbras';

/**
 * OpenCode Console sign-in.
 *
 * This is a device flow rather than a redirect: the gateway asks the Console for a
 * device code, the user approves it in a browser, and the gateway then polls for the
 * token. Nothing is redirected back to us, so the dashboard shows the code and waits.
 *
 * The Console answers a pending poll with HTTP 400 and a body naming the reason, which
 * a provider error would flatten, so these calls go to the fixed Console host directly
 * rather than through the provider transport. The host is a constant and nothing in the
 * request is user-controlled, so there is no address to inject.
 */

/** Matches the gateway's other sign-in session ids. */
const sessionIdPattern = /^[A-Za-z0-9_-]{16,128}$/;

const defaultTtlMs = 10 * 60_000;

export type OpencodeConsoleSessionStatus = {
  status: 'pending' | 'connected' | 'failed' | 'expired';
  /** The code the user types into the Console page. */
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  error?: string;
  connection?: unknown;
};

type Session = {
  id: string;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  status: OpencodeConsoleSessionStatus['status'];
  connection?: unknown;
  error?: string;
  /** Set once the token has been claimed, so a poll cannot exchange it twice. */
  claimed: boolean;
};

export class OpencodeConsoleSessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? defaultTtlMs;
  }

  create(input: { deviceCode: string; userCode: string; verificationUrl: string; expiresIn?: number }): Session {
    this.sweep();
    const id = crypto.randomUUID().replace(/-/g, '');
    const ttl = Math.min(this.ttlMs, (input.expiresIn ?? this.ttlMs / 60000) * 1000);
    const session: Session = {
      id,
      deviceCode: input.deviceCode,
      userCode: input.userCode,
      verificationUrl: input.verificationUrl,
      expiresAt: Date.now() + ttl,
      status: 'pending',
      claimed: false,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    if (!sessionIdPattern.test(id)) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.status === 'pending' && Date.now() >= session.expiresAt) {
      session.status = 'expired';
      session.error = 'This sign-in expired before it was approved. Start again from OmniHilbras.';
    }
    return session;
  }

  /** Returns the session only if the token has not already been exchanged. */
  claim(id: string): Session | undefined {
    const session = this.get(id);
    if (!session || session.claimed) return undefined;
    session.claimed = true;
    return session;
  }

  /** Puts a session back in play after a failed exchange, so a retry can finish it. */
  release(session: Session) {
    session.claimed = false;
  }

  resolve(id: string, patch: { status: OpencodeConsoleSessionStatus['status']; connection?: unknown; error?: string }) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = patch.status;
    if (patch.connection !== undefined) session.connection = patch.connection;
    if (patch.error !== undefined) session.error = patch.error;
  }

  publicStatus(session: Session): OpencodeConsoleSessionStatus {
    return {
      status: session.status,
      userCode: session.userCode,
      verificationUrl: session.verificationUrl,
      expiresAt: new Date(session.expiresAt).toISOString(),
      ...(session.error ? { error: session.error } : {}),
      ...(session.connection !== undefined ? { connection: session.connection } : {}),
    };
  }

  private sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < cutoff) this.sessions.delete(id);
    }
  }
}

type DeviceCodeResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type Org = { id?: string; name?: string };
type User = { id?: string; email?: string };

async function postJson<T>(path: string, body: Record<string, string>): Promise<{ status: number; data: T }> {
  const response = await fetch(`${OPENCODE_CONSOLE.server}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: T = {} as T;
  try {
    data = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    data = {} as T;
  }
  return { status: response.status, data };
}

async function getJson<T>(path: string, accessToken: string, extra: Record<string, string> = {}): Promise<T | undefined> {
  const response = await fetch(`${OPENCODE_CONSOLE.server}${path}`, {
    headers: { accept: 'application/json', Authorization: `Bearer ${accessToken}`, ...extra },
  });
  if (!response.ok) return undefined;
  const text = await response.text();
  try {
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Asks the Console for a device code.
 *
 * The verification URI comes back relative, and it belongs to the Console's *web* host
 * rather than its API host — joining it to `server` yields `/console/console/device`,
 * which renders a blank page and looks like the flow did nothing. The page also
 * redirects to a Console login when the browser has no session, and it carries the
 * device query through as `next`, so signing in lands back on the code.
 */
export async function beginOpencodeConsoleSignIn(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn?: number;
}> {
  const { data } = await postJson<DeviceCodeResponse>(OPENCODE_CONSOLE.deviceCodePath, { client_id: OPENCODE_CONSOLE.clientId });
  const deviceCode = typeof data.device_code === 'string' ? data.device_code : '';
  const userCode = typeof data.user_code === 'string' ? data.user_code : '';
  if (!deviceCode || !userCode) {
    throw new Error('OpenCode Console did not return a device code. Try again in a moment.');
  }
  const relative = data.verification_uri_complete ?? data.verification_uri ?? '/console/device';
  return {
    deviceCode,
    userCode,
    verificationUrl: `${OPENCODE_CONSOLE.webOrigin}${relative.startsWith('/') ? '' : '/'}${relative}`,
    ...(typeof data.expires_in === 'number' ? { expiresIn: data.expires_in } : {}),
  };
}

export type PollOutcome =
  | { status: 'pending' }
  | { status: 'denied'; error: string }
  | { status: 'connected'; credential: ProviderCredential; account: string };

/**
 * Polls the Console for the token. A pending answer is HTTP 400 with the reason in the
 * body, so the status is read from the payload rather than treated as a failure.
 */
export async function pollOpencodeConsoleSignIn(deviceCode: string): Promise<PollOutcome> {
  const { data } = await postJson<TokenResponse>(OPENCODE_CONSOLE.deviceTokenPath, {
    grant_type: OPENCODE_CONSOLE.grantType,
    device_code: deviceCode,
    client_id: OPENCODE_CONSOLE.clientId,
  });

  const error = typeof data.error === 'string' ? data.error : '';
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'pending' };
  if (error) {
    const description = typeof data.error_description === 'string' ? data.error_description : '';
    return { status: 'denied', error: description || `OpenCode Console reported ${error.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}.` };
  }
  const access = typeof data.access_token === 'string' ? data.access_token : '';
  if (!access) return { status: 'denied', error: 'OpenCode Console did not return a session. Start the sign-in again.' };

  const [user, orgs] = await Promise.all([
    getJson<User>(OPENCODE_CONSOLE.userPath, access),
    getJson<Org[]>(OPENCODE_CONSOLE.orgsPath, access),
  ]);
  // The client picks the alphabetically first org, so the same account resolves to the
  // same org here as it does there.
  const org = [...(orgs ?? [])].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || (a.id ?? '').localeCompare(b.id ?? ''))[0];
  /**
   * The config cannot be read without an org: it answers
   * `400 {"code":"org_required","message":"x-org-id is required"}`. So the org is
   * resolved first, from the orgs list, and the config is then read with it.
   *
   * Note the two header names, which are not the same. The *config* call wants
   * `x-org-id`; the config it returns then names `x-opencode-org-id` for inference.
   * Sending the inference spelling to the config call is refused.
   */
  // The config is not read here: the adapter reads it per request, and it is the
  // adapter that knows the config call needs `x-org-id`. Storing the orgs-list id is
  // enough, because the config names that same value for inference.
  const orgId = org?.id;
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : undefined;

  const credential: ProviderCredential = {
    type: 'oauth',
    value: access,
    ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
    ...(expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }),
    ...(user?.email ? { email: user.email } : {}),
    ...(orgId ? { orgId } : {}),
    ...(org?.name ? { orgName: org.name } : {}),
    ...(user?.id ? { accountId: user.id } : {}),
  };
  return { status: 'connected', credential, account: user?.email ?? org?.name ?? 'your OpenCode Console account' };
}

export const opencodeConsoleProviderLabel = 'OpenCode Console';
export { OPENCODE_CONSOLE, opencodeConsoleProviderId };
