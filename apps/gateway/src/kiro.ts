import {
  KIRO_MODELS,
  beginKiroSignIn,
  kiroProviderId,
  pollKiroSignIn,
  type KiroDeviceAuthorization,
} from '@hilbras/omnihilbras';
import type { ProviderCredential } from '@hilbras/omnihilbras';

/**
 * The Kiro sign-in is AWS's OIDC device flow, so the session here is the device code
 * plus the dynamically registered public client that goes with it. The client is
 * registered per sign-in rather than stored, because AWS issues it on demand and it is
 * only valid alongside the device code it was issued for.
 */
const sessionIdPattern = /^[A-Za-z0-9_-]{16,128}$/;

const defaultTtlMs = 15 * 60_000;

type Session = {
  id: string;
  authorization: KiroDeviceAuthorization;
  expiresAt: number;
  status: 'pending' | 'connected' | 'failed' | 'expired';
  connection?: unknown;
  error?: string;
  /** Set once the token has been claimed, so two polls cannot spend the same grant. */
  claimed: boolean;
};

export type KiroSignInStatus = {
  status: Session['status'];
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  error?: string;
  connection?: unknown;
};

export class KiroSessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? defaultTtlMs;
  }

  create(authorization: KiroDeviceAuthorization): Session {
    this.sweep();
    const id = crypto.randomUUID().replace(/-/g, '');
    const ttl = Math.min(this.ttlMs, (authorization.expiresIn ?? this.ttlMs / 60000) * 1000);
    const session: Session = { id, authorization, expiresAt: Date.now() + ttl, status: 'pending', claimed: false };
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

  /** Returns the session only if the grant has not already been exchanged. */
  claim(id: string): Session | undefined {
    const session = this.get(id);
    if (!session || session.claimed) return undefined;
    session.claimed = true;
    return session;
  }

  release(session: Session) {
    session.claimed = false;
  }

  resolve(id: string, patch: { status: Session['status']; connection?: unknown; error?: string }) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = patch.status;
    if (patch.connection !== undefined) session.connection = patch.connection;
    if (patch.error !== undefined) session.error = patch.error;
  }

  publicStatus(session: Session): KiroSignInStatus {
    return {
      status: session.status,
      userCode: session.authorization.userCode,
      verificationUrl: session.authorization.verificationUrl,
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

export async function startKiroSignIn(store: KiroSessionStore) {
  const authorization = await beginKiroSignIn();
  const session = store.create(authorization);
  return {
    sessionId: session.id,
    userCode: session.authorization.userCode,
    verificationUrl: session.authorization.verificationUrl,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

export type KiroPollOutcome =
  | { status: 'pending' }
  | { status: 'denied'; error: string }
  | { status: 'connected'; credential: ProviderCredential };

/**
 * Polls AWS for the session.
 *
 * The exchange is claimed before AWS is called: a device grant is single-use, and the
 * dashboard polls on a timer, so a second poll arriving while the first is still saving
 * would spend the dead grant and report a failure over a success.
 */
export async function pollKiroSignInWithClaim(store: KiroSessionStore, sessionId: string): Promise<KiroPollOutcome | 'in-progress'> {
  const session = store.get(sessionId);
  if (!session) return { status: 'denied', error: 'Unknown sign-in session.' };
  if (session.status !== 'pending') return 'in-progress';
  if (!store.claim(sessionId)) return 'in-progress';

  const outcome = await pollKiroSignIn(session.authorization);
  if (outcome.status === 'pending') {
    store.release(session);
    return { status: 'pending' };
  }
  if (outcome.status === 'denied') {
    store.resolve(sessionId, { status: 'failed', error: outcome.error });
    return { status: 'denied', error: outcome.error };
  }
  const credential: ProviderCredential = {
    type: 'oauth',
    value: outcome.accessToken,
    ...(outcome.refreshToken ? { refreshToken: outcome.refreshToken } : {}),
    ...(outcome.expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + outcome.expiresIn * 1000).toISOString() }),
    // AWS scopes the session to a profile, and Kiro echoes it back on inference.
    ...(outcome.profileArn ? { accountId: outcome.profileArn } : {}),
  };
  return { status: 'connected', credential };
}

export { KIRO_MODELS, kiroProviderId };
