import { createQoderAdapter, qoderProviderId, type QoderAdapterOptions } from '@omnihilbras/sdk-qoder';
import { SignInSessionStore, type SignInSessionBase } from '../core/sign-in-sessions.js';

/**
 * Qoder sign-in.
 *
 * A custom device flow with local PKCE: the client mints a verifier, a nonce, and a machine id, sends
 * the user to `/device/selectAccounts`, and polls with the nonce and verifier until a token appears.
 * `deviceCode` on the session is the nonce; the verifier and machine id must survive to the poll.
 */

const sessionIdPattern = /^[A-Za-z0-9_-]{16,128}$/;
const defaultTtlMs = 10 * 60_000;

export type QoderSessionStatus = {
  status: 'pending' | 'connected' | 'failed' | 'expired';
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  error?: string;
  connection?: unknown;
};

type Session = {
  id: string;
  connectionId: string;
  nonce: string;
  deviceCode: string;
  userCode: string;
  codeVerifier: string;
  machineId: string;
  verificationUrl: string;
  expiresAt: number;
  status: QoderSessionStatus['status'];
  connection?: unknown;
  error?: string;
  claimed: boolean;
};

type CreateInput = { deviceCode: string; userCode: string; codeVerifier: string; machineId: string; verificationUrl: string; connectionId?: string };

export class QoderSessionStore {
  private readonly store: SignInSessionStore<Session, CreateInput>;

  constructor(options: { ttlMs?: number } = {}) {
    this.store = new SignInSessionStore<Session, CreateInput>({
      ttlMs: options.ttlMs ?? defaultTtlMs,
      isPlausibleId: (id) => sessionIdPattern.test(id),
      build: (input, { id, expiresAt }) => ({
        id,
        connectionId: input.connectionId ?? qoderProviderId,
        nonce: input.deviceCode,
        deviceCode: input.deviceCode,
        userCode: input.userCode,
        codeVerifier: input.codeVerifier,
        machineId: input.machineId,
        verificationUrl: input.verificationUrl,
        expiresAt,
        status: 'pending',
        claimed: false,
      }),
      read: (session) => ({ userCode: session.userCode, verificationUrl: session.verificationUrl }),
    });
  }

  create(input: CreateInput & { expiresIn?: number; connectionId?: string }): Session {
    return this.store.create(
      {
        deviceCode: input.deviceCode,
        userCode: input.userCode,
        codeVerifier: input.codeVerifier,
        machineId: input.machineId,
        verificationUrl: input.verificationUrl,
        connectionId: input.connectionId,
      },
      input.expiresIn,
    );
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

  resolve(id: string, patch: { status: SignInSessionBase['status']; connection?: unknown; error?: string }) {
    this.store.resolve(id, patch);
  }

  publicStatus(session: Session): QoderSessionStatus {
    return this.store.publicStatus(session);
  }
}

let signInAdapter: ReturnType<typeof createQoderAdapter> | undefined;

export function qoderSignInAdapter(transport?: QoderAdapterOptions['transport'], signRequest?: QoderAdapterOptions['signRequest']) {
  if (!signInAdapter) {
    signInAdapter = createQoderAdapter({
      ...(transport ? { transport } : {}),
      ...(signRequest ? { signRequest } : {}),
    });
  }
  return signInAdapter;
}

export { qoderProviderId };
