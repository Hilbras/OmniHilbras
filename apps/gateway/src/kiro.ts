import {
  KIRO_MODELS,
  beginKiroSignIn,
  buildKiroSocialUrl,
  createKiroPkce,
  kiroProviderId,
  kiroSocialSessionExpired,
  registerKiroClient,
  newKiroSocialState,
  pollKiroSignIn,
  refreshKiroCredential,
  type KiroDeviceAuthorization,
  type KiroSocialProvider,
  type KiroSocialSession,
} from '@hilbras/omnihilbras';
import { SignInSessionStore, claimOnce, releaseClaim } from './sign-in-sessions.js';
import { ProviderError } from '@hilbras/omnihilbras';
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

/**
 * Kiro's sign-in sessions.
 *
 * A declaration of Kiro's session *shape*, and nothing else. The lifecycle — expiry, claiming a
 * grant exactly once, releasing a failed exchange, the sweep, the public projection — is
 * `SignInSessionStore`, which it shares with OpenCode Console because the two were the same code.
 *
 * Kiro nests its device authorization rather than flattening it, so `session.authorization` is
 * what the polling path reads. That is Kiro's shape and it stays Kiro's.
 */
export class KiroSessionStore {
  private readonly store: SignInSessionStore<Session, KiroDeviceAuthorization>;

  constructor(options: { ttlMs?: number } = {}) {
    const ttlMs = options.ttlMs ?? defaultTtlMs;
    this.store = new SignInSessionStore<Session, KiroDeviceAuthorization>({
      ttlMs,
      isPlausibleId: (id) => sessionIdPattern.test(id),
      build: (authorization, { id, expiresAt }) => ({ id, authorization, expiresAt, status: 'pending', claimed: false }),
      read: (session) => ({ userCode: session.authorization.userCode, verificationUrl: session.authorization.verificationUrl }),
    });
  }

  create(authorization: KiroDeviceAuthorization): Session {
    return this.store.create(authorization, authorization.expiresIn);
  }

  get(id: string): Session | undefined {
    return this.store.get(id);
  }

  claim(id: string): Session | undefined {
    return this.store.claim(id);
  }

  release(session: Session) {
    this.store.release(session);
  }

  resolve(id: string, patch: { status: Session['status']; connection?: unknown; error?: string }) {
    this.store.resolve(id, patch);
  }

  publicStatus(session: Session): KiroSignInStatus {
    return this.store.publicStatus(session);
  }
}

export async function startKiroSignIn(store: KiroSessionStore, startUrl?: string) {
  const authorization = await beginKiroSignIn(startUrl);
  const session = store.create(authorization);
  return {
    sessionId: session.id,
    userCode: session.authorization.userCode,
    verificationUrl: session.authorization.verificationUrl,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Imported credentials
 * ------------------------------------------------------------------ */

/**
 * Exchanges a refresh token the user exported from Kiro for a usable session.
 *
 * This is a real exchange, not a stored paste: the refresh token is spent once to get an
 * access token, and the *access* token is what gets stored, so the imported secret is not
 * the thing every request authenticates with.
 */
export async function importKiroRefreshToken(refreshToken: string): Promise<ProviderCredential> {
  const trimmed = refreshToken.trim();
  if (!trimmed) {
    throw new ProviderError('INVALID_REQUEST', 'Paste a Kiro refresh token to import.', {
      providerId: kiroProviderId,
      publicMessage: 'Paste a Kiro refresh token to import.',
    });
  }
  /**
   * A refresh token is only usable by the client it was issued to, and an imported token
   * arrives with no client alongside it. So one is registered here and the token is
   * redeemed against it. AWS refuses a token from a different client with
   * `invalid_grant`, and that answer is passed through rather than reported as a bad
   * paste — a token from the Kiro desktop app will simply not work here, and saying so
   * is more use than "could not connect".
   */
  const { clientId, clientSecret } = await registerKiroClient();
  return refreshKiroCredential({
    type: 'oauth',
    value: '',
    refreshToken: trimmed,
    oauthClientId: clientId,
    oauthClientSecret: clientSecret,
  });
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
    // The registered client, which the refresh grant is bound to.
    oauthClientId: outcome.clientId,
    oauthClientSecret: outcome.clientSecret,
  };
  return { status: 'connected', credential };
}

export { KIRO_MODELS, kiroProviderId };


/* ------------------------------------------------------------------ *
 * Social sign-in sessions
 * ------------------------------------------------------------------ */

/**
 * One in-flight Google or GitHub sign-in.
 *
 * The PKCE verifier lives here and never leaves the gateway: the browser only ever holds
 * the challenge, so a code pasted into it cannot be exchanged without the matching
 * verifier. Sessions are dropped once they age out, and a code can only be spent once —
 * an authorization code is single-use, so a double submit must not burn it.
 */
export class KiroSocialStore {
  private readonly sessions = new Map<string, KiroSocialSession & { claimed: boolean }>();

  create(provider: KiroSocialProvider, verifier: string, state: string): string {
    this.sweep();
    const id = crypto.randomUUID().replace(/-/g, '');
    this.sessions.set(id, { provider, verifier, state, createdAt: Date.now(), claimed: false });
    return id;
  }

  get(id: string): (KiroSocialSession & { claimed: boolean }) | undefined {
    if (!sessionIdPattern.test(id)) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (kiroSocialSessionExpired(session)) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  /** Returns the session only if its code has not been spent, and marks it spent. */
  claim(id: string): KiroSocialSession | undefined {
    // The spending rule is shared with the other sign-in stores. The lifecycle around it is not:
    // this store expires on `createdAt`, deletes rather than marks, and has no public status.
    return claimOnce(() => this.get(id));
  }

  /** Un-claims a session whose exchange did not go through, so the code can be retried. */
  release(id: string) {
    const stored = this.sessions.get(id);
    if (stored) releaseClaim(stored);
  }

  private sweep() {
    for (const [id, session] of this.sessions) {
      if (kiroSocialSessionExpired(session)) this.sessions.delete(id);
    }
  }
}

/** Starts a Google or GitHub sign-in and returns the URL the user must open. */
export async function startKiroSocialSignIn(store: KiroSocialStore, provider: KiroSocialProvider) {
  const { verifier, challenge } = await createKiroPkce();
  const state = newKiroSocialState();
  const sessionId = store.create(provider, verifier, state);
  return { sessionId, authUrl: buildKiroSocialUrl(provider, challenge, state) };
}
