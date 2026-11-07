import { createKiloCodeAdapter, KILOCODE, kilocodeProviderId, type KiloCodeAdapterOptions } from '@omnihilbras/sdk-kilocode';
import { SignInSessionStore, type SignInSessionBase } from '../core/sign-in-sessions.js';

/**
 * Kilo Code sign-in.
 *
 * A device flow with Kilo Code's own wire shape: the start returns a single code that is both the
 * device code and the user code, and the poll reports `202` (waiting), `403` (denied), `410`
 * (expired) or `200` with an approved token.
 */

const sessionIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
const defaultTtlMs = 10 * 60_000;

export type KiloCodeSessionStatus = {
  status: 'pending' | 'connected' | 'failed' | 'expired';
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  error?: string;
  connection?: unknown;
};

type Session = {
  id: string;
  deviceCode: string;
  userCode?: string;
  verificationUrl: string;
  expiresAt: number;
  status: KiloCodeSessionStatus['status'];
  connection?: unknown;
  error?: string;
  claimed: boolean;
  /** The connection this sign-in saves to, chosen when it starts (add-account vs repair). */
  connectionId?: string;
};

type CreateInput = { deviceCode: string; userCode: string; verificationUrl: string; connectionId?: string };

export class KiloCodeSessionStore {
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

  /** The connection this sign-in saves to, when it carries one. */
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

  publicStatus(session: Session): KiloCodeSessionStatus {
    return this.store.publicStatus(session);
  }
}

/** A single shared adapter for the sign-in flow — it holds no per-connection state. */
export function kilocodeSignInAdapter(options: KiloCodeAdapterOptions = {}) {
  return createKiloCodeAdapter(options);
}

export { kilocodeProviderId, KILOCODE };
