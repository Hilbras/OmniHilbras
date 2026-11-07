import { NOUS_BASE_URL, NOUS_PORTAL_BASE_URL, nousProviderId } from '@omnihilbras/sdk-nous';
import { SignInSessionStore, type SignInSessionBase } from '../core/sign-in-sessions.js';

/**
 * Nous Research sign-in.
 *
 * A device flow at the portal: the start asks for a code, the user approves it on Nous's own page, the
 * gateway polls until the grant lands, and the adapter then mints an **agent key** from the access token
 * — the bearer the inference host accepts. The reference project ships the same shape
 * (`hermes-cli`, scope `inference:invoke inference:mint_agent_key`), including the best-effort mint.
 *
 * The card also takes an API key, and this flow is the second way into the same connection: both end as a
 * bearer the inference host accepts, so nothing downstream needs to know which one was used.
 */

const sessionIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
const defaultTtlMs = 10 * 60_000;

export type NousSessionStatus = {
  status: 'pending' | 'connected' | 'failed' | 'expired';
  /** The code the user types into Nous's page. */
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
  status: NousSessionStatus['status'];
  connection?: unknown;
  error?: string;
  /** Set once the grant has been claimed, so a poll cannot spend the same device code twice. */
  claimed: boolean;
  /** The connection this sign-in saves to, decided when it starts: repair vs add-account. */
  connectionId?: string;
};

type CreateInput = { deviceCode: string; userCode: string; verificationUrl: string; connectionId?: string };

export class NousSessionStore {
  private readonly store: SignInSessionStore<Session, CreateInput>;

  constructor(options: { ttlMs?: number } = {}) {
    this.store = new SignInSessionStore<Session, CreateInput>({
      ttlMs: options.ttlMs ?? defaultTtlMs,
      isPlausibleId: (id) => sessionIdPattern.test(id),
      build: (input, { id, expiresAt }) => ({
        id,
        deviceCode: input.deviceCode,
        userCode: input.userCode,
        verificationUrl: input.verificationUrl,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        expiresAt,
        status: 'pending',
        claimed: false,
      }),
      read: (session) => ({ userCode: session.userCode, verificationUrl: session.verificationUrl }),
    });
  }

  create(input: { deviceCode: string; userCode: string; verificationUrl: string; connectionId?: string; expiresIn?: number }): Session {
    return this.store.create(
      { deviceCode: input.deviceCode, userCode: input.userCode, verificationUrl: input.verificationUrl, ...(input.connectionId ? { connectionId: input.connectionId } : {}) },
      input.expiresIn,
    );
  }

  get(id: string): Session | undefined {
    return this.store.get(id);
  }

  connectionId(id: string): string | undefined {
    return this.get(id)?.connectionId;
  }

  claim(id: string): Session | undefined {
    return this.store.claim(id);
  }

  release(session: Session) {
    this.store.release(session);
  }

  resolve(id: string, patch: { status: SignInSessionBase['status']; connection?: unknown; error?: string }) {
    this.store.resolve(id, patch);
  }

  publicStatus(session: Session): NousSessionStatus {
    return this.store.publicStatus(session);
  }
}

export { nousProviderId, NOUS_BASE_URL, NOUS_PORTAL_BASE_URL };