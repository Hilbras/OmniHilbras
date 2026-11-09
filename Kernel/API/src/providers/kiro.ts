import { KIRO_MODELS, beginKiroSignIn, kiroProviderId, registerKiroClient, pollKiroSignIn, pollKiroSocialDeviceSignIn, refreshKiroCredential, startKiroSocialDeviceSignIn, type KiroDeviceAuthorization, type KiroPoll, type KiroSocialProvider } from '@omnihilbras/sdk-kiro';
import { SignInSessionStore } from '../core/sign-in-sessions.js';
import { ProviderError } from '../core/index.js';
import { ProviderCredential } from '../core/index.js';

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
  /** The connection this sign-in writes to: the provider id to repair, or a fresh one to add an account. */
  connectionId: string;
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
      build: (authorization, { id, expiresAt }) => ({
        id,
        authorization,
        // Which connection this sign-in will write to. Set at the start, from the caller's choice, so the
        // answer cannot change between starting and polling.
        connectionId: (authorization as KiroDeviceAuthorization & { connectionId?: string }).connectionId ?? kiroProviderId,
        expiresAt,
        status: 'pending',
        claimed: false,
      }),
      read: (session) => ({ userCode: session.authorization.userCode, verificationUrl: session.authorization.verificationUrl }),
    });
  }

  create(authorization: KiroDeviceAuthorization): Session {
    return this.store.create(authorization, authorization.expiresIn);
  }

  /** The connection id a session will save to, once it is approved. */
  connectionId(id: string): string | undefined {
    return this.get(id)?.connectionId;
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

/**
 * Starts a Kiro sign-in.
 *
 * `addAccount` picks the connection it will save to. Both choices are made **now**, not at poll time, so a
 * session cannot change its target halfway through:
 *
 * - `false` (the default) repairs the provider's connection — `id: 'kiro'`, which `save()` upserts.
 * - `true` reserves a fresh id, so the approved account becomes a **second** connection beside the first.
 *   Without this every sign-in overwrote the previous account, because `save()` reuses the connection it
 *   can find for the provider when no id is given.
 */
export async function startKiroSignIn(store: KiroSessionStore, startUrl?: string, addAccount = false, targetConnectionId?: string) {
  const authorization = {
    ...(await beginKiroSignIn(startUrl)),
    connectionId: targetConnectionId ?? (addAccount ? `${kiroProviderId}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}` : kiroProviderId),
  };
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

/**
 * Google or GitHub through Kiro's device flow, the same one OmniRoute uses. Nothing redirects back to the
 * gateway: the user approves a code on Kiro's page and this session polls Kiro's device endpoint for the
 * result. It reuses the Builder ID session store, so the grant is claimed and released by the same rules.
 */
export async function startKiroSocialDeviceFlow(store: KiroSessionStore, provider: KiroSocialProvider, addAccount = false, targetConnectionId?: string) {
  const authorization = await startKiroSocialDeviceSignIn(provider);
  const session = store.create({
    deviceCode: authorization.deviceCode,
    userCode: authorization.userCode,
    verificationUrl: authorization.verificationUrl,
    intervalSeconds: authorization.intervalSeconds,
    clientId: 'kiro-cli',
    clientSecret: '',
    // The same target rule the Builder ID flow states: the connection this sign-in saves to is chosen
    // when it starts, so an add-account grant lands beside the existing connection instead of on it.
    connectionId: targetConnectionId ?? (addAccount ? `${kiroProviderId}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}` : kiroProviderId),
    ...(authorization.expiresIn === undefined ? {} : { expiresIn: authorization.expiresIn }),
    social: true,
  } as KiroDeviceAuthorization & { social: true });
  return { sessionId: session.id, userCode: authorization.userCode, verificationUrl: authorization.verificationUrl };
}

export type KiroPollOutcome =
  | { status: 'pending' }
  | { status: 'denied'; error: string }
  | { status: 'connected'; credential: ProviderCredential };

/**
 * Asks Kiro for one poll of a device grant. A social grant (Google or GitHub) is polled at Kiro's own
 * device endpoint and needs no client secret; a Builder ID grant is polled at AWS's token endpoint with
 * the client it was registered to. Both return the same outcome, so the claim and status logic is shared.
 */
async function pollKiroSignInOutcome(authorization: KiroDeviceAuthorization & { social?: boolean }): Promise<KiroPollOutcomeAny> {
  if (!authorization.social) return pollKiroSignIn(authorization);
  const poll = await pollKiroSocialDeviceSignIn(authorization.deviceCode);
  if (poll.kind === 'pending') return { status: 'pending' };
  if (poll.kind === 'failed') return { status: 'denied', error: poll.error };
  // A social grant always yields an OAuth credential, so narrow to it before reading its fields.
  const credential = poll.credential;
  if (credential.type !== 'oauth') return { status: 'denied', error: 'Kiro returned an unexpected credential type.' };
  return {
    status: 'connected',
    // The credential whole. Rebuilding it from token fields dropped `kiroLogin`, and the adapter's
    // refresh dispatches on that field: without it a social session took the AWS path, found no
    // client pair, and refused to renew — so it worked until the first expiry and then needed a
    // full re-sign-in.
    credential,
  };
}

/** A Builder ID outcome, or a social one, which carries its own credential shape. */
type KiroPollOutcomeAny =
  | KiroPoll
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
  /**
   * The claim is taken by the caller, `completeSignIn`, before this runs. Claiming again here found
   * the session already spent, returned `in-progress`, and the status route then reported `pending`
   * without ever asking Kiro, so an approved grant was never read. The single claim is the caller's.
   */
  const outcome = await pollKiroSignInOutcome(session.authorization);
  if (outcome.status === 'pending') return { status: 'pending' };
  if (outcome.status === 'denied') {
    store.resolve(sessionId, { status: 'failed', error: outcome.error });
    return { status: 'denied', error: outcome.error };
  }
  const credential: ProviderCredential = 'credential' in outcome
    ? outcome.credential
    : {
        type: 'oauth',
        value: outcome.accessToken,
        ...(outcome.refreshToken ? { refreshToken: outcome.refreshToken } : {}),
        ...(outcome.expiresIn === undefined ? {} : { expiresAt: new Date(Date.now() + outcome.expiresIn * 1000).toISOString() }),
        // AWS scopes the session to a profile, and Kiro echoes it back on inference.
        ...(outcome.profileArn ? { accountId: outcome.profileArn } : {}),
        // The registered client, which the refresh grant is bound to.
        ...('clientId' in outcome ? { oauthClientId: outcome.clientId, oauthClientSecret: outcome.clientSecret } : {}),
      };
  return { status: 'connected', credential };
}

export { KIRO_MODELS, kiroProviderId };

