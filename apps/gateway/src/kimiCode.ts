import { KimiCodeAdapter, kimiCodeCredentialExpired, kimiCodeProviderId } from '@hilbras/omnihilbras';
import { SignInSessionStore, type SignInSessionBase } from './sign-in-sessions.js';

/**
 * Kimi Code sign-in.
 *
 * A device flow rather than a redirect: the gateway asks Kimi for a code, the user approves it in a
 * browser, and the gateway polls until Kimi reports it approved. Nothing is redirected back to us, so
 * the dashboard shows the code and waits.
 *
 * ## Why Kimi answers directly rather than through the provider transport
 *
 * A pending poll is an error code in the body, which a `ProviderError` would flatten into a generic
 * refusal — and the difference matters, because `authorization_pending` and `access_denied` mean
 * "keep waiting" and "give up" respectively. The adapter reads the body as data and returns an
 * outcome, which is what makes `slow_down` a wait rather than a failure (see the tests).
 *
 * ## What is a separate card rather than a mode on the `kimi` card
 *
 * `api.moonshot.ai` sells tokens per call with an API key. `api.kimi.com/coding` is a subscription
 * against an account the user already has. Separate accounts, separate billing, separate endpoints —
 * so `kimi-code` is its own provider id and its own dashboard card, and a connection saved under one
 * is never consulted for the other.
 */

const sessionIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
const defaultTtlMs = 10 * 60_000;

export type KimiCodeSessionStatus = {
  status: 'pending' | 'connected' | 'failed' | 'expired';
  /** The code the user types into Kimi's page. */
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  error?: string;
  connection?: unknown;
};

type Session = {
  id: string;
  deviceCode: string;
  /**
   * Kimi ties the two halves of a device grant together by this id, so the poll must present the one
   * the start minted. Minting a fresh id per poll asks about a different session and returns
   * `authorization_pending` forever — which reads as "the user has not approved yet" indefinitely.
   */
  deviceId: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  status: KimiCodeSessionStatus['status'];
  connection?: unknown;
  error?: string;
  /** Set once the token has been claimed, so a poll cannot exchange it twice. */
  claimed: boolean;
};

/**
 * Kimi Code's sign-in sessions.
 *
 * A declaration of Kimi's session *shape*. The lifecycle is `SignInSessionStore`, shared with the
 * Console and Kiro flows because the three are the same code.
 */
export class KimiCodeSessionStore {
  private readonly store: SignInSessionStore<Session, { deviceCode: string; deviceId: string; userCode: string; verificationUrl: string }>;

  constructor(options: { ttlMs?: number } = {}) {
    const ttlMs = options.ttlMs ?? defaultTtlMs;
    this.store = new SignInSessionStore<Session, { deviceCode: string; deviceId: string; userCode: string; verificationUrl: string }>({
      ttlMs,
      isPlausibleId: (id) => sessionIdPattern.test(id),
      build: (input, { id, expiresAt }) => ({ id, ...input, expiresAt, status: 'pending', claimed: false }),
      read: (session) => ({ userCode: session.userCode, verificationUrl: session.verificationUrl }),
    });
  }

  create(input: { deviceCode: string; deviceId: string; userCode: string; verificationUrl: string; expiresIn?: number }): Session {
    return this.store.create({ deviceCode: input.deviceCode, deviceId: input.deviceId, userCode: input.userCode, verificationUrl: input.verificationUrl }, input.expiresIn);
  }

  get(id: string): Session | undefined {
    return this.store.get(id);
  }

  /** Claims the session so a second poll cannot exchange the same device code. */
  claim(id: string): Session | undefined {
    return this.store.claim(id);
  }

  release(session: Session) {
    this.store.release(session);
  }

  resolve(id: string, patch: { status: SignInSessionBase['status']; connection?: unknown; error?: string }) {
    this.store.resolve(id, patch);
  }

  /** The coordinator's projection, exposed under the name it requires. */
  publicStatus(session: Session): KimiCodeSessionStatus {
    return this.store.publicStatus(session);
  }

  /**
   * Everything the dashboard needs to render the flow, and nothing more.
   *
   * The projection is the store's, not this file's: `publicStatus` reads `userCode` and
   * `verificationUrl` through the `read` callback given at construction, which is how the device code
   * stays off the object a client sees. Re-deriving it here would have been a second place that
   * decides what is public.
   */
  view(session: Session): KimiCodeSessionStatus {
    return this.store.publicStatus(session);
  }
}

/** Asks Kimi for a device code and opens a session to poll. */
export async function beginKimiCodeSignIn(store: KimiCodeSessionStore, adapter: KimiCodeAdapter) {
  const session = store.create(await adapter.beginSignIn());
  return {
    sessionId: session.id,
    userCode: session.userCode,
    verificationUrl: session.verificationUrl,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

/**
 * The session store surface `completeSignIn` needs.
 *
 * Structural, and matching the coordinator's own type, so the two flows cannot drift: the coordinator
 * claims the session before it spends a single-use device code, and a hand-rolled poll that forgot
 * would spend it twice.
 */
export type KimiCodeSessions = {
  get(id: string): Session | undefined;
  claim(id: string): Session | undefined;
  release(session: Session): void;
  resolve(id: string, patch: { status: SignInSessionBase['status']; connection?: unknown; error?: string }): void;
  publicStatus(session: Session): KimiCodeSessionStatus;
};

export { kimiCodeCredentialExpired, kimiCodeProviderId };